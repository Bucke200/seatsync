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
import type { CreateEventRequest, UserRole } from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool, QueryResultRow } from "pg";
import request from "supertest";
import { createApp } from "../../src/app";
import { loadConfig, type Config } from "../../src/config";
import { createCheckoutForHold } from "../../src/db/bookings";
import { createPool } from "../../src/db/pool";
import { createRedisClient } from "../../src/realtime/redis";
import type { PaymentProvider } from "../../src/payments";
import { truncateAll } from "../helpers/db";

/**
 * `design.md:297` / D21 — `POST /holds/:id/checkout`.
 *
 * Real compose Postgres, no database mocking (Rule). The provider is forced to
 * `fake` in the config passed to `createApp`, because the local `.env` selects
 * Razorpay (D19); checkout tests must stay offline and deterministic.
 *
 * A first checkout persists the PENDING booking and its PENDING booking_seats
 * and returns 201 with the provider URL. A second checkout for the same hold
 * replays the stored `{ bookingId, checkoutUrl }` with 200 and creates no rows,
 * which is also how "no second provider call" is asserted (the fake provider
 * exposes no checkout-call counter, so the row count is the observable).
 */

const PASSWORD = "password123";
const PRICE_PAISE = 2_500;
const PAST = "2000-01-01T00:00:00Z";

type BookingStatus = "PENDING" | "CONFIRMED" | "FAILED" | "REFUNDED";

interface BookingRow extends QueryResultRow {
  id: string;
  user_id: string;
  event_id: string;
  hold_id: string;
  status: BookingStatus;
  amount_paise: number;
  checkout_url: string | null;
}

interface BookingSeatRow extends QueryResultRow {
  booking_id: string;
  seat_id: string;
  status: BookingStatus;
}

interface CountRow extends QueryResultRow {
  count: number;
}

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

interface EventSeat {
  id: string;
  number: number;
}

function requireRow<T>(rows: T[]): T {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Expected at least one database row");
  }

  return row;
}

describe("checkout", () => {
  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;

  beforeAll(() => {
    config = loadConfig({ ...process.env, PAYMENT_PROVIDER: "fake" });
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

  async function signupUser(role: UserRole): Promise<TestUser> {
    const email = `checkout-${randomUUID()}@seatsync.local`;
    const response = await request(app)
      .post("/auth/signup")
      .send({ email, password: PASSWORD, role });

    expect(response.status).toBe(201);

    return {
      id: response.body.user.id as string,
      email,
      accessToken: response.body.accessToken as string,
    };
  }

  function eventPayload(seatCount: number, pricePaise: number): CreateEventRequest {
    return {
      title: "Checkout night",
      venue: "Main hall",
      startsAt: "2027-09-05T18:00:00.000Z",
      sections: [
        { name: "Floor", rows: 1, seatsPerRow: seatCount, pricePaise },
      ],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
    seatCount: number,
    pricePaise: number,
  ): Promise<{ id: string; seats: EventSeat[] }> {
    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(eventPayload(seatCount, pricePaise));

    expect(created.status).toBe(201);

    const published = await request(app)
      .post(`/events/${created.body.id as string}/publish`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(published.status).toBe(200);

    return {
      id: created.body.id as string,
      seats: created.body.seats as EventSeat[],
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

  function checkout(accessToken: string, holdId: string) {
    return request(app)
      .post(`/holds/${holdId}/checkout`)
      .set("Authorization", `Bearer ${accessToken}`);
  }

  interface SetupOptions {
    seatCount?: number;
    holdSeatCount?: number;
    pricePaise?: number;
  }

  /** Organizer + published event + one active hold owned by the holder. */
  async function setupHold(options: SetupOptions = {}): Promise<{
    organizer: TestUser;
    holder: TestUser;
    event: { id: string; seats: EventSeat[] };
    heldSeats: EventSeat[];
    holdId: string;
  }> {
    const seatCount = options.seatCount ?? 3;
    const holdSeatCount = options.holdSeatCount ?? 2;
    const pricePaise = options.pricePaise ?? PRICE_PAISE;
    const organizer = await signupUser("ORGANIZER");
    const holder = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(
      organizer.accessToken,
      seatCount,
      pricePaise,
    );
    const heldSeats = event.seats.slice(0, holdSeatCount);

    expect(heldSeats).toHaveLength(holdSeatCount);

    const response = await hold(
      holder.accessToken,
      event.id,
      heldSeats.map((seat) => seat.id),
    );

    expect(response.status).toBe(201);

    return {
      organizer,
      holder,
      event,
      heldSeats,
      holdId: response.body.holdId as string,
    };
  }

  async function readBookingByHoldId(
    holdId: string,
  ): Promise<BookingRow | null> {
    const result = await pool.query<BookingRow>(
      `SELECT id, user_id, event_id, hold_id, status, amount_paise, checkout_url
         FROM bookings
        WHERE hold_id = $1`,
      [holdId],
    );

    return result.rows[0] ?? null;
  }

  async function readBookingSeats(bookingId: string): Promise<BookingSeatRow[]> {
    const result = await pool.query<BookingSeatRow>(
      `SELECT booking_id, seat_id, status
         FROM booking_seats
        WHERE booking_id = $1
        ORDER BY seat_id`,
      [bookingId],
    );

    return result.rows;
  }

  async function countBookings(): Promise<number> {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::int AS count FROM bookings`,
    );

    return requireRow(result.rows).count;
  }

  async function countBookingSeats(): Promise<number> {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::int AS count FROM booking_seats`,
    );

    return requireRow(result.rows).count;
  }

  it(
    "persists a PENDING booking bound to the hold and returns 201 with the checkout URL",
    async () => {
      const { holder, event, heldSeats, holdId } = await setupHold();

      const response = await checkout(holder.accessToken, holdId);

      expect(response.status).toBe(201);

      const bookingId = response.body.bookingId as string;

      expect(typeof bookingId).toBe("string");
      expect(response.body.checkoutUrl).toBe(
        `/bookings/${bookingId}?fakeCheckout=1`,
      );

      const booking = await readBookingByHoldId(holdId);

      expect(booking).not.toBeNull();
      expect(booking).toMatchObject({
        id: bookingId,
        user_id: holder.id,
        event_id: event.id,
        hold_id: holdId,
        status: "PENDING",
        amount_paise: heldSeats.length * PRICE_PAISE,
        checkout_url: response.body.checkoutUrl,
      });

      const bookingSeats = await readBookingSeats(bookingId);

      expect(bookingSeats).toHaveLength(heldSeats.length);
      expect(bookingSeats.map((row) => row.seat_id).sort()).toEqual(
        heldSeats.map((seat) => seat.id).sort(),
      );
      expect(bookingSeats.every((row) => row.status === "PENDING")).toBe(true);

      expect(await countBookings()).toBe(1);
      expect(await countBookingSeats()).toBe(heldSeats.length);
    },
    30_000,
  );

  it(
    "replays the same booking with 200 on a second checkout and creates no new rows",
    async () => {
      const { holder, heldSeats, holdId } = await setupHold();

      const first = await checkout(holder.accessToken, holdId);

      expect(first.status).toBe(201);

      const second = await checkout(holder.accessToken, holdId);

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      // No second provider call: only one booking/booking_seats set exists.
      expect(await countBookings()).toBe(1);
      expect(await countBookingSeats()).toBe(heldSeats.length);
    },
    30_000,
  );

  it(
    "serializes concurrent checkouts for the same hold into one 201 and one 200 replay",
    async () => {
      const { holder, heldSeats, holdId } = await setupHold();

      const [first, second] = await Promise.all([
        checkout(holder.accessToken, holdId),
        checkout(holder.accessToken, holdId),
      ]);

      expect([first.status, second.status].sort()).toEqual([200, 201]);
      expect(second.body).toEqual(first.body);
      expect(await countBookings()).toBe(1);
      expect(await countBookingSeats()).toBe(heldSeats.length);
    },
    30_000,
  );

  it(
    "replays regardless of booking status and hold expiry, as the spec's literal wording requires",
    async () => {
      const { holder, heldSeats, holdId } = await setupHold();
      const first = await checkout(holder.accessToken, holdId);

      expect(first.status).toBe(201);

      // Not reachable through the endpoint (no webhooks yet), but this pins
      // the status-agnostic replay decision (D21): the existing booking wins
      // before any seat/expiry check.
      await pool.query(`UPDATE bookings SET status = 'CONFIRMED' WHERE id = $1`, [
        first.body.bookingId,
      ]);
      await pool.query(
        `UPDATE seats SET held_until = $2::timestamptz WHERE id = ANY($1::uuid[])`,
        [heldSeats.map((seat) => seat.id), PAST],
      );

      const second = await checkout(holder.accessToken, holdId);

      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(await countBookings()).toBe(1);
    },
    30_000,
  );

  it(
    "rejects a checkout by another user with 403 and writes no rows",
    async () => {
      const { holdId } = await setupHold();
      const other = await signupUser("ATTENDEE");

      const response = await checkout(other.accessToken, holdId);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(await countBookings()).toBe(0);
      expect(await countBookingSeats()).toBe(0);
    },
    30_000,
  );

  it(
    "returns 404 HOLD_NOT_FOUND for an unknown hold id",
    async () => {
      const { holder } = await setupHold();

      const response = await checkout(holder.accessToken, randomUUID());

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("HOLD_NOT_FOUND");
      expect(await countBookings()).toBe(0);
      expect(await countBookingSeats()).toBe(0);
    },
    30_000,
  );

  it(
    "returns 404 HOLD_NOT_FOUND when the hold's seats are expired (D9, SQL now())",
    async () => {
      const { holder, heldSeats, holdId } = await setupHold();

      // Absolute past timestamp written directly in Postgres: never wait on
      // real time, and never compare with a JS date (D9 clock skew).
      await pool.query(
        `UPDATE seats SET held_until = $2::timestamptz WHERE id = ANY($1::uuid[])`,
        [heldSeats.map((seat) => seat.id), PAST],
      );

      const response = await checkout(holder.accessToken, holdId);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("HOLD_NOT_FOUND");
      expect(await countBookings()).toBe(0);
      expect(await countBookingSeats()).toBe(0);
    },
    30_000,
  );

  it(
    "returns 404 HOLD_NOT_FOUND after every seat of the hold was released",
    async () => {
      const { holder, holdId } = await setupHold();
      const released = await request(app)
        .delete(`/holds/${holdId}`)
        .set("Authorization", `Bearer ${holder.accessToken}`);

      expect(released.status).toBe(204);

      const response = await checkout(holder.accessToken, holdId);

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("HOLD_NOT_FOUND");
      expect(await countBookings()).toBe(0);
      expect(await countBookingSeats()).toBe(0);
    },
    30_000,
  );

  it(
    "rejects a non-UUID hold id with 400 VALIDATION_ERROR",
    async () => {
      const { holder } = await setupHold();

      const response = await checkout(holder.accessToken, "not-a-uuid");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
      expect(await countBookings()).toBe(0);
    },
    30_000,
  );

  it(
    "rolls the booking back and reports 502 PROVIDER_ERROR when the provider fails",
    async () => {
      const { holder, holdId } = await setupHold();
      const failingProvider: PaymentProvider = {
        createCheckout: async () => {
          throw new Error("injected provider failure");
        },
        verifyWebhook: () => {
          throw new Error("not used by checkout");
        },
        refund: async () => {
          // not used by checkout
        },
      };

      await expect(
        createCheckoutForHold(pool, config, failingProvider, {
          holdId,
          userId: holder.id,
        }),
      ).rejects.toMatchObject({ statusCode: 502, code: "PROVIDER_ERROR" });

      expect(await countBookings()).toBe(0);
      expect(await countBookingSeats()).toBe(0);
    },
    30_000,
  );
});
