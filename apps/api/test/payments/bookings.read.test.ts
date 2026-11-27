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
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "../../src/app";
import { loadConfig, type Config } from "../../src/config";
import { createPool } from "../../src/db/pool";
import { createRedisClient } from "../../src/realtime/redis";
import { truncateAll } from "../helpers/db";

/**
 * Step 5 read routes (D25) — `GET /bookings/:id` and `GET /me/bookings`.
 *
 * Real compose Postgres, no mocks; the provider is forced to `fake` (D19) so
 * checkout setup never touches Razorpay. The booking fixtures come from the
 * real hold + checkout flow, so these reads are asserted against rows the rest
 * of the system wrote.
 */

const PASSWORD = "password123";
const PRICE_PAISE = 2_500;

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

interface EventSeat {
  id: string;
  section: string;
  rowLabel: string;
  number: number;
  pricePaise: number;
  status: string;
}

interface BookingSeatBody {
  seatId: string;
  section: string;
  rowLabel: string;
  number: number;
  status: string;
  pricePaise: number;
}

interface BookingDetailBody {
  id: string;
  eventId: string;
  status: string;
  amountPaise: number;
  paymentRef: string | null;
  checkoutUrl: string | null;
  holdId: string;
  createdAt: string;
  seats: BookingSeatBody[];
}

interface MeBookingsItemBody {
  id: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: string;
  status: string;
  amountPaise: number;
  seatCount: number;
  createdAt: string;
}

interface MeBookingsBody {
  bookings: MeBookingsItemBody[];
}

interface EventOptions {
  seatCount?: number;
  title?: string;
  startsAt?: string;
}

describe("booking reads", () => {
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
    const email = `booking-read-${randomUUID()}@seatsync.local`;
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

  function eventPayload(options: EventOptions = {}): CreateEventRequest {
    return {
      title: options.title ?? "Booking read night",
      venue: "Main hall",
      startsAt: options.startsAt ?? "2027-09-09T18:00:00.000Z",
      sections: [
        {
          name: "Floor",
          rows: 1,
          seatsPerRow: options.seatCount ?? 3,
          pricePaise: PRICE_PAISE,
        },
      ],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
    options: EventOptions = {},
  ): Promise<{ id: string; seats: EventSeat[] }> {
    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(eventPayload(options));

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

  function hold(accessToken: string, eventId: string, seatIds: string[]) {
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

  function readBookingDetail(accessToken: string, bookingId: string) {
    return request(app)
      .get(`/bookings/${bookingId}`)
      .set("Authorization", `Bearer ${accessToken}`);
  }

  function readMyBookings(accessToken: string) {
    return request(app)
      .get("/me/bookings")
      .set("Authorization", `Bearer ${accessToken}`);
  }

  interface BookingSetup {
    organizer: TestUser;
    holder: TestUser;
    event: { id: string; seats: EventSeat[] };
    heldSeats: EventSeat[];
    holdId: string;
    bookingId: string;
    checkoutUrl: string;
  }

  async function setupBooking(options: {
    seatCount?: number;
    holdCount?: number;
    title?: string;
    startsAt?: string;
  } = {}): Promise<BookingSetup> {
    const holdCount = options.holdCount ?? 2;
    const organizer = await signupUser("ORGANIZER");
    const holder = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken, {
      seatCount: options.seatCount ?? 3,
      title: options.title,
      startsAt: options.startsAt,
    });
    const heldSeats = event.seats.slice(0, holdCount);

    expect(heldSeats).toHaveLength(holdCount);

    const held = await hold(
      holder.accessToken,
      event.id,
      heldSeats.map((seat) => seat.id),
    );

    expect(held.status).toBe(201);

    const holdId = held.body.holdId as string;
    const created = await checkout(holder.accessToken, holdId);

    expect(created.status).toBe(201);

    return {
      organizer,
      holder,
      event,
      heldSeats,
      holdId,
      bookingId: created.body.bookingId as string,
      checkoutUrl: created.body.checkoutUrl as string,
    };
  }

  it(
    "returns the owner's booking with amount, status and joined seat details",
    async () => {
      const setup = await setupBooking({ seatCount: 3, holdCount: 2 });

      const response = await readBookingDetail(
        setup.holder.accessToken,
        setup.bookingId,
      );

      expect(response.status).toBe(200);

      const body = response.body as BookingDetailBody;

      expect(body).toMatchObject({
        id: setup.bookingId,
        eventId: setup.event.id,
        status: "PENDING",
        amountPaise: setup.heldSeats.length * PRICE_PAISE,
        paymentRef: null,
        checkoutUrl: setup.checkoutUrl,
        holdId: setup.holdId,
      });
      expect(typeof body.createdAt).toBe("string");
      expect(Number.isNaN(Date.parse(body.createdAt))).toBe(false);
      expect(body.seats).toHaveLength(setup.heldSeats.length);

      const expectedSeats = [...setup.heldSeats].sort(
        (left, right) => left.number - right.number,
      );
      const returnedSeats = [...body.seats].sort(
        (left, right) => left.number - right.number,
      );

      expect(returnedSeats).toEqual(
        expectedSeats.map((seat) => ({
          seatId: seat.id,
          section: seat.section,
          rowLabel: seat.rowLabel,
          number: seat.number,
          // Held by the checkout, so the live seats row is still HELD.
          status: "HELD",
          pricePaise: PRICE_PAISE,
        })),
      );
    },
    30_000,
  );

  it(
    "rejects another user's booking with 403 FORBIDDEN",
    async () => {
      const setup = await setupBooking();
      const other = await signupUser("ATTENDEE");

      const response = await readBookingDetail(
        other.accessToken,
        setup.bookingId,
      );

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
    },
    30_000,
  );

  it(
    "returns 404 BOOKING_NOT_FOUND for an unknown booking id",
    async () => {
      const setup = await setupBooking();

      const response = await readBookingDetail(
        setup.holder.accessToken,
        randomUUID(),
      );

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("BOOKING_NOT_FOUND");
    },
    30_000,
  );

  it(
    "rejects a non-UUID booking id with 400 VALIDATION_ERROR",
    async () => {
      const setup = await setupBooking();

      const response = await readBookingDetail(
        setup.holder.accessToken,
        "not-a-uuid",
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    },
    30_000,
  );

  it(
    "lists the caller's bookings newest-first with event title and seat count, excluding other users",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const userA = await signupUser("ATTENDEE");
      const userB = await signupUser("ATTENDEE");

      const alpha = await createPublishedEvent(organizer.accessToken, {
        seatCount: 3,
        title: "Alpha night",
        startsAt: "2027-10-01T18:00:00.000Z",
      });
      const beta = await createPublishedEvent(organizer.accessToken, {
        seatCount: 4,
        title: "Beta night",
        startsAt: "2027-11-02T19:30:00.000Z",
      });

      async function bookingFor(
        user: TestUser,
        event: { id: string; seats: EventSeat[] },
        seatIds: string[],
      ): Promise<string> {
        const held = await hold(user.accessToken, event.id, seatIds);

        expect(held.status).toBe(201);

        const created = await checkout(
          user.accessToken,
          held.body.holdId as string,
        );

        expect(created.status).toBe(201);

        return created.body.bookingId as string;
      }

      const firstBooking = await bookingFor(
        userA,
        alpha,
        alpha.seats.slice(0, 2).map((seat) => seat.id),
      );
      const secondBooking = await bookingFor(
        userA,
        beta,
        beta.seats.slice(0, 2).map((seat) => seat.id),
      );
      const otherBooking = await bookingFor(userB, alpha, [alpha.seats[2].id]);

      // Pin distinct creation times so newest-first is deterministic even when
      // the two checkouts complete within the same clock tick.
      await pool.query(
        `UPDATE bookings SET created_at = $2::timestamptz WHERE id = $1`,
        [firstBooking, "2027-01-01T00:00:00Z"],
      );
      await pool.query(
        `UPDATE bookings SET created_at = $2::timestamptz WHERE id = $1`,
        [secondBooking, "2027-02-01T00:00:00Z"],
      );

      const response = await readMyBookings(userA.accessToken);

      expect(response.status).toBe(200);

      const body = response.body as MeBookingsBody;

      expect(body.bookings.map((booking) => booking.id)).toEqual([
        secondBooking,
        firstBooking,
      ]);
      expect(body.bookings).toEqual([
        {
          id: secondBooking,
          eventId: beta.id,
          eventTitle: "Beta night",
          eventStartsAt: "2027-11-02T19:30:00.000Z",
          status: "PENDING",
          amountPaise: 2 * PRICE_PAISE,
          seatCount: 2,
          createdAt: "2027-02-01T00:00:00.000Z",
        },
        {
          id: firstBooking,
          eventId: alpha.id,
          eventTitle: "Alpha night",
          eventStartsAt: "2027-10-01T18:00:00.000Z",
          status: "PENDING",
          amountPaise: 2 * PRICE_PAISE,
          seatCount: 2,
          createdAt: "2027-01-01T00:00:00.000Z",
        },
      ]);
      expect(body.bookings.map((booking) => booking.id)).not.toContain(
        otherBooking,
      );

      const otherResponse = await readMyBookings(userB.accessToken);

      expect(otherResponse.status).toBe(200);
      expect(
        (otherResponse.body as MeBookingsBody).bookings.map(
          (booking) => booking.id,
        ),
      ).toEqual([otherBooking]);
    },
    30_000,
  );

  it(
    "requires authentication on both read routes",
    async () => {
      const bookingResponse = await request(app).get(
        `/bookings/${randomUUID()}`,
      );
      const meResponse = await request(app).get("/me/bookings");

      expect(bookingResponse.status).toBe(401);
      expect(bookingResponse.body.error.code).toBe("UNAUTHORIZED");
      expect(meResponse.status).toBe(401);
      expect(meResponse.body.error.code).toBe("UNAUTHORIZED");
    },
    30_000,
  );
});
