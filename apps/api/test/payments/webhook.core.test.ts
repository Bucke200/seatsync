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
import { createPool } from "../../src/db/pool";
import { runRefundRetryOnce } from "../../src/jobs/retryRefunds";
import {
  createFakeWebhook,
  createPaymentProvider,
  fakePaymentControls,
  FAKE_SIGNATURE_HEADER,
  type FakeWebhookPayload,
} from "../../src/payments";
import { createRedisClient } from "../../src/realtime/redis";
import { seatEvents, type SeatChange } from "../../src/services/seatEvents";
import { truncateAll } from "../helpers/db";

/**
 * Step 4 focused suite (D22/D23/D24) — the Rule 4 dedupe and Rule 2
 * confirm-or-release transaction behind `POST /webhooks/:provider`.
 *
 * Real compose Postgres, no mocks. The app config forces `PAYMENT_PROVIDER:
 * "fake"` (D19) so no test can touch Razorpay. The fake provider is reached
 * through `fakePaymentControls` for the refund audit and its two one-shot
 * failure seams.
 */

const PASSWORD = "password123";
const PRICE_PAISE = 2_500;
/** D9: expiry is an absolute past timestamp written by SQL, never a JS wait. */
const PAST = "2000-01-01T00:00:00Z";

type BookingStatus = "PENDING" | "CONFIRMED" | "FAILED" | "REFUNDED";

interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

interface EventSeat {
  id: string;
  number: number;
}

interface SeatRow extends QueryResultRow {
  id: string;
  number: number;
  status: string;
  hold_id: string | null;
  held_by: string | null;
  held_until: Date | null;
  version: number;
}

interface BookingRow extends QueryResultRow {
  id: string;
  user_id: string;
  event_id: string;
  hold_id: string;
  status: BookingStatus;
  amount_paise: number;
  payment_ref: string | null;
}

interface BookingSeatRow extends QueryResultRow {
  seat_id: string;
  status: BookingStatus;
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

function sortEvents(events: SeatChange[]): SeatChange[] {
  return [...events].sort((left, right) =>
    left.seatIds[0]?.localeCompare(right.seatIds[0] ?? "") ?? 0,
  );
}

describe("webhook core", () => {
  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;
  let received: SeatChange[] = [];

  function onSeatChange(change: SeatChange): void {
    received.push(change);
  }

  beforeAll(() => {
    config = loadConfig({ ...process.env, PAYMENT_PROVIDER: "fake" });
    pool = createPool(config);
    redis = createRedisClient(config);
    app = createApp({ pool, redis, config });
    seatEvents.on("seatChange", onSeatChange);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    fakePaymentControls.reset();
    received = [];
  });

  afterEach(async () => {
    fakePaymentControls.reset();
    await truncateAll(pool);
  });

  afterAll(async () => {
    seatEvents.off("seatChange", onSeatChange);
    redis.disconnect();
    await pool.end();
  });

  async function signupUser(role: UserRole): Promise<TestUser> {
    const email = `webhook-core-${randomUUID()}@seatsync.local`;
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

  function eventPayload(seatCount: number): CreateEventRequest {
    return {
      title: "Webhook core night",
      venue: "Main hall",
      startsAt: "2027-09-07T18:00:00.000Z",
      sections: [
        { name: "Floor", rows: 1, seatsPerRow: seatCount, pricePaise: PRICE_PAISE },
      ],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
    seatCount: number,
  ): Promise<{ id: string; seats: EventSeat[] }> {
    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(eventPayload(seatCount));

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

  interface CheckoutSetup {
    organizer: TestUser;
    holder: TestUser;
    event: { id: string; seats: EventSeat[] };
    heldSeats: EventSeat[];
    holdId: string;
    bookingId: string;
  }

  async function setupCheckout(
    options: { seatCount?: number; holdCount?: number } = {},
  ): Promise<CheckoutSetup> {
    const seatCount = options.seatCount ?? 3;
    const holdCount = options.holdCount ?? 2;
    const organizer = await signupUser("ORGANIZER");
    const holder = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken, seatCount);
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

    // The hold emitted HELD events; this suite only inspects webhook effects.
    received = [];

    return {
      organizer,
      holder,
      event,
      heldSeats,
      holdId,
      bookingId: created.body.bookingId as string,
    };
  }

  function paymentSucceeded(
    bookingId: string,
    holdId: string,
    options: { eventId?: string; paymentRef?: string } = {},
  ): FakeWebhookPayload {
    return {
      eventId: options.eventId ?? randomUUID(),
      type: "payment_succeeded",
      bookingId,
      holdId,
      paymentRef: options.paymentRef ?? `pay_${randomUUID()}`,
    };
  }

  function checkoutExpired(
    bookingId: string,
    holdId: string,
    eventId: string = randomUUID(),
  ): FakeWebhookPayload {
    return {
      eventId,
      type: "checkout_expired",
      bookingId,
      holdId,
      paymentRef: null,
    };
  }

  function postWebhook(
    payload: FakeWebhookPayload,
    secret: string = config.PAYMENT_WEBHOOK_SECRET,
  ) {
    const { rawBody, signature } = createFakeWebhook(payload, secret);

    return request(app)
      .post(`/webhooks/${config.PAYMENT_PROVIDER}`)
      // supertest serializes a Buffer to JSON when the content type is
      // application/json; octet-stream keeps it as the exact raw bytes the
      // provider signed (and `express.raw({ type: "*/*" })` accepts it).
      .set("Content-Type", "application/octet-stream")
      .set(FAKE_SIGNATURE_HEADER, signature)
      .send(rawBody);
  }

  async function readSeats(eventId: string): Promise<SeatRow[]> {
    const result = await pool.query<SeatRow>(
      `SELECT id, number, status, hold_id, held_by, held_until, version
         FROM seats
        WHERE event_id = $1
        ORDER BY number`,
      [eventId],
    );

    return result.rows;
  }

  async function readBooking(bookingId: string): Promise<BookingRow> {
    const result = await pool.query<BookingRow>(
      `SELECT id, user_id, event_id, hold_id, status, amount_paise, payment_ref
         FROM bookings
        WHERE id = $1`,
      [bookingId],
    );

    return requireRow(result.rows);
  }

  async function readBookingSeats(
    bookingId: string,
  ): Promise<BookingSeatRow[]> {
    const result = await pool.query<BookingSeatRow>(
      `SELECT seat_id, status
         FROM booking_seats
        WHERE booking_id = $1
        ORDER BY seat_id`,
      [bookingId],
    );

    return result.rows;
  }

  async function countProcessedWebhooks(): Promise<number> {
    const result = await pool.query<CountRow>(
      `SELECT count(*)::int AS count FROM processed_webhooks`,
    );

    return requireRow(result.rows).count;
  }

  function seatById(seats: SeatRow[], seatId: string): SeatRow {
    const seat = seats.find((candidate) => candidate.id === seatId);

    if (seat === undefined) {
      throw new Error(`Seat ${seatId} is missing from the event`);
    }

    return seat;
  }

  it(
    "payment_succeeded confirms a PENDING hold, bumps seat versions and emits BOOKED per seat",
    async () => {
      const setup = await setupCheckout();
      const payload = paymentSucceeded(setup.bookingId, setup.holdId);

      const response = await postWebhook(payload);

      expect(response.status).toBe(200);

      const seats = await readSeats(setup.event.id);
      const heldSeatIds = new Set(setup.heldSeats.map((seat) => seat.id));

      for (const seat of seats) {
        if (heldSeatIds.has(seat.id)) {
          expect(seat).toMatchObject({
            status: "BOOKED",
            // Rule 2: the hold binding stays intact after confirmation.
            hold_id: setup.holdId,
            held_by: setup.holder.id,
            held_until: null,
            version: 2,
          });
        } else {
          expect(seat).toMatchObject({
            status: "AVAILABLE",
            hold_id: null,
            held_by: null,
            held_until: null,
            version: 0,
          });
        }
      }

      const booking = await readBooking(setup.bookingId);

      expect(booking).toMatchObject({
        user_id: setup.holder.id,
        event_id: setup.event.id,
        hold_id: setup.holdId,
        status: "CONFIRMED",
        amount_paise: setup.heldSeats.length * PRICE_PAISE,
        payment_ref: payload.paymentRef,
      });

      const bookingSeats = await readBookingSeats(setup.bookingId);

      expect(bookingSeats).toHaveLength(setup.heldSeats.length);
      expect(bookingSeats.every((row) => row.status === "CONFIRMED")).toBe(
        true,
      );
      expect(await countProcessedWebhooks()).toBe(1);

      const expected: SeatChange[] = setup.heldSeats.map((seat) => ({
        eventId: setup.event.id,
        seatIds: [seat.id],
        status: "BOOKED",
        version: 2,
      }));

      expect(received).toHaveLength(setup.heldSeats.length);
      expect(sortEvents(received)).toEqual(sortEvents(expected));
    },
    30_000,
  );

  it(
    "replays the same event id with 200, no second confirmation and one dedupe row",
    async () => {
      const setup = await setupCheckout();
      const payload = paymentSucceeded(setup.bookingId, setup.holdId);

      expect((await postWebhook(payload)).status).toBe(200);

      const beforeReplay = await readSeats(setup.event.id);
      received = [];

      const replay = await postWebhook(payload);

      expect(replay.status).toBe(200);
      expect(received).toEqual([]);
      expect(await countProcessedWebhooks()).toBe(1);
      expect(await readSeats(setup.event.id)).toEqual(beforeReplay);
      expect((await readBooking(setup.bookingId)).status).toBe("CONFIRMED");
    },
    30_000,
  );

  it(
    "processes a different event for the same payment with 200 and still one confirmation",
    async () => {
      const setup = await setupCheckout();
      const first = paymentSucceeded(setup.bookingId, setup.holdId);

      expect((await postWebhook(first)).status).toBe(200);

      const beforeSecond = await readSeats(setup.event.id);
      received = [];

      // Different provider event id, same booking/payment: the Rule 2 status
      // guard must make this a no-op instead of a second confirmation.
      const second = paymentSucceeded(setup.bookingId, setup.holdId, {
        paymentRef: first.paymentRef as string,
      });

      const response = await postWebhook(second);

      expect(response.status).toBe(200);
      expect(received).toEqual([]);
      expect(await countProcessedWebhooks()).toBe(2);
      expect(await readSeats(setup.event.id)).toEqual(beforeSecond);
      expect((await readBooking(setup.bookingId)).status).toBe("CONFIRMED");
    },
    30_000,
  );

  it(
    "rejects a bad signature with 400 and writes nothing",
    async () => {
      const setup = await setupCheckout();
      const payload = paymentSucceeded(setup.bookingId, setup.holdId);
      const before = await readSeats(setup.event.id);

      const response = await postWebhook(payload, "definitely-the-wrong-secret");

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
      expect(await countProcessedWebhooks()).toBe(0);
      expect(await readSeats(setup.event.id)).toEqual(before);
      expect((await readBooking(setup.bookingId)).status).toBe("PENDING");
      expect(
        (await readBookingSeats(setup.bookingId)).every(
          (row) => row.status === "PENDING",
        ),
      ).toBe(true);
      expect(received).toEqual([]);
      expect(fakePaymentControls.refundCalls).toEqual([]);
    },
    30_000,
  );

  it(
    "returns 500 with nothing persisted when the transaction fails after the dedupe insert, then confirms on redelivery",
    async () => {
      const setup = await setupCheckout();
      const payload = paymentSucceeded(setup.bookingId, setup.holdId);
      const before = await readSeats(setup.event.id);

      fakePaymentControls.failAfterDedupe();

      const failing = await postWebhook(payload);

      expect(failing.status).toBe(500);
      expect(await countProcessedWebhooks()).toBe(0);
      expect(await readSeats(setup.event.id)).toEqual(before);
      expect((await readBooking(setup.bookingId)).status).toBe("PENDING");
      expect(received).toEqual([]);

      // The one-shot seam is disarmed; the provider's redelivery is processed
      // from scratch because the dedupe row was rolled back.
      const redelivery = await postWebhook(payload);

      expect(redelivery.status).toBe(200);
      expect(await countProcessedWebhooks()).toBe(1);
      expect((await readBooking(setup.bookingId)).status).toBe("CONFIRMED");
      expect(received).toHaveLength(setup.heldSeats.length);
    },
    30_000,
  );

  it(
    "checkout_expired releases the hold's seats and fails the booking with no refund",
    async () => {
      const setup = await setupCheckout();
      const payload = checkoutExpired(setup.bookingId, setup.holdId);

      const response = await postWebhook(payload);

      expect(response.status).toBe(200);

      const seats = await readSeats(setup.event.id);
      const heldSeatIds = new Set(setup.heldSeats.map((seat) => seat.id));

      for (const seat of seats) {
        if (heldSeatIds.has(seat.id)) {
          expect(seat).toMatchObject({
            status: "AVAILABLE",
            hold_id: null,
            held_by: null,
            held_until: null,
            version: 2,
          });
        }
      }

      const booking = await readBooking(setup.bookingId);

      expect(booking).toMatchObject({
        status: "FAILED",
        // No payment happened for an expiry: there is nothing to refund.
        payment_ref: null,
      });
      expect(
        (await readBookingSeats(setup.bookingId)).every(
          (row) => row.status === "FAILED",
        ),
      ).toBe(true);
      expect(await countProcessedWebhooks()).toBe(1);
      expect(fakePaymentControls.refundCalls).toEqual([]);

      const expected: SeatChange[] = setup.heldSeats.map((seat) => ({
        eventId: setup.event.id,
        seatIds: [seat.id],
        status: "AVAILABLE",
        version: 2,
      }));

      expect(received).toHaveLength(setup.heldSeats.length);
      expect(sortEvents(received)).toEqual(sortEvents(expected));
    },
    30_000,
  );

  it(
    "late payment: A's expired seat re-claimed by B fails A's booking, refunds once and leaves the seat with B",
    async () => {
      const setup = await setupCheckout({ seatCount: 2, holdCount: 1 });
      const heldSeat = requireRow(setup.heldSeats);

      await pool.query(
        `UPDATE seats SET held_until = $2::timestamptz WHERE id = $1`,
        [heldSeat.id, PAST],
      );

      const userB = await signupUser("ATTENDEE");
      const heldByB = await hold(userB.accessToken, setup.event.id, [
        heldSeat.id,
      ]);

      expect(heldByB.status).toBe(201);

      // B's re-hold emitted its own HELD event; only the webhook's effects are
      // under test from here.
      received = [];

      const holdIdB = heldByB.body.holdId as string;
      const paymentRefA = "pay_late_A";
      const payload = paymentSucceeded(setup.bookingId, setup.holdId, {
        paymentRef: paymentRefA,
      });

      const response = await postWebhook(payload);

      expect(response.status).toBe(200);

      // B's seat must be untouched: it no longer carries A's hold id.
      const seat = seatById(await readSeats(setup.event.id), heldSeat.id);

      expect(seat).toMatchObject({
        status: "HELD",
        hold_id: holdIdB,
        held_by: userB.id,
        version: 2,
      });

      const booking = await readBooking(setup.bookingId);

      expect(booking).toMatchObject({
        status: "REFUNDED",
        payment_ref: paymentRefA,
      });
      expect(
        (await readBookingSeats(setup.bookingId)).every(
          (row) => row.status === "REFUNDED",
        ),
      ).toBe(true);

      // Exactly one refund call: the FAILED -> REFUNDED guard plus the row
      // lock means neither a replay nor the retry job can issue a second one.
      expect(fakePaymentControls.refundCalls).toEqual([
        { paymentRef: paymentRefA, amountPaise: PRICE_PAISE },
      ]);
      expect(await countProcessedWebhooks()).toBe(1);
      expect(received).toEqual([]);
    },
    30_000,
  );

  it(
    "captures a payment that arrives after checkout_expired and refunds it exactly once",
    async () => {
      const setup = await setupCheckout({ seatCount: 1, holdCount: 1 });

      expect(
        (await postWebhook(checkoutExpired(setup.bookingId, setup.holdId)))
          .status,
      ).toBe(200);

      const failed = await readBooking(setup.bookingId);

      expect(failed).toMatchObject({ status: "FAILED", payment_ref: null });
      expect(fakePaymentControls.refundCalls).toEqual([]);
      received = [];

      const payload = paymentSucceeded(setup.bookingId, setup.holdId, {
        paymentRef: "pay_after_expiry",
      });

      const response = await postWebhook(payload);

      expect(response.status).toBe(200);
      expect(await readBooking(setup.bookingId)).toMatchObject({
        status: "REFUNDED",
        payment_ref: "pay_after_expiry",
      });
      expect(
        (await readBookingSeats(setup.bookingId)).every(
          (row) => row.status === "REFUNDED",
        ),
      ).toBe(true);
      expect(fakePaymentControls.refundCalls).toEqual([
        { paymentRef: "pay_after_expiry", amountPaise: PRICE_PAISE },
      ]);
      expect(await countProcessedWebhooks()).toBe(2);
      // The payment event changes no seat: the expiry already released it.
      expect(received).toEqual([]);
    },
    30_000,
  );

  it(
    "keeps the webhook 200 when the post-commit refund fails, then the retry job refunds the booking",
    async () => {
      const setup = await setupCheckout({ seatCount: 1, holdCount: 1 });

      expect(
        (await postWebhook(checkoutExpired(setup.bookingId, setup.holdId)))
          .status,
      ).toBe(200);
      received = [];

      fakePaymentControls.failNextRefund();

      const response = await postWebhook(
        paymentSucceeded(setup.bookingId, setup.holdId, {
          paymentRef: "pay_retry_me",
        }),
      );

      // The refund trigger is awaited after COMMIT, but its failure must not
      // change the webhook result; the booking stays refundable.
      expect(response.status).toBe(200);
      expect(await readBooking(setup.bookingId)).toMatchObject({
        status: "FAILED",
        payment_ref: "pay_retry_me",
      });
      expect(fakePaymentControls.refundCalls).toHaveLength(1);
      expect(received).toEqual([]);

      const provider = createPaymentProvider(config);
      const summary = await runRefundRetryOnce(pool, config, provider);

      expect(summary).toEqual({ refunded: 1, failed: 0 });
      expect(await readBooking(setup.bookingId)).toMatchObject({
        status: "REFUNDED",
        payment_ref: "pay_retry_me",
      });
      expect(
        (await readBookingSeats(setup.bookingId)).every(
          (row) => row.status === "REFUNDED",
        ),
      ).toBe(true);
      expect(fakePaymentControls.refundCalls).toHaveLength(2);
    },
    30_000,
  );

  it(
    "returns 400 UNKNOWN_PROVIDER for a provider that is not the configured one",
    async () => {
      const response = await request(app)
        .post("/webhooks/not-the-configured-provider")
        .set("Content-Type", "application/json")
        .send(Buffer.from("{}", "utf8"));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("UNKNOWN_PROVIDER");
      expect(await countProcessedWebhooks()).toBe(0);
    },
    30_000,
  );
});
