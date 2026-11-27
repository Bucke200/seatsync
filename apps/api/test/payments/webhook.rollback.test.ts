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
  countProcessedWebhooks,
  paymentSucceeded,
  postWebhook,
  readBooking,
  readBookingSeats,
  readSeats,
  setupCheckout,
  sortEvents,
} from "./paymentTestKit";

/**
 * design.md:313 — "an error injected after the processed_webhooks insert
 * commits nothing, and redelivering the webhook then confirms the booking".
 *
 * The fake provider's one-shot `failAfterDedupe` seam throws between the dedupe
 * insert and the booking lock. The 500 must roll the dedupe row back too; the
 * provider's redelivery then has a clean slate.
 */

describe("webhook rollback", () => {
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
    "rolls back the dedupe insert and confirms on redelivery after the injected failure",
    async () => {
      const setup = await setupCheckout(app, {
        seatCount: 2,
        holdCount: 2,
        prefix: "rollback",
        title: "Rollback night",
      });

      received = [];

      const seatsBefore = await readSeats(pool, setup.event.id);
      const payload = paymentSucceeded(setup.bookingId, setup.holdId, {
        paymentRef: "pay_rollback",
      });

      fakePaymentControls.failAfterDedupe();

      const failing = await postWebhook(app, config, payload);

      expect(failing.status).toBe(500);
      expect(failing.body.error.code).toBe("INTERNAL_ERROR");

      // Nothing from the aborted transaction survives, including the dedupe
      // row that was inserted before the injected error.
      expect(await countProcessedWebhooks(pool)).toBe(0);
      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "PENDING",
        payment_ref: null,
      });
      expect(
        (await readBookingSeats(pool, setup.bookingId)).every(
          (row) => row.status === "PENDING",
        ),
      ).toBe(true);
      expect(await readSeats(pool, setup.event.id)).toEqual(seatsBefore);
      expect(received).toEqual([]);
      expect(fakePaymentControls.refundCalls).toEqual([]);

      // The one-shot seam is spent; the provider redelivers the same event and
      // the whole transaction is replayed from a clean slate.
      fakePaymentControls.reset();

      const redelivery = await postWebhook(app, config, payload);

      expect(redelivery.status).toBe(200);
      expect(await countProcessedWebhooks(pool)).toBe(1);
      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "CONFIRMED",
        payment_ref: "pay_rollback",
      });
      expect(
        (await readBookingSeats(pool, setup.bookingId)).every(
          (row) => row.status === "CONFIRMED",
        ),
      ).toBe(true);

      const seatsAfter = await readSeats(pool, setup.event.id);
      const heldSeatIds = new Set(setup.heldSeats.map((seat) => seat.id));

      for (const seat of seatsAfter) {
        if (heldSeatIds.has(seat.id)) {
          expect(seat).toMatchObject({
            status: "BOOKED",
            hold_id: setup.holdId,
            version: 2,
          });
        }
      }

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
});
