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
  countBookingSeats,
  countBookings,
  countProcessedWebhooks,
  paymentSucceeded,
  postUnsignedWebhook,
  postWebhook,
  readBooking,
  readBookingSeats,
  readSeats,
  setupCheckout,
} from "./paymentTestKit";

/**
 * design.md:312 — "a bad signature returns 400 and writes no rows".
 *
 * Verification happens before the transaction opens (D22), so this checks the
 * whole footprint: no dedupe row, no booking/booking_seats change, no seat
 * change and no emission. The missing-header variant covers
 * `signature === undefined` without trusting the body.
 */

describe("webhook signature", () => {
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
    "rejects a bad signature with 400 and writes nothing",
    async () => {
      const setup = await setupCheckout(app, {
        seatCount: 2,
        holdCount: 2,
        prefix: "signature",
        title: "Signature night",
      });

      // The hold emitted HELD events; a rejected delivery must add nothing.
      received = [];

      const seatsBefore = await readSeats(pool, setup.event.id);
      const bookingBefore = await readBooking(pool, setup.bookingId);
      const bookingSeatsBefore = await readBookingSeats(
        pool,
        setup.bookingId,
      );
      const bookingCountBefore = await countBookings(pool);
      const bookingSeatCountBefore = await countBookingSeats(pool);

      const response = await postWebhook(
        app,
        config,
        paymentSucceeded(setup.bookingId, setup.holdId),
        "definitely-the-wrong-secret",
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
      expect(await countProcessedWebhooks(pool)).toBe(0);

      // Every table this flow could have touched is byte-for-byte unchanged.
      expect(await countBookings(pool)).toBe(bookingCountBefore);
      expect(await countBookingSeats(pool)).toBe(bookingSeatCountBefore);
      expect(await readBooking(pool, setup.bookingId)).toEqual(bookingBefore);
      expect(await readBookingSeats(pool, setup.bookingId)).toEqual(
        bookingSeatsBefore,
      );
      expect(await readSeats(pool, setup.event.id)).toEqual(seatsBefore);
      expect(received).toEqual([]);
      expect(fakePaymentControls.refundCalls).toEqual([]);
    },
    30_000,
  );

  it(
    "rejects a delivery without a signature header with 400 and writes nothing",
    async () => {
      const setup = await setupCheckout(app, {
        seatCount: 1,
        holdCount: 1,
        prefix: "signature-missing",
        title: "Missing signature night",
      });

      received = [];

      const seatsBefore = await readSeats(pool, setup.event.id);

      const response = await postUnsignedWebhook(
        app,
        config,
        paymentSucceeded(setup.bookingId, setup.holdId),
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("WEBHOOK_SIGNATURE_INVALID");
      expect(await countProcessedWebhooks(pool)).toBe(0);
      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "PENDING",
      });
      expect(await readSeats(pool, setup.event.id)).toEqual(seatsBefore);
      expect(received).toEqual([]);
    },
    30_000,
  );
});
