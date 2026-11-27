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
  PRICE_PAISE,
  readBooking,
  readBookingSeats,
  readSeats,
  setupCheckout,
  sortEvents,
} from "./paymentTestKit";

/**
 * design.md:309 — "the same webhook delivered 5 times gives 1 confirmation and
 * 1 processed_webhooks row, and all 5 responses are 200".
 *
 * The fake provider's HMAC makes every delivery byte-identical, so this pins
 * Rule 4 (processed_webhooks dedupe) rather than the Rule 2 status guard.
 */

describe("webhook replay", () => {
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
    "accepts five deliveries with 200, confirms once and keeps one dedupe row",
    async () => {
      const setup = await setupCheckout(app, {
        seatCount: 3,
        holdCount: 2,
        prefix: "replay",
        title: "Replay night",
      });

      // The hold emitted HELD events; only the webhook effects matter here.
      received = [];

      const payload = paymentSucceeded(setup.bookingId, setup.holdId, {
        paymentRef: "pay_replay_me",
      });
      const statuses: number[] = [];

      for (let delivery = 0; delivery < 5; delivery += 1) {
        const response = await postWebhook(app, config, payload);

        expect(response.body).toEqual({ received: true });
        statuses.push(response.status);
      }

      expect(statuses).toEqual([200, 200, 200, 200, 200]);
      expect(await countProcessedWebhooks(pool)).toBe(1);
      expect(await countConfirmedBookings(pool, setup.event.id)).toBe(1);

      expect(await readBooking(pool, setup.bookingId)).toMatchObject({
        status: "CONFIRMED",
        amount_paise: setup.heldSeats.length * PRICE_PAISE,
        payment_ref: "pay_replay_me",
      });

      const bookingSeats = await readBookingSeats(pool, setup.bookingId);

      expect(bookingSeats).toHaveLength(setup.heldSeats.length);
      expect(bookingSeats.every((row) => row.status === "CONFIRMED")).toBe(true);

      // A second confirmation would bump version past the single Rule 2 update.
      const seats = await readSeats(pool, setup.event.id);
      const heldSeatIds = new Set(setup.heldSeats.map((seat) => seat.id));

      for (const seat of seats) {
        if (heldSeatIds.has(seat.id)) {
          expect(seat).toMatchObject({
            status: "BOOKED",
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
            version: 0,
          });
        }
      }

      // Exactly one BOOKED set was emitted, not one per delivery.
      const expected: SeatChange[] = setup.heldSeats.map((seat) => ({
        eventId: setup.event.id,
        seatIds: [seat.id],
        status: "BOOKED",
        version: 2,
      }));

      expect(received).toHaveLength(setup.heldSeats.length);
      expect(sortEvents(received)).toEqual(sortEvents(expected));
      expect(fakePaymentControls.refundCalls).toEqual([]);
    },
    30_000,
  );
});
