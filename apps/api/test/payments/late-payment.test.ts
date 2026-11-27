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
} from "./paymentTestKit";

/**
 * design.md:311 — "user A holds a seat; A's held_until is set in the past;
 * user B holds and pays for the seat; then A's payment_succeeded arrives. A's
 * booking ends REFUNDED with exactly one refund call, and the seat is BOOKED
 * for B."
 *
 * A's booking was PENDING when its hold expired and B re-held/paid the seat, so
 * Rule 2 sees a shortfall (0 HELD seats under A's hold id), fails A's booking,
 * and refunds it after COMMIT. B's seat must never be released or re-versioned
 * by A's late event.
 */

describe("late payment", () => {
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
    "refunds A once and leaves the seat BOOKED for B when A's payment arrives after B paid",
    async () => {
      // A holds and starts checkout (PENDING booking) while the hold is live.
      const setupA = await setupCheckout(app, {
        seatCount: 1,
        holdCount: 1,
        prefix: "late-a",
        title: "Late payment night",
      });
      const seat = requireRow(setupA.heldSeats);

      // The hold expires in Postgres; no real-time wait (D9).
      await expireSeats(pool, [seat.id]);

      // B re-holds the now-expired seat and pays for it.
      const userB = await signupUser(app, "ATTENDEE", "late-b");
      const heldByB = await hold(app, userB.accessToken, setupA.event.id, [
        seat.id,
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
              paymentRef: "pay_late_B",
            }),
          )
        ).status,
      ).toBe(200);

      expect(await readBooking(pool, bookingIdB)).toMatchObject({
        user_id: userB.id,
        status: "CONFIRMED",
        payment_ref: "pay_late_B",
      });

      const seatBookedByB = seatById(
        await readSeats(pool, setupA.event.id),
        seat.id,
      );

      expect(seatBookedByB).toMatchObject({
        status: "BOOKED",
        hold_id: holdIdB,
        held_by: userB.id,
        held_until: null,
        // AVAILABLE 0 -> B hold 1 -> B confirmation 2.
        version: 3,
      });

      // From here only A's late webhook may affect the database.
      received = [];

      const paymentRefA = "pay_late_A";
      const response = await postWebhook(
        app,
        config,
        paymentSucceeded(setupA.bookingId, setupA.holdId, {
          paymentRef: paymentRefA,
        }),
      );

      expect(response.status).toBe(200);

      expect(await readBooking(pool, setupA.bookingId)).toMatchObject({
        user_id: setupA.holder.id,
        status: "REFUNDED",
        payment_ref: paymentRefA,
      });
      expect(
        (await readBookingSeats(pool, setupA.bookingId)).every(
          (row) => row.status === "REFUNDED",
        ),
      ).toBe(true);

      // Exactly one refund call for A's payment (amount = A's booking total).
      expect(fakePaymentControls.refundCalls).toHaveLength(1);
      expect(fakePaymentControls.refundCalls).toEqual([
        { paymentRef: paymentRefA, amountPaise: PRICE_PAISE },
      ]);
      expect(await countProcessedWebhooks(pool)).toBe(2);

      // B's seat is untouched by A's webhook: still BOOKED, same holder and
      // the same version B's confirmation produced.
      expect(
        seatById(await readSeats(pool, setupA.event.id), seat.id),
      ).toEqual(seatBookedByB);
      expect(await readBooking(pool, bookingIdB)).toMatchObject({
        status: "CONFIRMED",
      });

      // Releasing no seat means emitting nothing.
      expect(received).toEqual([]);
    },
    30_000,
  );
});
