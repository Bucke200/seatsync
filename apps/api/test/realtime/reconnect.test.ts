import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type { SeatStatus } from "@seatsync/shared";
import { mergeSeatSnapshot } from "@seatsync/shared";
import { Redis } from "ioredis";
import type { Pool, QueryResultRow } from "pg";
import pino from "pino";
import request from "supertest";
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
  createWireTap,
  getEventDetail,
  holdSeats,
  isRecord,
  isSeatUpdateFrame,
  signupUser,
  type TestHarness,
} from "./helpers";

/**
 * `design.md:343` — reconnect acceptance check.
 *
 * A websocket is not a durable subscription: a disconnected client misses every
 * message published while it was away, and Redis does not replay them. D29's
 * recovery mechanism is therefore a snapshot refetch: after re-authenticating
 * and resubscribing, the client calls `GET /events/:id` and rebuilds its seat
 * state and version map from the database, which must match the database
 * exactly.
 *
 * This test makes those missed messages visible with a Redis wire tap: it
 * proves the changes really were published while the socket was closed, then
 * proves the reconnected socket did NOT receive them and that the snapshot
 * resync produces the database state.
 */

interface SeatStateRow extends QueryResultRow {
  id: string;
  status: SeatStatus;
  version: number;
}

function byId(
  left: { id: string },
  right: { id: string },
): number {
  return left.id.localeCompare(right.id);
}

function parseSeatMessage(message: string): SeatEventMessage {
  return JSON.parse(message) as SeatEventMessage;
}

describe("realtime reconnect snapshot resync", () => {
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

  it("reconnects to the database state after missing 3 changes, via snapshot resync", async () => {
    const organizer = await signupUser(harness.app, "ORGANIZER");
    const attendee = await signupUser(harness.app, "ATTENDEE");
    const event = await createPublishedEvent(
      harness.app,
      organizer.accessToken,
      3,
    );

    const [heldSeat, untouchedSeat] = event.seats;

    if (heldSeat === undefined || untouchedSeat === undefined) {
      throw new Error("Expected at least two seats");
    }

    // The tap is subscribed before the disconnect so every change made during
    // the gap is recorded; it proves the messages were published, not dropped.
    const tapClient = new Redis(config.REDIS_URL);

    tapClient.on("error", () => {});

    const channel = seatEventChannel(event.id);
    const tap = createWireTap(tapClient, channel);

    await tap.subscribe();

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

      await client.close();

      // Three committed changes while the client is disconnected:
      // hold (v1 HELD) -> release (v2 AVAILABLE) -> hold again (v3 HELD).
      const firstHold = await holdSeats(
        harness.app,
        attendee.accessToken,
        event.id,
        [heldSeat.id],
      );

      expect(firstHold.status).toBe(201);

      const release = await request(harness.app)
        .delete(`/holds/${firstHold.body.holdId as string}`)
        .set("Authorization", `Bearer ${attendee.accessToken}`);

      expect(release.status).toBe(204);

      const secondHold = await holdSeats(
        harness.app,
        attendee.accessToken,
        event.id,
        [heldSeat.id],
      );

      expect(secondHold.status).toBe(201);

      // The tap receiving version 3 proves all three publishes happened; Redis
      // preserves per-connection order, so versions 1 and 2 arrived first.
      await tap.waitFor((entry) =>
        parseSeatMessage(entry.message).seats.some(
          (update) => update.id === heldSeat.id && update.version === 3,
        ),
      );

      const publishedVersions = tap.messages.map((entry) => {
        const payload = parseSeatMessage(entry.message);
        const update = payload.seats[0];

        if (update === undefined) {
          throw new Error("Expected one seat in a published update");
        }

        return update.version;
      });

      expect(publishedVersions).toEqual([1, 2, 3]);

      // Reconnect exactly as the web client does after a drop: a fresh socket,
      // same (still valid) access token, re-auth + resubscribe. A socket can
      // outlive the 15-minute token TTL, which is why the real client refreshes
      // the token first (covered by auth.test.ts); the shape is identical.
      const reconnected = await TestSocket.connect(harness.wsUrl);

      try {
        reconnected.send({ type: "auth", token: attendee.accessToken });
        await reconnected.waitFor(
          (frame) => isRecord(frame) && frame.type === "auth_ok",
        );

        reconnected.send({ type: "subscribe", eventId: event.id });
        await reconnected.waitFor(
          (frame) =>
            isRecord(frame) &&
            frame.type === "subscribed" &&
            frame.eventId === event.id,
        );

        // The missed messages are genuinely missed: Redis did not replay them
        // to the new socket, so there is nothing to filter here. Snapshot
        // resync below is the only recovery path (D29).
        expect(reconnected.frames.filter(isSeatUpdateFrame)).toEqual([]);

        const snapshot = await getEventDetail(
          harness.app,
          attendee.accessToken,
          event.id,
        );

        const database = await pool.query<SeatStateRow>(
          `SELECT id, status, version
             FROM seats
            WHERE event_id = $1
            ORDER BY id`,
          [event.id],
        );

        const snapshotState = snapshot.seats
          .map((seat) => ({
            id: seat.id,
            status: seat.status,
            version: seat.version,
          }))
          .sort(byId);

        const databaseState = database.rows
          .map((row) => ({
            id: row.id,
            status: row.status,
            version: row.version,
          }))
          .sort(byId);

        // The client's derived seat state equals the database.
        expect(snapshotState).toEqual(databaseState);

        // The client's version map, rebuilt with the shared D29 helper, equals
        // the database versions.
        const versions = mergeSeatSnapshot(
          new Map<string, number>(),
          snapshot.seats,
        );
        const databaseVersions = new Map(
          database.rows.map((row) => [row.id, row.version] as const),
        );

        expect([...versions.entries()].sort()).toEqual(
          [...databaseVersions.entries()].sort(),
        );

        // Explicit final state: the held seat's three changes are reflected,
        // the untouched seat still has version 0.
        expect(versions.get(heldSeat.id)).toBe(3);
        expect(versions.get(untouchedSeat.id)).toBe(0);

        expect(
          snapshot.seats.find((seat) => seat.id === heldSeat.id),
        ).toMatchObject({ status: "HELD", version: 3 });
        expect(
          snapshot.seats.find((seat) => seat.id === untouchedSeat.id),
        ).toMatchObject({ status: "AVAILABLE", version: 0 });

        // Re-assert after the snapshot round-trips: no late delivery appeared.
        expect(reconnected.frames.filter(isSeatUpdateFrame)).toEqual([]);
      } finally {
        await reconnected.close();
      }
    } finally {
      await client.close();
      tapClient.disconnect();
    }
  }, WAITER_TIMEOUT_MS * 4);
});
