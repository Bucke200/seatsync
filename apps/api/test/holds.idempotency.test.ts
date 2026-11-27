import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { CreateEventRequest, SeatStatus, UserRole } from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool, QueryResultRow } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

/**
 * `design.md:281` and D2/D13 — idempotent hold retries.
 *
 * The `Idempotency-Key` row and the seat change commit atomically, so a replay
 * is byte-identical to the first response and never creates a second hold.
 * A reused key with a different body or user is a 422. Two concurrent requests
 * with one key serialize on the unique index (never check-then-insert) and both
 * observe the same stored outcome. Both 201 and 409 outcomes are stored and
 * replayed verbatim from JSONB.
 */

const PASSWORD = "password123";
const SEAT_COUNT = 3;

interface SeatStateRow extends QueryResultRow {
  id: string;
  number: number;
  status: SeatStatus;
  hold_id: string | null;
  held_by: string | null;
  held_until: Date | null;
  version: number;
}

interface IdempotencyRow extends QueryResultRow {
  key: string;
  user_id: string;
  status_code: number;
  response: unknown;
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

function requireSeat(rows: SeatStateRow[], number: number): SeatStateRow {
  const row = rows.find((candidate) => candidate.number === number);

  if (row === undefined) {
    throw new Error(`Seat number ${number} is missing`);
  }

  return row;
}

describe("holds idempotency", () => {
  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;

  beforeAll(() => {
    config = loadConfig(process.env);
    pool = createPool(config);
    redis = createRedisClient(config);
    app = createApp({ pool, redis, config });
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  async function signupUser(
    role: UserRole,
  ): Promise<{ id: string; email: string; accessToken: string }> {
    const email = `holds-idempotency-${randomUUID()}@seatsync.local`;
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
      title: "Idempotency night",
      venue: "Main hall",
      startsAt: "2027-09-04T18:00:00.000Z",
      sections: [{ name: "Floor", rows: 1, seatsPerRow: SEAT_COUNT, pricePaise: 2500 }],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
  ): Promise<{ id: string; seats: Array<{ id: string; number: number; status: SeatStatus }> }> {
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
      seats: created.body.seats as Array<{ id: string; number: number; status: SeatStatus }>,
    };
  }

  function hold(
    accessToken: string,
    eventId: string,
    seatIds: string[],
    idempotencyKey: string,
  ) {
    return request(app)
      .post(`/events/${eventId}/holds`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({ seatIds });
  }

  async function readSeats(eventId: string): Promise<SeatStateRow[]> {
    const result = await pool.query<SeatStateRow>(
      `SELECT id, number, status, hold_id, held_by, held_until, version
         FROM seats
        WHERE event_id = $1
        ORDER BY number`,
      [eventId],
    );

    return result.rows;
  }

  async function countIdempotencyKeys(): Promise<number> {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::int AS count FROM idempotency_keys`,
    );

    return requireRow(result.rows).count;
  }

  function sortedIds(seatIds: string[]): string[] {
    return [...seatIds].sort();
  }

  it("replays the same key and body with a byte-identical 201 and one hold", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const seatIds = event.seats.map((seat) => seat.id);

    expect(seatIds).toHaveLength(SEAT_COUNT);
    // Keep s3 free so a different key could still hold it.
    const heldSeatIds = seatIds.slice(0, 2);

    if (heldSeatIds[0] === undefined || heldSeatIds[1] === undefined) {
      throw new Error("Expected two seats");
    }

    const key = randomUUID();
    const first = await hold(attendee.accessToken, event.id, heldSeatIds, key);

    expect(first.status).toBe(201);
    expect(sortedIds(first.body.seatIds as string[])).toEqual(sortedIds(heldSeatIds));
    expect(first.body.holdId).toEqual(expect.any(String));

    // The same set in a different request order is the same canonical body
    // (D2 sorts the seat ids before hashing), so it must replay.
    const second = await hold(
      attendee.accessToken,
      event.id,
      [heldSeatIds[1], heldSeatIds[0]],
      key,
    );

    expect(second.status).toBe(201);
    expect(second.text).toBe(first.text);
    expect(second.body).toEqual(first.body);

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "HELD",
      hold_id: first.body.holdId,
      held_by: attendee.id,
      version: 1,
    });
    expect(requireSeat(seats, 2)).toMatchObject({
      status: "HELD",
      hold_id: first.body.holdId,
      held_by: attendee.id,
      version: 1,
    });
    expect(requireSeat(seats, 3)).toMatchObject({
      status: "AVAILABLE",
      hold_id: null,
      held_by: null,
      held_until: null,
      version: 0,
    });

    const heldSeats = seats.filter((seat) => seat.status === "HELD");

    expect(heldSeats).toHaveLength(2);
    expect([...new Set(heldSeats.map((seat) => seat.hold_id))]).toEqual([first.body.holdId]);

    const stored = await pool.query<IdempotencyRow>(
      `SELECT key, user_id, status_code, response
         FROM idempotency_keys
        WHERE key = $1`,
      [key],
    );
    const storedRow = requireRow(stored.rows);

    expect(stored.rows).toHaveLength(1);
    expect(storedRow.user_id).toBe(attendee.id);
    expect(storedRow.status_code).toBe(201);
    expect(storedRow.response).toEqual(first.body);
    expect(await countIdempotencyKeys()).toBe(1);
  });

  it("rejects the same key with a different body using 422 and stores no new hold", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1, s2] = event.seats;

    if (s1 === undefined || s2 === undefined) {
      throw new Error("Expected at least two seats");
    }

    const key = randomUUID();
    const first = await hold(attendee.accessToken, event.id, [s1.id], key);

    expect(first.status).toBe(201);

    const differentBody = await hold(attendee.accessToken, event.id, [s1.id, s2.id], key);

    expect(differentBody.status).toBe(422);
    expect(differentBody.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Idempotency-Key was already used with a different request",
      },
    });

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "HELD",
      hold_id: first.body.holdId,
      held_by: attendee.id,
      version: 1,
    });
    expect(requireSeat(seats, 2)).toMatchObject({
      status: "AVAILABLE",
      hold_id: null,
      held_by: null,
      held_until: null,
      version: 0,
    });
    expect(await countIdempotencyKeys()).toBe(1);

    const stored = await pool.query<IdempotencyRow>(
      `SELECT key, user_id, status_code, response
         FROM idempotency_keys
        WHERE key = $1`,
      [key],
    );

    expect(requireRow(stored.rows)).toMatchObject({
      key,
      user_id: attendee.id,
      status_code: 201,
      response: first.body,
    });
  });

  it("rejects the same key from a different user using 422", async () => {
    const organizer = await signupUser("ORGANIZER");
    const userA = await signupUser("ATTENDEE");
    const userB = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1] = event.seats;

    if (s1 === undefined) {
      throw new Error("Expected a seat");
    }

    const key = randomUUID();
    const first = await hold(userA.accessToken, event.id, [s1.id], key);

    expect(first.status).toBe(201);

    const stolenKey = await hold(userB.accessToken, event.id, [s1.id], key);

    expect(stolenKey.status).toBe(422);
    expect(stolenKey.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Idempotency-Key was already used with a different request",
      },
    });

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "HELD",
      hold_id: first.body.holdId,
      held_by: userA.id,
      version: 1,
    });
    expect(await countIdempotencyKeys()).toBe(1);

    const stored = await pool.query<IdempotencyRow>(
      `SELECT key, user_id, status_code, response
         FROM idempotency_keys
        WHERE key = $1`,
      [key],
    );
    const storedRow = requireRow(stored.rows);

    expect(storedRow.user_id).toBe(userA.id);
    expect(storedRow.status_code).toBe(201);
    expect(storedRow.response).toEqual(first.body);
  });

  it("serializes two concurrent requests with the same key into one identical 201", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1] = event.seats;

    if (s1 === undefined) {
      throw new Error("Expected a seat");
    }

    const key = randomUUID();
    const responses = await Promise.all([
      hold(attendee.accessToken, event.id, [s1.id], key),
      hold(attendee.accessToken, event.id, [s1.id], key),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(responses[0]?.text).toBe(responses[1]?.text);
    expect(responses[0]?.body).toEqual(responses[1]?.body);

    const winner = responses[0];

    if (winner === undefined) {
      throw new Error("Expected two concurrent responses");
    }

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "HELD",
      hold_id: winner.body.holdId,
      held_by: attendee.id,
      version: 1,
    });
    expect(seats.filter((seat) => seat.status === "HELD")).toHaveLength(1);
    expect(await countIdempotencyKeys()).toBe(1);

    const stored = await pool.query<IdempotencyRow>(
      `SELECT key, user_id, status_code, response
         FROM idempotency_keys
        WHERE key = $1`,
      [key],
    );
    const storedRow = requireRow(stored.rows);

    expect(storedRow.status_code).toBe(201);
    expect(storedRow.response).toEqual(winner.body);
  });

  it(
    "replays a stored 409 verbatim even after the contested seat becomes free",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const userA = await signupUser("ATTENDEE");
      const userB = await signupUser("ATTENDEE");
      const event = await createPublishedEvent(organizer.accessToken);

      const [s1] = event.seats;

      if (s1 === undefined) {
        throw new Error("Expected a seat");
      }

      const keyB = randomUUID();
      const holdB = await hold(userB.accessToken, event.id, [s1.id], keyB);

      expect(holdB.status).toBe(201);

      const keyA = randomUUID();
      const conflict = await hold(userA.accessToken, event.id, [s1.id], keyA);

      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({
        error: {
          code: "SEATS_UNAVAILABLE",
          message: "One or more seats are no longer available",
          details: { seatIds: [s1.id] },
        },
      });

      const storedBefore = await pool.query<IdempotencyRow>(
        `SELECT key, user_id, status_code, response
           FROM idempotency_keys
          WHERE key = $1`,
        [keyA],
      );
      const storedConflictBody = requireRow(storedBefore.rows).response;

      expect(requireRow(storedBefore.rows).status_code).toBe(409);
      expect(storedConflictBody).toEqual(conflict.body);

      // The holder releases the seat the conflict named, so a fresh attempt
      // would now succeed. The key must still replay the stored 409.
      const released = await request(app)
        .delete(`/holds/${holdB.body.holdId}`)
        .set("Authorization", `Bearer ${userB.accessToken}`);

      expect(released.status).toBe(204);

      const freedSeats = await readSeats(event.id);

      expect(requireSeat(freedSeats, 1)).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        held_until: null,
        version: 2,
      });

      const replay = await hold(userA.accessToken, event.id, [s1.id], keyA);

      expect(replay.status).toBe(409);
      expect(replay.body).toEqual(conflict.body);
      // JSONB normalizes key order, so compare the raw body with the stored
      // JSONB serialization Express itself would produce.
      expect(replay.text).toBe(JSON.stringify(storedConflictBody));

      const afterReplay = await readSeats(event.id);

      expect(requireSeat(afterReplay, 1)).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        held_until: null,
        version: 2,
      });

      // Proof the replay was stored: a fresh key now succeeds on the same seat.
      const fresh = await hold(userA.accessToken, event.id, [s1.id], randomUUID());

      expect(fresh.status).toBe(201);
      expect(fresh.body.holdId).not.toBe(holdB.body.holdId);

      const afterFresh = await readSeats(event.id);

      expect(requireSeat(afterFresh, 1)).toMatchObject({
        status: "HELD",
        hold_id: fresh.body.holdId,
        held_by: userA.id,
        version: 3,
      });
      expect(await countIdempotencyKeys()).toBe(3);
    },
    30_000,
  );

  it(
    "replays a stored 201 instead of a fresh 409 after another user claims the seat",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const userA = await signupUser("ATTENDEE");
      const userB = await signupUser("ATTENDEE");
      const event = await createPublishedEvent(organizer.accessToken);

      const [s1] = event.seats;

      if (s1 === undefined) {
        throw new Error("Expected a seat");
      }

      const keyA = randomUUID();
      const holdA = await hold(userA.accessToken, event.id, [s1.id], keyA);

      expect(holdA.status).toBe(201);

      // Expire A's hold directly, then let B claim the seat in between the two
      // A attempts (Rule 1's conditional UPDATE accepts the expired HELD row).
      await pool.query(
        `UPDATE seats SET held_until = '2000-01-01T00:00:00Z' WHERE id = $1`,
        [s1.id],
      );

      const holdB = await hold(userB.accessToken, event.id, [s1.id], randomUUID());

      expect(holdB.status).toBe(201);
      expect(holdB.body.holdId).not.toBe(holdA.body.holdId);

      const seatsWithB = await readSeats(event.id);

      expect(requireSeat(seatsWithB, 1)).toMatchObject({
        status: "HELD",
        hold_id: holdB.body.holdId,
        held_by: userB.id,
        version: 2,
      });

      const replay = await hold(userA.accessToken, event.id, [s1.id], keyA);

      // A fresh evaluation would be a 409 (B now owns the seat); D2 replays
      // the stored 201 byte for byte instead.
      expect(replay.status).toBe(201);
      expect(replay.text).toBe(holdA.text);
      expect(replay.body).toEqual(holdA.body);

      const seatsAfterReplay = await readSeats(event.id);

      expect(requireSeat(seatsAfterReplay, 1)).toMatchObject({
        status: "HELD",
        hold_id: holdB.body.holdId,
        held_by: userB.id,
        version: 2,
      });

      // A fresh key proves the replay was not a new hold: it conflicts with B.
      const fresh = await hold(userA.accessToken, event.id, [s1.id], randomUUID());

      expect(fresh.status).toBe(409);
      expect(fresh.body.error.code).toBe("SEATS_UNAVAILABLE");
      expect(fresh.body.error.details).toEqual({ seatIds: [s1.id] });

      expect(await countIdempotencyKeys()).toBe(3);
    },
    30_000,
  );
});
