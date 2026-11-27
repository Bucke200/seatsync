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
import { runSweeperOnce } from "../src/jobs/expireHolds";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

/**
 * `design.md:280` — expired holds (D9 + the D4 sweeper).
 *
 * Expiry is simulated only by writing an absolute past timestamp directly to
 * Postgres; the suite never waits on real time (`design.md:68`). D9 says an
 * expired-but-unswept HELD row reads as AVAILABLE, while Rule 1's conditional
 * UPDATE lets another user claim it without the sweeper. One explicit
 * `runSweeperOnce` must then release only the still-expired row.
 */

const PASSWORD = "password123";
const SEAT_COUNT = 3;
const PAST = "2000-01-01T00:00:00Z";

interface SeatStateRow extends QueryResultRow {
  id: string;
  number: number;
  status: SeatStatus;
  hold_id: string | null;
  held_by: string | null;
  held_until: Date | null;
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

describe("holds expiry", () => {
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
    const email = `holds-expiry-${randomUUID()}@seatsync.local`;
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
      title: "Expiry night",
      venue: "Main hall",
      startsAt: "2027-09-03T18:00:00.000Z",
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

  function hold(accessToken: string, eventId: string, seatIds: string[]) {
    return request(app)
      .post(`/events/${eventId}/holds`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", randomUUID())
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

  function requireSeat(rows: SeatStateRow[], number: number): SeatStateRow {
    const row = rows.find((candidate) => candidate.number === number);

    if (row === undefined) {
      throw new Error(`Seat number ${number} is missing`);
    }

    return row;
  }

  it(
    "treats expired HELD seats as AVAILABLE, lets another user claim one, and releases only the rest on one sweep",
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

      const holdA = await hold(userA.accessToken, event.id, [s1.id, s2.id]);

      expect(holdA.status).toBe(201);
      expect(holdA.body.seatIds).toEqual([s1.id, s2.id]);

      const beforeExpiry = await readSeats(event.id);

      expect(requireSeat(beforeExpiry, 1)).toMatchObject({
        status: "HELD",
        hold_id: holdA.body.holdId,
        held_by: userA.id,
        version: 1,
      });
      expect(requireSeat(beforeExpiry, 2)).toMatchObject({
        status: "HELD",
        hold_id: holdA.body.holdId,
        held_by: userA.id,
        version: 1,
      });

      // Direct-DB absolute past timestamp: no real-time waiting.
      await pool.query(
        `UPDATE seats
            SET held_until = $2::timestamptz
          WHERE id = ANY($1::uuid[])`,
        [[s1.id, s2.id], PAST],
      );

      const expired = await readSeats(event.id);

      expect(requireSeat(expired, 1).status).toBe("HELD");
      expect(requireSeat(expired, 1).held_until?.toISOString()).toBe(
        "2000-01-01T00:00:00.000Z",
      );
      expect(requireSeat(expired, 2).status).toBe("HELD");
      expect(requireSeat(expired, 2).held_until?.toISOString()).toBe(
        "2000-01-01T00:00:00.000Z",
      );

      // D9: GET /events/:id maps expired HELD rows to AVAILABLE.
      const detail = await request(app).get(`/events/${event.id}`);

      expect(detail.status).toBe(200);

      const statusById = new Map<string, SeatStatus>(
        (detail.body.seats as Array<{ id: string; status: SeatStatus }>).map((seat) => [
          seat.id,
          seat.status,
        ]),
      );

      expect(statusById.get(s1.id)).toBe("AVAILABLE");
      expect(statusById.get(s2.id)).toBe("AVAILABLE");
      expect(statusById.get(s3.id)).toBe("AVAILABLE");

      // Rule 1: the conditional UPDATE claims the expired row for B.
      const holdB = await hold(userB.accessToken, event.id, [s1.id]);

      expect(holdB.status).toBe(201);
      expect(holdB.body.seatIds).toEqual([s1.id]);
      expect(holdB.body.holdId).not.toBe(holdA.body.holdId);

      const afterClaim = await readSeats(event.id);
      const seat1 = requireSeat(afterClaim, 1);
      const seat2 = requireSeat(afterClaim, 2);
      const seat3 = requireSeat(afterClaim, 3);

      expect(seat1.status).toBe("HELD");
      expect(seat1.hold_id).toBe(holdB.body.holdId);
      expect(seat1.held_by).toBe(userB.id);
      expect(seat1.held_until?.toISOString()).toBe(holdB.body.heldUntil);
      expect(seat1.version).toBe(2);

      // s2 is still expired-HELD by A: only a sweep may release it now.
      expect(seat2.status).toBe("HELD");
      expect(seat2.hold_id).toBe(holdA.body.holdId);
      expect(seat2.held_by).toBe(userA.id);
      expect(seat2.held_until?.toISOString()).toBe("2000-01-01T00:00:00.000Z");
      expect(seat2.version).toBe(1);

      expect(seat3).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        held_until: null,
        version: 0,
      });

      const keysBeforeSweep = await pool.query<CountRow>(
        `SELECT count(*)::int AS count FROM idempotency_keys`,
      );

      expect(requireRow(keysBeforeSweep.rows).count).toBe(2);

      const summary = await runSweeperOnce(pool, config);

      // Migration 0005 creates processed_webhooks, so the sweeper now prunes it
      // (nothing to delete here) instead of skipping the absent table.
      expect(summary).toEqual({
        released: 1,
        prunedIdempotencyKeys: 0,
        prunedWebhooks: 0,
      });

      const afterSweep = await readSeats(event.id);
      const sweptSeat1 = requireSeat(afterSweep, 1);
      const sweptSeat2 = requireSeat(afterSweep, 2);

      // B's active hold is untouched.
      expect(sweptSeat1.status).toBe("HELD");
      expect(sweptSeat1.hold_id).toBe(holdB.body.holdId);
      expect(sweptSeat1.held_by).toBe(userB.id);
      expect(sweptSeat1.held_until?.toISOString()).toBe(holdB.body.heldUntil);
      expect(sweptSeat1.version).toBe(2);

      // A's expired row is released exactly once, with version bumped.
      expect(sweptSeat2).toMatchObject({
        status: "AVAILABLE",
        hold_id: null,
        held_by: null,
        held_until: null,
        version: 2,
      });

      const finalDetail = await request(app).get(`/events/${event.id}`);

      expect(finalDetail.status).toBe(200);

      const finalStatusById = new Map<string, SeatStatus>(
        (finalDetail.body.seats as Array<{ id: string; status: SeatStatus }>).map((seat) => [
          seat.id,
          seat.status,
        ]),
      );

      expect(finalStatusById.get(s1.id)).toBe("HELD");
      expect(finalStatusById.get(s2.id)).toBe("AVAILABLE");
      expect(finalStatusById.get(s3.id)).toBe("AVAILABLE");
    },
    30_000,
  );
});
