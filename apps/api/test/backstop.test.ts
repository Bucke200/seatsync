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
 * `design.md:282` — Rule 3's database backstop (`design.md:176-182`).
 *
 * These rows are inserted with raw SQL on purpose: the point is that Postgres
 * refuses a second CONFIRMED booking for one seat even when the application is
 * bypassed entirely. The partial index only guards CONFIRMED rows, so a second
 * PENDING row for the same seat must still be accepted (the late-payment case).
 */

const PASSWORD = "password123";

interface BookingSeatRow extends QueryResultRow {
  booking_id: string;
  seat_id: string;
  status: string;
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

function pgErrorCode(error: unknown): unknown {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return (error as { code: unknown }).code;
}

describe("confirmed booking backstop", () => {
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
    const email = `backstop-${randomUUID()}@seatsync.local`;
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
      title: "Backstop night",
      venue: "Main hall",
      startsAt: "2027-09-05T18:00:00.000Z",
      sections: [{ name: "Floor", rows: 1, seatsPerRow: 2, pricePaise: 2500 }],
    };
  }

  it("rejects a second CONFIRMED booking_seat with 23505 but accepts a second PENDING one", async () => {
    const organizer = await signupUser("ORGANIZER");

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send(eventPayload());

    expect(created.status).toBe(201);

    const published = await request(app)
      .post(`/events/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);

    expect(published.status).toBe(200);

    const seats = created.body.seats as Array<{ id: string; number: number; status: SeatStatus }>;

    expect(seats).toHaveLength(2);

    const seatX = seats[0];

    if (seatX === undefined) {
      throw new Error("Expected a seat");
    }

    const eventId = created.body.id as string;

    async function insertBooking(holdId: string): Promise<string> {
      const result = await pool.query<{ id: string }>(
        `INSERT INTO bookings (user_id, event_id, hold_id, status, amount_paise)
         VALUES ($1, $2, $3, 'PENDING', 2500)
         RETURNING id`,
        [organizer.id, eventId, holdId],
      );

      return requireRow(result.rows).id;
    }

    async function insertBookingSeat(
      bookingId: string,
      seatId: string,
      status: "PENDING" | "CONFIRMED",
    ): Promise<void> {
      await pool.query(
        `INSERT INTO booking_seats (booking_id, seat_id, status)
         VALUES ($1, $2, $3)`,
        [bookingId, seatId, status],
      );
    }

    const firstBooking = await insertBooking(randomUUID());

    await insertBookingSeat(firstBooking, seatX.id, "CONFIRMED");

    const confirmed = await pool.query<BookingSeatRow>(
      `SELECT booking_id, seat_id, status
         FROM booking_seats
        WHERE seat_id = $1`,
      [seatX.id],
    );

    expect(confirmed.rows).toEqual([
      { booking_id: firstBooking, seat_id: seatX.id, status: "CONFIRMED" },
    ]);

    // A second CONFIRMED row for the same seat must trip Rule 3's backstop.
    const secondBooking = await insertBooking(randomUUID());
    let caught: unknown;

    try {
      await insertBookingSeat(secondBooking, seatX.id, "CONFIRMED");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    expect(pgErrorCode(caught)).toBe("23505");
    expect((caught as { constraint?: unknown }).constraint).toBe(
      "one_confirmed_booking_per_seat",
    );

    const afterRejected = await pool.query<BookingSeatRow>(
      `SELECT booking_id, seat_id, status
         FROM booking_seats
        WHERE seat_id = $1
        ORDER BY status`,
      [seatX.id],
    );

    expect(afterRejected.rows).toEqual([
      { booking_id: firstBooking, seat_id: seatX.id, status: "CONFIRMED" },
    ]);

    // The partial index is scoped to CONFIRMED, so a second PENDING row for the
    // same seat succeeds: an abandoned checkout never blocks a new one.
    const thirdBooking = await insertBooking(randomUUID());

    await insertBookingSeat(thirdBooking, seatX.id, "PENDING");

    const finalRows = await pool.query<BookingSeatRow>(
      `SELECT booking_id, seat_id, status
         FROM booking_seats
        WHERE seat_id = $1
        ORDER BY status`,
      [seatX.id],
    );

    expect(finalRows.rows).toEqual([
      { booking_id: firstBooking, seat_id: seatX.id, status: "CONFIRMED" },
      { booking_id: thirdBooking, seat_id: seatX.id, status: "PENDING" },
    ]);

    const bookings = await pool.query<CountRow>(`SELECT count(*)::int AS count FROM bookings`);

    expect(requireRow(bookings.rows).count).toBe(3);

    // The other seat was never involved.
    const otherSeatRows = await pool.query<CountRow>(
      `SELECT count(*)::int AS count FROM booking_seats WHERE seat_id = $1`,
      [seats[1]?.id],
    );

    expect(requireRow(otherSeatRows.rows).count).toBe(0);
  });
});
