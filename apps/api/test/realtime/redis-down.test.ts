import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type { SeatStatus } from "@seatsync/shared";
import type { Redis } from "ioredis";
import type { Pool, QueryResultRow } from "pg";
import pino from "pino";
import request from "supertest";
import { loadConfig, type Config } from "../../src/config";
import { createPool } from "../../src/db/pool";
import { createRedisClient } from "../../src/realtime/redis";
import { truncateAll } from "../helpers/db";
import {
  TestSocket,
  WAITER_TIMEOUT_MS,
  bootTestApp,
  createPublishedEvent,
  holdSeats,
  isRecord,
  isSeatUpdateFrame,
  seedAttendees,
  signupUser,
  type TestHarness,
} from "./helpers";

/**
 * `design.md:341` and design §60-69 — Redis is never required for correctness.
 *
 * The outage is simulated without Docker by booting a SECOND app whose
 * publisher/subscriber point at a closed TCP port. Their ioredis clients sit in
 * retry backoff exactly as they would against a stopped Redis, while Postgres
 * stays real. The acceptance check then proves:
 *
 *   1. `POST /events/:id/holds` still returns 201 and the Sprint 2 race still
 *      produces exactly one 201, N-1 409s and one HELD row (no request path
 *      awaits Redis);
 *   2. every failed publish/reconnect is handled (no unhandled rejection and
 *      the process keeps serving);
 *   3. on the real-Redis instance, stopping then restarting the publisher and
 *      subscriber (simulated recovery) makes live messages flow again.
 *
 * No fixed sleeps: waiters resolve on frames/events, and the rest of the Redis
 * outage is observed by the holds' own responses.
 */

const RACE_USERS = 50;
const RACE_TEST_TIMEOUT_MS = 120_000;

interface SeatStateRow extends QueryResultRow {
  id: string;
  status: SeatStatus;
  hold_id: string | null;
  held_by: string | null;
  version: number;
}

interface StatusCountRow extends QueryResultRow {
  status_code: number;
  count: number;
}

/** Reserve an ephemeral port, then close it: nothing listens there afterwards. */
async function findClosedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("Expected an ephemeral TCP port"));
        return;
      }

      resolve(address.port);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  return port;
}

/** Drain one macrotask turn so any unhandled rejection has been emitted. */
async function drainEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function requireSeatRow(rows: SeatStateRow[], seatId: string): SeatStateRow {
  const row = rows.find((candidate) => candidate.id === seatId);

  if (row === undefined) {
    throw new Error(`Seat ${seatId} is missing from the database`);
  }

  return row;
}

describe("realtime with Redis down", () => {
  const log = pino({ level: "silent" });

  let config: Config;
  let pool: Pool;
  let redis: Redis;
  let harness: TestHarness;
  let offline: TestHarness;
  let unhandledRejections: unknown[] = [];

  function onUnhandledRejection(reason: unknown): void {
    unhandledRejections.push(reason);
  }

  beforeAll(async () => {
    config = loadConfig(process.env);
    // Sized for the 50-user concurrent race (DB_POOL_SIZE defaults to 20).
    pool = createPool({ ...config, DB_POOL_SIZE: RACE_USERS + 10 });
    redis = createRedisClient(config);

    harness = await bootTestApp({ config, pool, redis, log });

    const closedPort = await findClosedPort();
    const offlineConfig: Config = {
      ...config,
      REDIS_URL: `redis://127.0.0.1:${closedPort}`,
    };

    offline = await bootTestApp({
      config,
      pool,
      redis,
      log,
      pubSubConfig: offlineConfig,
      awaitPubSubReady: false,
    });

    process.on("unhandledRejection", onUnhandledRejection);
  });

  beforeEach(async () => {
    unhandledRejections = [];
    await truncateAll(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    process.off("unhandledRejection", onUnhandledRejection);
    await offline.close();
    await harness.close();
    redis.disconnect();
    await pool.end();
  });

  it(
    "returns 201 and preserves the Sprint 2 race semantics while pub/sub Redis is unreachable",
    async () => {
      const offlinePublisher = offline.publisher;
      const offlineSubscriber = offline.subscriber;

      if (offlinePublisher === null || offlineSubscriber === null) {
        throw new Error("The offline instance must have pub/sub handles");
      }

      // Both connections failed to reach the closed port and are retrying in
      // the background. Awaiting the rejections is event-driven and proves the
      // outage is real before the race starts.
      await expect(offlinePublisher.ready).rejects.toThrow(/not ready/);
      await expect(offlineSubscriber.ready).rejects.toThrow(/not ready/);

      const organizer = await signupUser(offline.app, "ORGANIZER");
      const event = await createPublishedEvent(
        offline.app,
        organizer.accessToken,
        2,
      );

      const [targetSeat, otherSeat] = event.seats;

      if (targetSeat === undefined || otherSeat === undefined) {
        throw new Error("Expected two seats");
      }

      const attendees = await seedAttendees(pool, config, RACE_USERS);
      const idempotencyKeys = attendees.map(() => randomUUID());

      expect(new Set(idempotencyKeys).size).toBe(RACE_USERS);

      const responses = await Promise.all(
        attendees.map((attendee, index) =>
          holdSeats(
            offline.app,
            attendee.accessToken,
            event.id,
            [targetSeat.id],
            idempotencyKeys[index],
          ),
        ),
      );

      expect(responses).toHaveLength(RACE_USERS);

      const successes = responses.filter((response) => response.status === 201);
      const conflicts = responses.filter((response) => response.status === 409);

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(RACE_USERS - 1);
      expect(
        responses.filter(
          (response) => response.status !== 201 && response.status !== 409,
        ),
      ).toHaveLength(0);

      for (const conflict of conflicts) {
        expect(conflict.body).toEqual({
          error: {
            code: "SEATS_UNAVAILABLE",
            message: "One or more seats are no longer available",
            details: { seatIds: [targetSeat.id] },
          },
        });
      }

      const winnerIndex = responses.findIndex(
        (response) => response.status === 201,
      );
      const winner = successes[0];
      const winnerUser = attendees[winnerIndex];

      if (winner === undefined || winnerUser === undefined) {
        throw new Error("Expected exactly one winning user");
      }

      expect(winner.body.seatIds).toEqual([targetSeat.id]);

      const seats = await pool.query<SeatStateRow>(
        `SELECT id, status, hold_id, held_by, version
           FROM seats
          WHERE event_id = $1`,
        [event.id],
      );

      const targetRow = requireSeatRow(seats.rows, targetSeat.id);

      expect(targetRow).toMatchObject({
        status: "HELD",
        hold_id: winner.body.holdId,
        held_by: winnerUser.id,
        version: 1,
      });

      expect(requireSeatRow(seats.rows, otherSeat.id)).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        version: 0,
      });

      const heldCount = await pool.query<{ count: number } & QueryResultRow>(
        `SELECT count(*)::int AS count
           FROM seats
          WHERE event_id = $1 AND status = 'HELD'`,
        [event.id],
      );

      expect(heldCount.rows[0]?.count).toBe(1);

      // D2: every outcome, including the 49 conflicts, is stored.
      const keysByStatus = await pool.query<StatusCountRow>(
        `SELECT status_code, count(*)::int AS count
           FROM idempotency_keys
          GROUP BY status_code
          ORDER BY status_code`,
      );

      expect(keysByStatus.rows).toEqual([
        { status_code: 201, count: 1 },
        { status_code: 409, count: RACE_USERS - 1 },
      ]);

      // The process is alive and serving despite its pub/sub clients being in
      // reconnect backoff; Postgres (and the shared Redis health client) are up.
      const health = await request(offline.app).get("/health");

      expect(health.status).toBe(200);

      await drainEventLoop();
      expect(unhandledRejections).toEqual([]);
    },
    RACE_TEST_TIMEOUT_MS,
  );

  it(
    "resumes live updates after the publisher/subscriber recover",
    async () => {
      const organizer = await signupUser(harness.app, "ORGANIZER");
      const missedHolder = await signupUser(harness.app, "ATTENDEE");
      const resumedHolder = await signupUser(harness.app, "ATTENDEE");
      const event = await createPublishedEvent(
        harness.app,
        organizer.accessToken,
        3,
      );

      const [missedSeat, resumedSeat] = event.seats;

      if (missedSeat === undefined || resumedSeat === undefined) {
        throw new Error("Expected at least two seats");
      }

      const client = await TestSocket.connect(harness.wsUrl);

      try {
        client.send({ type: "auth", token: resumedHolder.accessToken });
        await client.waitFor(
          (frame) => isRecord(frame) && frame.type === "auth_ok",
        );

        client.send({ type: "subscribe", eventId: event.id });
        await client.waitFor(
          (frame) =>
            isRecord(frame) &&
            frame.type === "subscribed" &&
            frame.eventId === event.id
        );

        const publisher = harness.publisher;
        const subscriber = harness.subscriber;

        if (publisher === null || subscriber === null) {
          throw new Error("The real-Redis instance must have pub/sub handles");
        }

        // Simulated outage: stop the live publisher/subscriber (the WS client
        // stays connected and subscribed; only the Redis path is gone).
        await publisher.stop();
        await subscriber.stop();

        const missed = await holdSeats(
          harness.app,
          missedHolder.accessToken,
          event.id,
          [missedSeat.id],
        );

        expect(missed.status).toBe(201);

        // Simulated recovery: restart both connections and await readiness.
        await harness.restartPubSub();

        const resumed = await holdSeats(
          harness.app,
          resumedHolder.accessToken,
          event.id,
          [resumedSeat.id],
        );

        expect(resumed.status).toBe(201);

        // `waitFor` itself bounds the wait at WAITER_TIMEOUT_MS. The strict
        // LIVE_UPDATE_MAX_MS threshold is asserted in live.test.ts; this suite's
        // acceptance is that messages resume at all after the outage.
        const message = await client.waitFor(isSeatUpdateFrame);

        expect(message.frame).toEqual({
          eventId: event.id,
          seats: [{ id: resumedSeat.id, status: "HELD", version: 1 }],
        });

        // The change made while the publisher was stopped was never delivered.
        expect(client.frames.filter(isSeatUpdateFrame)).toHaveLength(1);

        const seats = await pool.query<SeatStateRow>(
          `SELECT id, status, hold_id, held_by, version
             FROM seats
            WHERE event_id = $1`,
          [event.id],
        );

        expect(requireSeatRow(seats.rows, missedSeat.id)).toMatchObject({
          status: "HELD",
          version: 1,
        });
        expect(requireSeatRow(seats.rows, resumedSeat.id)).toMatchObject({
          status: "HELD",
          version: 1,
        });

        const health = await request(harness.app).get("/health");

        expect(health.status).toBe(200);

        await drainEventLoop();
        expect(unhandledRejections).toEqual([]);
      } finally {
        await client.close();
      }
    },
    WAITER_TIMEOUT_MS * 6,
  );
});
