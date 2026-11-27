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
 * `design.md:279` — overlapping multi-seat holds.
 *
 * User A asks for [s1, s2] and user B for [s2, s3] at the same time. Rule 1's
 * deterministic lock order must make exactly one request win; the loser's
 * transaction must roll back completely, leaving none of its seats HELD — in
 * particular its non-overlapping seat must not be left half-held.
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

interface StatusCountRow extends QueryResultRow {
  status_code: number;
  count: number;
}

function requireRow<T>(rows: T[]): T {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Expected at least one database row");
  }

  return row;
}

function requireSeatByNumber(rows: SeatStateRow[], number: number): SeatStateRow {
  const row = rows.find((candidate) => candidate.number === number);

  if (row === undefined) {
    throw new Error(`Seat number ${number} is missing`);
  }

  return row;
}

describe("holds overlap", () => {
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
    const email = `holds-overlap-${randomUUID()}@seatsync.local`;
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
      title: "Overlap night",
      venue: "Main hall",
      startsAt: "2027-09-02T18:00:00.000Z",
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
  ) {
    return request(app)
      .post(`/events/${eventId}/holds`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", randomUUID())
      .send({ seatIds });
  }

  it(
    "serializes overlapping holds so exactly one wins and the loser leaves no seat HELD",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const userA = await signupUser("ATTENDEE");
      const userB = await signupUser("ATTENDEE");
      const event = await createPublishedEvent(organizer.accessToken);

      expect(event.seats.map((seat) => seat.number)).toEqual([1, 2, 3]);

      const s1 = event.seats[0];
      const s2 = event.seats[1];
      const s3 = event.seats[2];

      if (s1 === undefined || s2 === undefined || s3 === undefined) {
        throw new Error("Expected exactly three seats");
      }

      const [responseA, responseB] = await Promise.all([
        hold(userA.accessToken, event.id, [s1.id, s2.id]),
        hold(userB.accessToken, event.id, [s2.id, s3.id]),
      ]);

      expect([responseA.status, responseB.status].sort((left, right) => left - right)).toEqual([
        201, 409,
      ]);

      const aWon = responseA.status === 201;
      const winner = aWon ? responseA : responseB;
      const loser = aWon ? responseB : responseA;
      const winnerUser = aWon ? userA : userB;
      const winnerSeatNumbers = aWon ? [1, 2] : [2, 3];
      const loserOnlySeatNumber = aWon ? 3 : 1;

      expect(winner.body.holdId).toEqual(expect.any(String));
      expect(winner.body.seatIds).toEqual(aWon ? [s1.id, s2.id] : [s2.id, s3.id]);

      // The 409 names only the contested seat; the loser's other seat is free.
      expect(loser.body).toEqual({
        error: {
          code: "SEATS_UNAVAILABLE",
          message: "One or more seats are no longer available",
          details: { seatIds: [s2.id] },
        },
      });
      expect(loser.body.error.details.seatIds).not.toContain(
        loserOnlySeatNumber === 3 ? s3.id : s1.id,
      );

      const states = await pool.query<SeatStateRow>(
        `SELECT id, number, status, hold_id, held_by, held_until, version
           FROM seats
          WHERE event_id = $1
          ORDER BY number`,
        [event.id],
      );

      expect(states.rows).toHaveLength(SEAT_COUNT);

      // Winner seats: HELD by the winner's hold, version bumped by exactly one.
      for (const number of winnerSeatNumbers) {
        const row = requireSeatByNumber(states.rows, number);

        expect(row.status).toBe("HELD");
        expect(row.hold_id).toBe(winner.body.holdId);
        expect(row.held_by).toBe(winnerUser.id);
        expect(row.held_until?.toISOString()).toBe(winner.body.heldUntil);
        expect(row.version).toBe(1);
      }

      // The loser's non-overlapping seat was rolled back: never HELD, never
      // carrying any hold id, and with its version untouched.
      const loserOnlySeat = requireSeatByNumber(states.rows, loserOnlySeatNumber);

      expect(loserOnlySeat).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        held_until: null,
        version: 0,
      });

      // No seat anywhere carries a hold other than the winner's.
      const heldSeats = states.rows.filter((row) => row.status === "HELD");

      expect(heldSeats).toHaveLength(2);
      expect(heldSeats.map((row) => row.hold_id)).toEqual([
        winner.body.holdId,
        winner.body.holdId,
      ]);
      expect(states.rows.filter((row) => row.version !== 0 && row.version !== 1)).toHaveLength(0);

      // Both outcomes are stored for idempotent replay (D2).
      const stored = await pool.query<StatusCountRow>(
        `SELECT status_code, count(*)::int AS count
           FROM idempotency_keys
          GROUP BY status_code
          ORDER BY status_code`,
      );

      expect(stored.rows).toEqual([
        { status_code: 201, count: 1 },
        { status_code: 409, count: 1 },
      ]);
      expect(requireRow(stored.rows).count).toBe(1);
    },
    30_000,
  );
});
