import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import pino from "pino";
import { loadConfig, type Config } from "../../src/config";
import { createPool } from "../../src/db/pool";
import type { SeatEventMessage } from "../../src/realtime/publisher";
import { createRedisClient } from "../../src/realtime/redis";
import { truncateAll } from "../helpers/db";
import {
  TestSocket,
  WAITER_TIMEOUT_MS,
  bootTestApp,
  createPublishedEvent,
  getEventDetail,
  holdSeats,
  isRecord,
  isSeatUpdateFrame,
  signupUser,
  type TestHarness,
} from "./helpers";

/**
 * `design.md:339` — live acceptance check.
 *
 * A subscribed client must receive the change produced by a REST hold within
 * `LIVE_UPDATE_MAX_MS` (1 000 ms), carrying that seat's committed version.
 *
 * Latency is measured as message-arrival minus the instant immediately before
 * the hold request. The waiter itself is deliberately generous (5 s): it only
 * prevents a hang, while the design threshold is asserted on the measured
 * arrival time. No fixed sleeps are used anywhere.
 */

describe("realtime live delivery", () => {
  const log = pino({ level: "silent" });

  let pool: Pool;
  let redis: Redis;
  let config: Config;
  let harness: TestHarness;

  beforeAll(async () => {
    config = loadConfig(process.env);
    pool = createPool(config);
    redis = createRedisClient(config);
    harness = await bootTestApp({ config, pool, redis, log });
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await harness.close();
    redis.disconnect();
    await pool.end();
  });

  it("delivers a REST hold to a subscribed client within LIVE_UPDATE_MAX_MS with the correct version", async () => {
    const organizer = await signupUser(harness.app, "ORGANIZER");
    const attendee = await signupUser(harness.app, "ATTENDEE");
    const event = await createPublishedEvent(
      harness.app,
      organizer.accessToken,
      3,
    );

    const [first, second] = event.seats;

    if (first === undefined || second === undefined) {
      throw new Error("Expected at least two seats");
    }

    const client = await TestSocket.connect(harness.wsUrl);

    try {
      client.send({ type: "auth", token: attendee.accessToken });
      await client.waitFor(
        (frame) => isRecord(frame) && frame.type === "auth_ok",
      );

      client.send({ type: "subscribe", eventId: event.id });
      await client.waitFor(
        (frame) =>
          isRecord(frame) &&
          frame.type === "subscribed" &&
          frame.eventId === event.id,
      );

      // Measure the instant before the REST call; everything after that is
      // either the committed change or transport latency.
      const sendTime = Date.now();
      const hold = await holdSeats(
        harness.app,
        attendee.accessToken,
        event.id,
        [first.id, second.id],
      );

      expect(hold.status).toBe(201);
      expect(hold.body.seatIds).toHaveLength(2);

      const message = await client.waitFor(isSeatUpdateFrame);
      const elapsed = message.receivedAt - sendTime;

      // Spec threshold, not the waiter bound.
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(config.LIVE_UPDATE_MAX_MS);

      const payload = message.frame as SeatEventMessage;

      expect(payload.eventId).toBe(event.id);

      // The publisher groups same-tick emissions, so the FIRST seat-update
      // frame carries every seat the hold changed.
      expect(payload.seats).toHaveLength(2);
      expect(payload.seats.map((seat) => seat.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );

      const snapshot = await getEventDetail(
        harness.app,
        attendee.accessToken,
        event.id,
      );
      const snapshotBySeat = new Map(
        snapshot.seats.map((seat) => [seat.id, seat] as const),
      );

      for (const update of payload.seats) {
        const snapshotSeat = snapshotBySeat.get(update.id);

        if (snapshotSeat === undefined) {
          throw new Error(`Snapshot is missing seat ${update.id}`);
        }

        expect(update.status).toBe("HELD");
        // Rule 7 / D29: the wire version is the seat's committed version.
        expect(update.version).toBe(snapshotSeat.version);
        expect(snapshotSeat.status).toBe("HELD");
      }
    } finally {
      await client.close();
    }
  }, WAITER_TIMEOUT_MS * 2);

  it("rejects a bad token without authenticating or joining a room", async () => {
    const client = await TestSocket.connect(harness.wsUrl);

    try {
      client.send({ type: "auth", token: "definitely-not-a-jwt" });

      const error = await client.waitFor(
        (frame) =>
          isRecord(frame) &&
          frame.type === "error" &&
          frame.code === "UNAUTHORIZED",
      );

      expect(error.frame).toMatchObject({
        type: "error",
        code: "UNAUTHORIZED",
      });

      const closed = await client.waitForClose();

      expect(closed.code).toBe(1008);
      expect(
        client.frames.some(
          (frame) => isRecord(frame) && frame.type === "auth_ok",
        ),
      ).toBe(false);
      expect(client.frames.filter(isSeatUpdateFrame)).toEqual([]);
    } finally {
      await client.close();
    }
  });
});
