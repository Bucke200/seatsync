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
  countConfirmedBookings,
  countProcessedWebhooks,
  paymentSucceeded,
  postWebhook,
  readBooking,
  readBookingSeats,
  readSeats,
  setupCheckout,
} from "./paymentTestKit";

/**
 * design.md:310 — "two different events for the same payment still give
 * exactly 1 confirmation".
 *
 * Distinct provider event ids mean Rule 4 lets both through; the second
 * delivery is stopped by the Rule 2 guard on the booking's terminal state.
 * That is why this suite expects two `processed_webhooks` rows and still only
 * one confirmation.
 */

describe("webhook multi-event", () => {
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
    "confirms once when two distinct provider events reference the same payment",
    async () => {
      const setup = await setupCheckout(app, {
        seatCount: 2,
        holdCount: 2,
        prefix: "multi-event",
        title: "Multi-event night",
      });

      received = [];

      const paymentRef = "pay_multi_event";
      const first = paymentSucceeded(setup.bookingId, setup.holdId, {
        paymentRef,
      });
      const second = paymentSucceeded(setup.bookingId, setup.holdId, {
        paymentRef,
      });

      // Different provider event ids: Rule 4 cannot be what stops delivery 2.
      expect(second.eventId).not.toBe(first.eventId);

      expect((await postWebhook(app, config, first)).status).toBe(200);

      const seatsAfterFirst = await readSeats(pool, setup.event.id);

      expect(received).toHaveLength(setup.heldSeats.length);
      received = [];

      expect((await postWebhook(app, config, second)).status).toBe(200);

      expect(await countProcessedWebhooks(pool)).toBe(2);
      expect(await countConfirmedBookings(pool, setup.event.id)).toBe(1);
      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "CONFIRMED",
        payment_ref: paymentRef,
      });
      expect(
        (await readBookingSeats(pool, setup.bookingId)).every(
          (row) => row.status === "CONFIRMED",
        ),
      ).toBe(true);

      // The Rule 2 terminal guard made the second event a complete no-op:
      // identical seats (including versions) and no emitted seat change.
      expect(await readSeats(pool, setup.event.id)).toEqual(seatsAfterFirst);
      expect(received).toEqual([]);
      expect(fakePaymentControls.refundCalls).toEqual([]);
    },
    30_000,
  );
});
