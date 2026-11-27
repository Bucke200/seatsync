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
import { runRefundRetryOnce } from "../../src/jobs/retryRefunds";
import {
  createPaymentProvider,
  fakePaymentControls,
} from "../../src/payments";
import { createRedisClient } from "../../src/realtime/redis";
import { seatEvents, type SeatChange } from "../../src/services/seatEvents";
import { truncateAll } from "../helpers/db";
import {
  checkoutExpired,
  countProcessedWebhooks,
  paymentSucceeded,
  postWebhook,
  PRICE_PAISE,
  readBooking,
  readBookingSeats,
  setupCheckout,
} from "./paymentTestKit";

/**
 * design.md:314 — "a failing refund call leaves the booking FAILED, and the
 * next job run moves it to REFUNDED".
 *
 * The webhook transaction commits the FAILED booking and captures the payment
 * ref; the refund runs after COMMIT and its failure must not change the 200.
 * `runRefundRetryOnce` is the testable job entry point (D24/D16).
 */

describe("refund retry", () => {
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
    "leaves the booking FAILED when the post-commit refund throws, then the job refunds it once",
    async () => {
      const setup = await setupCheckout(app, {
        seatCount: 1,
        holdCount: 1,
        prefix: "refund-retry",
        title: "Refund retry night",
      });

      // Fail the booking first; the expiry event has no payment to refund.
      expect(
        (
          await postWebhook(
            app,
            config,
            checkoutExpired(setup.bookingId, setup.holdId),
          )
        ).status,
      ).toBe(200);

      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "FAILED",
        payment_ref: null,
      });
      expect(fakePaymentControls.refundCalls).toEqual([]);
      received = [];

      // The payment arrives after the expiry: the transaction stores the ref,
      // commits, then the post-COMMIT refund attempt fails once.
      fakePaymentControls.failNextRefund();

      const response = await postWebhook(
        app,
        config,
        paymentSucceeded(setup.bookingId, setup.holdId, {
          paymentRef: "pay_retry_me",
        }),
      );

      expect(response.status).toBe(200);
      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "FAILED",
        payment_ref: "pay_retry_me",
      });
      expect(
        (await readBookingSeats(pool, setup.bookingId)).every(
          (row) => row.status === "FAILED",
        ),
      ).toBe(true);

      // The failing attempt is still a provider call and is audited.
      expect(fakePaymentControls.refundCalls).toEqual([
        { paymentRef: "pay_retry_me", amountPaise: PRICE_PAISE },
      ]);
      expect(await countProcessedWebhooks(pool)).toBe(2);
      // A payment after expiry changes no seat.
      expect(received).toEqual([]);

      // Arm a clean audit: the next provider refund is the job's first call.
      fakePaymentControls.reset();

      const provider = createPaymentProvider(config);
      const firstRun = await runRefundRetryOnce(pool, config, provider);

      expect(firstRun).toEqual({ refunded: 1, failed: 0 });
      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "REFUNDED",
        payment_ref: "pay_retry_me",
      });
      expect(
        (await readBookingSeats(pool, setup.bookingId)).every(
          (row) => row.status === "REFUNDED",
        ),
      ).toBe(true);
      expect(fakePaymentControls.refundCalls).toEqual([
        { paymentRef: "pay_retry_me", amountPaise: PRICE_PAISE },
      ]);

      const refundCallsAfterFirstRun = fakePaymentControls.refundCalls.length;
      const secondRun = await runRefundRetryOnce(pool, config, provider);

      // REFUNDED is terminal: the second run selects nothing and calls the
      // provider zero more times.
      expect(secondRun).toEqual({ refunded: 0, failed: 0 });
      expect(fakePaymentControls.refundCalls).toHaveLength(
        refundCallsAfterFirstRun,
      );
      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "REFUNDED",
      });
    },
    30_000,
  );
});
