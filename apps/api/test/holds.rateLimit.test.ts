import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type { CreateEventRequest, SeatStatus, UserRole } from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool, QueryResultRow } from "pg";
import pino from "pino";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import {
  createHoldsRateLimiter,
  holdsRateLimitKey,
  type HoldsRateLimiter,
} from "../src/middleware/rateLimit";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

/**
 * D33 / design §362 — per-user, fail-open Redis rate limit on
 * `POST /events/:id/holds`.
 *
 * The limit is set to 2/minute through the real config override pattern, so no
 * test needs to hammer 20 requests. The suite runs against the real compose
 * Postgres and Redis (Rule 2) with the fake payment provider forced, like every
 * other automated suite (D19). The 429 must be produced only by the limiter's
 * `ApiError`, before any idempotency or database work, and Redis failures must
 * always allow the request through.
 */

const PASSWORD = "password123";
const SEAT_COUNT = 3;
const LIMIT_PER_MINUTE = 2;
const TEST_TIMEOUT_MS = 30_000;

interface SeatStateRow extends QueryResultRow {
  id: string;
  status: SeatStatus;
  hold_id: string | null;
  held_by: string | null;
  version: number;
}

interface CountRow extends QueryResultRow {
  count: number;
}

function requireRow<T>(rows: T[]): T {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Expected at least one database row");
  }

  return row;
}

function requireSeat(rows: SeatStateRow[], seatId: string): SeatStateRow {
  const row = rows.find((candidate) => candidate.id === seatId);

  if (row === undefined) {
    throw new Error(`Seat ${seatId} is missing from the database`);
  }

  return row;
}

/**
 * The limiter connects lazily in the background. Counting assertions need the
 * connection to be usable before the first hold, so wait for the real `ready`
 * event (bounded, no fixed sleep).
 */
async function waitForReady(client: Redis): Promise<void> {
  if (client.status === "ready") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      reject(
        new Error(
          `limiter Redis did not become ready (status ${client.status})`,
        ),
      );
    }, 10_000);

    function onReady(): void {
      clearTimeout(timer);
      resolve();
    }

    client.once("ready", onReady);
  });
}

/**
 * Disconnect the limiter connection and wait for ioredis to report the close.
 * `disconnect()` ends the socket asynchronously; asserting or issuing the next
 * request before the `close` event would still see a writable stream.
 */
async function disconnectAndWait(client: Redis): Promise<void> {
  if (client.status !== "ready") {
    return;
  }

  await new Promise<void>((resolve) => {
    client.once("close", () => resolve());
    client.disconnect();
  });
}

describe("holds rate limit", () => {
  let config: Config;
  let pool: Pool;
  let redis: Redis;
  let app: Express;
  let limiter: HoldsRateLimiter;

  beforeAll(() => {
    config = loadConfig({
      ...process.env,
      PAYMENT_PROVIDER: "fake",
      HOLDS_RATE_LIMIT_PER_MINUTE: String(LIMIT_PER_MINUTE),
    });
    pool = createPool(config);
    redis = createRedisClient(config);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    limiter = createHoldsRateLimiter({
      config,
      logger: pino({ level: "silent" }),
    });
    await waitForReady(limiter.client);
    app = createApp({ pool, redis, config, holdsRateLimiter: limiter });
  });

  afterEach(async () => {
    await limiter.close();
    await truncateAll(pool);
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  async function signupUser(
    role: UserRole,
  ): Promise<{ id: string; email: string; accessToken: string }> {
    const email = `holds-rate-limit-${randomUUID()}@seatsync.local`;
    const response = await request(app)
      .post("/auth/signup")
      .send({ email, password: PASSWORD, role });

    expect(response.status).toBe(201);

    return {
      id: response.body.user.id,
      email,
      accessToken: response.body.accessToken,
    };
  }

  function eventPayload(): CreateEventRequest {
    return {
      title: "Rate limit night",
      venue: "Main hall",
      startsAt: "2027-09-05T18:00:00.000Z",
      sections: [
        { name: "Floor", rows: 1, seatsPerRow: SEAT_COUNT, pricePaise: 2500 },
      ],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
  ): Promise<{ id: string; seats: Array<{ id: string; number: number }> }> {
    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(eventPayload());

    expect(created.status).toBe(201);

    const published = await request(app)
      .post(`/events/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(published.status).toBe(200);

    return {
      id: created.body.id,
      seats: created.body.seats as Array<{ id: string; number: number }>,
    };
  }

  function hold(
    accessToken: string,
    eventId: string,
    seatIds: string[],
    idempotencyKey: string = randomUUID(),
  ) {
    return request(app)
      .post(`/events/${eventId}/holds`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({ seatIds });
  }

  async function readSeats(eventId: string): Promise<SeatStateRow[]> {
    const result = await pool.query<SeatStateRow>(
      `SELECT id, status, hold_id, held_by, version
         FROM seats
        WHERE event_id = $1
        ORDER BY number`,
      [eventId],
    );

    return result.rows;
  }

  async function countKeysForUser(userId: string): Promise<number> {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::int AS count
         FROM idempotency_keys
        WHERE user_id = $1`,
      [userId],
    );

    return requireRow(result.rows).count;
  }

  /** Every limiter key currently held for one user in the real Redis. */
  async function limiterKeysForUser(userId: string): Promise<string[]> {
    return limiter.client.keys(`holds:rl:${userId}:*`);
  }

  it("derives a fixed 60 s window key from the authenticated user id", () => {
    // Pure seam assertion: no clock, no waiting. 59 999 ms stays in minute 0;
    // the next millisecond starts minute 1.
    expect(holdsRateLimitKey("user-1", 0)).toBe("holds:rl:user-1:0");
    expect(holdsRateLimitKey("user-1", 59_999)).toBe("holds:rl:user-1:0");
    expect(holdsRateLimitKey("user-1", 60_000)).toBe("holds:rl:user-1:1");
  });

  it(
    "counts every authenticated attempt and returns an ApiError 429 without touching Postgres",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const attendee = await signupUser("ATTENDEE");
      const event = await createPublishedEvent(organizer.accessToken);
      const [seat1, seat2, seat3] = event.seats;

      if (
        seat1 === undefined ||
        seat2 === undefined ||
        seat3 === undefined
      ) {
        throw new Error("Expected three seats");
      }

      // Attempt 1: a normal 201.
      const first = await hold(
        attendee.accessToken,
        event.id,
        [seat1.id],
        randomUUID(),
      );

      expect(first.status).toBe(201);

      // Attempt 2 is a 409 (D8 second active hold for the same event) and is
      // still counted: the limiter runs before idempotency and validation.
      const second = await hold(
        attendee.accessToken,
        event.id,
        [seat2.id],
        randomUUID(),
      );

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe("SEATS_UNAVAILABLE");

      // Attempt 3 crosses the limit of 2 and is rejected by the limiter.
      const thirdKey = randomUUID();
      const third = await hold(
        attendee.accessToken,
        event.id,
        [seat3.id],
        thirdKey,
      );

      expect(third.status).toBe(429);
      expect(third.body).toEqual({
        error: {
          code: "RATE_LIMITED",
          message: expect.any(String),
          details: { limit: LIMIT_PER_MINUTE, windowSeconds: 60 },
        },
      });

      // A 429 wrote no idempotency row: only the 201 and the 409 are stored.
      expect(await countKeysForUser(attendee.id)).toBe(2);

      const rejectedKeys = await pool.query<CountRow>(
        `SELECT count(*)::int AS count
           FROM idempotency_keys
          WHERE key = ANY($1::text[])`,
        [[thirdKey]],
      );

      expect(requireRow(rejectedKeys.rows).count).toBe(0);

      // The 429 did not touch seats either: only attempt 1 changed one row.
      const afterThird = await readSeats(event.id);

      expect(requireSeat(afterThird, seat1.id)).toMatchObject({
        status: "HELD",
        held_by: attendee.id,
        version: 1,
      });
      expect(requireSeat(afterThird, seat2.id)).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        version: 0,
      });
      expect(requireSeat(afterThird, seat3.id)).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        version: 0,
      });

      // A 4th attempt in the same window is also 429 and still writes nothing.
      const fourthKey = randomUUID();
      const fourth = await hold(
        attendee.accessToken,
        event.id,
        [seat3.id],
        fourthKey,
      );

      expect(fourth.status).toBe(429);
      expect(fourth.body.error.code).toBe("RATE_LIMITED");
      expect(await countKeysForUser(attendee.id)).toBe(2);

      const neverStored = await pool.query<CountRow>(
        `SELECT count(*)::int AS count
           FROM idempotency_keys
          WHERE key = ANY($1::text[])`,
        [[fourthKey]],
      );

      expect(requireRow(neverStored.rows).count).toBe(0);

      // One real Redis counter for the user with a live 60 s TTL; the Lua
      // script set the expiry on the first hit.
      const keys = await limiterKeysForUser(attendee.id);

      expect(keys).toHaveLength(1);

      const counterKey = keys[0];

      if (counterKey === undefined) {
        throw new Error("Expected one limiter key");
      }

      expect(counterKey).toMatch(
        new RegExp(`^holds:rl:${attendee.id}:\\d+$`),
      );
      expect(await limiter.client.get(counterKey)).toBe("4");
      expect(await limiter.client.ttl(counterKey)).toBeGreaterThan(0);

      const afterFourth = await readSeats(event.id);

      expect(requireSeat(afterFourth, seat1.id)).toMatchObject({
        status: "HELD",
        version: 1,
      });
      expect(requireSeat(afterFourth, seat2.id)).toMatchObject({
        status: "AVAILABLE",
        version: 0,
      });
      expect(requireSeat(afterFourth, seat3.id)).toMatchObject({
        status: "AVAILABLE",
        version: 0,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps users isolated: user B holds while user A is rate-limited",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const userA = await signupUser("ATTENDEE");
      const userB = await signupUser("ATTENDEE");
      const event = await createPublishedEvent(organizer.accessToken);
      const [seat1, seat2, seat3] = event.seats;

      if (
        seat1 === undefined ||
        seat2 === undefined ||
        seat3 === undefined
      ) {
        throw new Error("Expected three seats");
      }

      expect(
        (
          await hold(userA.accessToken, event.id, [seat1.id], randomUUID())
        ).status,
      ).toBe(201);
      expect(
        (
          await hold(userA.accessToken, event.id, [seat2.id], randomUUID())
        ).status,
      ).toBe(409);

      const limitedA = await hold(
        userA.accessToken,
        event.id,
        [seat3.id],
        randomUUID(),
      );

      expect(limitedA.status).toBe(429);

      // B's first attempt is independent of A's exhausted window.
      const holdB = await hold(
        userB.accessToken,
        event.id,
        [seat2.id],
        randomUUID(),
      );

      expect(holdB.status).toBe(201);
      expect(holdB.body.seatIds).toEqual([seat2.id]);

      // B's second attempt is counted against B (and is a 409, not a 429).
      const secondB = await hold(
        userB.accessToken,
        event.id,
        [seat3.id],
        randomUUID(),
      );

      expect(secondB.status).toBe(409);
      expect(secondB.body.error.code).toBe("SEATS_UNAVAILABLE");

      // A stays limited; B's counter is separate.
      const stillLimitedA = await hold(
        userA.accessToken,
        event.id,
        [seat3.id],
        randomUUID(),
      );

      expect(stillLimitedA.status).toBe(429);

      const [keysA, keysB] = await Promise.all([
        limiterKeysForUser(userA.id),
        limiterKeysForUser(userB.id),
      ]);

      expect(keysA).toHaveLength(1);
      expect(keysB).toHaveLength(1);
      expect(keysA[0]).not.toBe(keysB[0]);
      expect(await limiter.client.get(keysA[0] ?? "")).toBe("4");
      expect(await limiter.client.get(keysB[0] ?? "")).toBe("2");

      const seat2Row = requireSeat(await readSeats(event.id), seat2.id);

      expect(seat2Row).toMatchObject({
        status: "HELD",
        held_by: userB.id,
        version: 1,
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails open when the limiter's Redis client is unavailable",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const attendee = await signupUser("ATTENDEE");
      const event = await createPublishedEvent(organizer.accessToken);
      const [seat1, seat2] = event.seats;

      if (seat1 === undefined || seat2 === undefined) {
        throw new Error("Expected at least two seats");
      }

      expect(
        (
          await hold(attendee.accessToken, event.id, [seat1.id], randomUUID())
        ).status,
      ).toBe(201);
      expect(
        (
          await hold(attendee.accessToken, event.id, [seat2.id], randomUUID())
        ).status,
      ).toBe(409);

      const limited = await hold(
        attendee.accessToken,
        event.id,
        [seat2.id],
        randomUUID(),
      );

      expect(limited.status).toBe(429);

      // Simulate a Redis outage: the dedicated limiter connection is gone.
      await disconnectAndWait(limiter.client);
      expect(limiter.client.status).not.toBe("ready");

      const afterOutage = await hold(
        attendee.accessToken,
        event.id,
        [seat2.id],
        randomUUID(),
      );

      // Fail-open: the request runs normally and hits the D8 second-hold guard
      // (409), never the limiter's 429.
      expect(afterOutage.status).toBe(409);
      expect(afterOutage.body.error.code).toBe("SEATS_UNAVAILABLE");

      // The request completed the whole normal path: its 409 was stored.
      expect(await countKeysForUser(attendee.id)).toBe(3);

      // The shared health client is untouched by the limiter's outage.
      const health = await request(app).get("/health");

      expect(health.status).toBe(200);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "lifts the limit in the next window after the epoch-minute key is cleared",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const attendee = await signupUser("ATTENDEE");
      const event = await createPublishedEvent(organizer.accessToken);
      const [seat1, seat2, seat3] = event.seats;

      if (
        seat1 === undefined ||
        seat2 === undefined ||
        seat3 === undefined
      ) {
        throw new Error("Expected three seats");
      }

      expect(
        (
          await hold(attendee.accessToken, event.id, [seat1.id], randomUUID())
        ).status,
      ).toBe(201);
      expect(
        (
          await hold(attendee.accessToken, event.id, [seat2.id], randomUUID())
        ).status,
      ).toBe(409);

      const limited = await hold(
        attendee.accessToken,
        event.id,
        [seat3.id],
        randomUUID(),
      );

      expect(limited.status).toBe(429);

      const keys = await limiterKeysForUser(attendee.id);

      expect(keys).toHaveLength(1);

      // Simulate the 60 s window rolling over. Rule 68 forbids waiting on real
      // time, and the key is derived purely from the user id and the UTC epoch
      // minute, so deleting the current key is exactly what the next minute's
      // key does naturally: a fresh INCR starts at 1.
      await limiter.client.del(...keys);

      const nextWindow = await hold(
        attendee.accessToken,
        event.id,
        [seat3.id],
        randomUUID(),
      );

      // Allowed through the limiter; the normal D8 guard answers 409.
      expect(nextWindow.status).toBe(409);
      expect(nextWindow.body.error.code).toBe("SEATS_UNAVAILABLE");

      const freshKeys = await limiterKeysForUser(attendee.id);

      expect(freshKeys).toHaveLength(1);

      const freshKey = freshKeys[0];

      if (freshKey === undefined) {
        throw new Error("Expected one limiter key after the window reset");
      }

      expect(await limiter.client.get(freshKey)).toBe("1");
      expect(await limiter.client.ttl(freshKey)).toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});
