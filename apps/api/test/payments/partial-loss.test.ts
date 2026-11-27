import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { createApp } from "../../src/app";
import { loadConfig, type Config } from "../../src/config";
import { createPool } from "../../src/db/pool";
import { fakePaymentControls } from "../../src/payments";
import { createRedisClient } from "../../src/realtime/redis";
import { seatEvents, type SeatChange } from "../../src/services/seatEvents";
import { truncateAll } from "../helpers/db";
import {
  checkout,
  countProcessedWebhooks,
  expireSeats,
  hold,
  paymentSucceeded,
  postWebhook,
  PRICE_PAISE,
  readBooking,
  readBookingSeats,
  readSeats,
  requireRow,
  seatById,
  setupCheckout,
  signupUser,
  sortEvents,
} from "./paymentTestKit";

/**
 * design.md:315 — "user A holds 3 seats and starts checkout; A's held_until
 * expires and user B claims 1 of the 3 seats; then A's payment_succeeded
 * arrives. A's booking ends REFUNDED with exactly one refund call, B's seat
 * stays held or booked by B, the other 2 seats return to AVAILABLE with an
 * incremented version, and the invariants queries return 0 rows".
 *
 * The Rule 2 shortfall path must release only seats still bound to A's hold,
 * never B's re-held/re-booked seat.
 */

describe("partial loss", () => {
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

  it(
    "refunds A once, keeps B's seat booked and releases only A's remaining two seats",
    async () => {
      const setupA = await setupCheckout(app, {
        seatCount: 3,
        holdCount: 3,
        prefix: "partial-a",
        title: "Partial loss night",
      });

      expect(setupA.heldSeats).toHaveLength(3);

      const claimedSeat = requireRow(setupA.heldSeats);
      const releasedSeats = setupA.heldSeats.filter(
        (seat) => seat.id !== claimedSeat.id,
      );

      expect(releasedSeats).toHaveLength(2);

      // A's whole hold expires in Postgres (no real-time wait, D9).
      await expireSeats(
        pool,
        setupA.heldSeats.map((seat) => seat.id),
      );

      // B claims exactly one of A's three expired seats and pays for it.
      const userB = await signupUser(app, "ATTENDEE", "partial-b");
      const heldByB = await hold(app, userB.accessToken, setupA.event.id, [
        claimedSeat.id,
      ]);

      expect(heldByB.status).toBe(201);

      const holdIdB = heldByB.body.holdId as string;
      const checkoutB = await checkout(app, userB.accessToken, holdIdB);

      expect(checkoutB.status).toBe(201);

      const bookingIdB = checkoutB.body.bookingId as string;

      expect(
        (
          await postWebhook(
            app,
            config,
            paymentSucceeded(bookingIdB, holdIdB, {
              paymentRef: "pay_partial_B",
            }),
          )
        ).status,
      ).toBe(200);

      expect(await readBooking(pool, bookingIdB)).toMatchObject({
        status: "CONFIRMED",
      });

      const bSeatAfterPayment = seatById(
        await readSeats(pool, setupA.event.id),
        claimedSeat.id,
      );

      expect(bSeatAfterPayment).toMatchObject({
        status: "BOOKED",
        hold_id: holdIdB,
        held_by: userB.id,
        held_until: null,
        version: 3,
      });

      // From here on only A's late webhook may change anything.
      received = [];

      const paymentRefA = "pay_partial_A";
      const refundAmountPaise = 3 * PRICE_PAISE;
      const response = await postWebhook(
        app,
        config,
        paymentSucceeded(setupA.bookingId, setupA.holdId, {
          paymentRef: paymentRefA,
        }),
      );

      expect(response.status).toBe(200);
      expect(await countProcessedWebhooks(pool)).toBe(2);

      // A's booking and all three of its booking_seats are refunded.
      expect(await readBooking(pool, setupA.bookingId)).toMatchObject({
        status: "REFUNDED",
        payment_ref: paymentRefA,
        amount_paise: refundAmountPaise,
      });

      const aBookingSeats = await readBookingSeats(pool, setupA.bookingId);

      expect(aBookingSeats).toHaveLength(3);
      expect(aBookingSeats.every((row) => row.status === "REFUNDED")).toBe(
        true,
      );

      // Exactly one refund call for A's full booking amount.
      expect(fakePaymentControls.refundCalls).toHaveLength(1);
      expect(fakePaymentControls.refundCalls).toEqual([
        { paymentRef: paymentRefA, amountPaise: refundAmountPaise },
      ]);

      // B's seat is exactly as B's confirmation left it: not released and not
      // re-versioned by A's webhook.
      expect(
        seatById(await readSeats(pool, setupA.event.id), claimedSeat.id),
      ).toEqual(bSeatAfterPayment);
      expect(await readBooking(pool, bookingIdB)).toMatchObject({
        status: "CONFIRMED",
      });

      // The other two seats return to AVAILABLE with one incremented version
      // (A hold 0 -> 1, shortfall release 1 -> 2).
      const seatsAfter = await readSeats(pool, setupA.event.id);
      const releasedSeatIds = new Set(releasedSeats.map((seat) => seat.id));

      for (const seat of seatsAfter) {
        if (releasedSeatIds.has(seat.id)) {
          expect(seat).toMatchObject({
            status: "AVAILABLE",
            hold_id: null,
            held_by: null,
            held_until: null,
            version: 2,
          });
        }
      }

      const expectedEvents: SeatChange[] = releasedSeats.map((seat) => ({
        eventId: setupA.event.id,
        seatIds: [seat.id],
        status: "AVAILABLE",
        version: 2,
      }));

      expect(received).toHaveLength(releasedSeats.length);
      expect(sortEvents(received)).toEqual(sortEvents(expectedEvents));

      // Rule 3 invariants after the partial loss.
      const duplicateConfirmed = await pool.query(
        `SELECT bs.seat_id
           FROM booking_seats bs
          WHERE bs.status = 'CONFIRMED'
          GROUP BY bs.seat_id
         HAVING count(*) > 1`,
      );

      expect(duplicateConfirmed.rows).toEqual([]);

      const bookedWithoutConfirmedBooking = await pool.query(
        `SELECT s.id
           FROM seats s
          WHERE s.status = 'BOOKED'
            AND NOT EXISTS (
              SELECT 1
                FROM booking_seats bs
                JOIN bookings b ON b.id = bs.booking_id
               WHERE bs.seat_id = s.id
                 AND bs.status = 'CONFIRMED'
                 AND b.status = 'CONFIRMED'
            )`,
      );

      expect(bookedWithoutConfirmedBooking.rows).toEqual([]);

      const confirmedBookingSeatNotBooked = await pool.query(
        `SELECT bs.seat_id
           FROM booking_seats bs
           JOIN bookings b ON b.id = bs.booking_id
           JOIN seats s ON s.id = bs.seat_id
          WHERE b.status = 'CONFIRMED'
            AND bs.status = 'CONFIRMED'
            AND s.status <> 'BOOKED'`,
      );

      expect(confirmedBookingSeatNotBooked.rows).toEqual([]);
    },
    30_000,
  );
});
