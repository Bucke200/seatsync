import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import {
  applySeatVersionFilter,
  mergeSeatSnapshot,
} from "@seatsync/shared";
import { Redis } from "ioredis";
import type { Pool } from "pg";
import pino from "pino";
import { loadConfig, type Config } from "../../src/config";
import { createPool } from "../../src/db/pool";
import {
  seatEventChannel,
  type SeatEventMessage,
} from "../../src/realtime/publisher";
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
 * `design.md:342` — stale acceptance check.
 *
 * D29 makes stale filtering strictly client-side: the server forwards every
 * valid wire message, and the client applies an update only when its version is
 * strictly newer than the version it already has for that seat. The shared
 * helper (`applySeatVersionFilter`) is the single implementation of that rule,
 * so the unit cases below are the normative ones; the socket case replays
 * hand-crafted messages through the real subscriber path to prove the client
 * helper rejects them even though the server delivered them.
 */

describe("applySeatVersionFilter (shared client stale filter)", () => {
  it("ignores a message older than the client's seat version", () => {
    const versions = new Map<string, number>([["seat-1", 5]]);

    const result = applySeatVersionFilter(versions, [
      { id: "seat-1", version: 4 },
    ]);

    expect(result).toEqual({ accepted: [], stale: ["seat-1"] });
    expect(versions.get("seat-1")).toBe(5);
  });

  it("ignores an equal version (duplicate delivery)", () => {
    const versions = new Map<string, number>([["seat-1", 5]]);

    const result = applySeatVersionFilter(versions, [
      { id: "seat-1", version: 5 },
    ]);

    expect(result).toEqual({ accepted: [], stale: ["seat-1"] });
    expect(versions.get("seat-1")).toBe(5);
  });

  it("accepts a newer version and advances the version map", () => {
    const versions = new Map<string, number>([["seat-1", 5]]);

    const result = applySeatVersionFilter(versions, [
      { id: "seat-1", version: 6 },
    ]);

    expect(result).toEqual({ accepted: ["seat-1"], stale: [] });
    expect(versions.get("seat-1")).toBe(6);
  });

  it("accepts an unknown seat id with baseline version 0", () => {
    const versions = new Map<string, number>();

    const result = applySeatVersionFilter(versions, [
      { id: "never-seen", version: 1 },
    ]);

    expect(result).toEqual({ accepted: ["never-seen"], stale: [] });
    expect(versions.get("never-seen")).toBe(1);
  });
});

describe("realtime stale messages over /ws", () => {
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

  it("delivers stale wire messages but the client filter rejects them (the server does not filter, by design)", async () => {
    const organizer = await signupUser(harness.app, "ORGANIZER");
    const attendee = await signupUser(harness.app, "ATTENDEE");
    const event = await createPublishedEvent(
      harness.app,
      organizer.accessToken,
      3,
    );

    const [seat] = event.seats;

    if (seat === undefined) {
      throw new Error("Expected a seat");
    }

    const client = await TestSocket.connect(harness.wsUrl);
    const replayClient = new Redis(config.REDIS_URL);

    replayClient.on("error", () => {});

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

      // Establish the real changed state. The live frame must be drained
      // before the crafted replays so each subsequent wait is unambiguous.
      const hold = await holdSeats(
        harness.app,
        attendee.accessToken,
        event.id,
        [seat.id],
      );

      expect(hold.status).toBe(201);
      await client.waitFor(
        (frame) =>
          isSeatUpdateFrame(frame) &&
          (frame as SeatEventMessage).seats.some(
            (update) =>
              update.id === seat.id &&
              update.status === "HELD" &&
              update.version === 1,
          ),
      );

      // D29 reconnect snapshot: rebuild the client version map from
      // `GET /events/:id` (version 1 for the held seat).
      const snapshot = await getEventDetail(
        harness.app,
        attendee.accessToken,
        event.id,
      );
      const versions = mergeSeatSnapshot(new Map<string, number>(), snapshot.seats);

      expect(versions.get(seat.id)).toBe(1);

      const channel = seatEventChannel(event.id);

      async function replayAndReceive(
        payload: SeatEventMessage,
      ): Promise<SeatEventMessage> {
        await replayClient.publish(channel, JSON.stringify(payload));

        const frame = await client.waitFor(
          (candidate) =>
            isSeatUpdateFrame(candidate) &&
            (candidate as SeatEventMessage).seats.some(
              (update) =>
                update.id === seat.id &&
                update.status === payload.seats[0]?.status &&
                update.version === payload.seats[0]?.version,
            ),
          WAITER_TIMEOUT_MS,
        );

        // The server forwarded the message. It never compares versions: this
        // assertion is the explicit proof that filtering is client-side (D29).
        expect(frame.frame).toEqual(payload);

        return frame.frame as SeatEventMessage;
      }

      // Older than the snapshot version: ignored, map stays at 1.
      const older = await replayAndReceive({
        eventId: event.id,
        seats: [{ id: seat.id, status: "AVAILABLE", version: 0 }],
      });

      expect(applySeatVersionFilter(versions, older.seats)).toEqual({
        accepted: [],
        stale: [seat.id],
      });
      expect(versions.get(seat.id)).toBe(1);

      // Same version (duplicate delivery): ignored, map stays at 1.
      const equal = await replayAndReceive({
        eventId: event.id,
        seats: [{ id: seat.id, status: "BOOKED", version: 1 }],
      });

      expect(applySeatVersionFilter(versions, equal.seats)).toEqual({
        accepted: [],
        stale: [seat.id],
      });
      expect(versions.get(seat.id)).toBe(1);

      // Strictly newer: accepted and the map advances.
      const newer = await replayAndReceive({
        eventId: event.id,
        seats: [{ id: seat.id, status: "HELD", version: 2 }],
      });

      expect(applySeatVersionFilter(versions, newer.seats)).toEqual({
        accepted: [seat.id],
        stale: [],
      });
      expect(versions.get(seat.id)).toBe(2);

      // One live frame plus all three crafted frames: the socket genuinely
      // received the stale messages and only the client helper discarded them.
      expect(client.frames.filter(isSeatUpdateFrame)).toHaveLength(4);
    } finally {
      await client.close();
      replayClient.disconnect();
    }
  }, WAITER_TIMEOUT_MS * 4);
});
