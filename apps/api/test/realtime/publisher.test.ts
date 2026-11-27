import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { CreateEventRequest, SeatStatus, UserRole } from "@seatsync/shared";
import type { Express } from "express";
import { Redis } from "ioredis";
import type { Pool } from "pg";
import pino from "pino";
import request from "supertest";
import { WebSocket, type RawData } from "ws";
import { createApp } from "../../src/app";
import { loadConfig, type Config } from "../../src/config";
import { createPool } from "../../src/db/pool";
import {
  seatEventChannel,
  startSeatEventPublisher,
  type SeatEventMessage,
  type SeatEventPublisherHandle,
} from "../../src/realtime/publisher";
import { createRedisClient } from "../../src/realtime/redis";
import {
  startSeatEventSubscriber,
  type SeatEventSubscriberHandle,
} from "../../src/realtime/subscriber";
import {
  attachRealtimeServer,
  type AttachedRealtimeServer,
} from "../../src/realtime/ws";
import { emitSeatChange, type SeatChange } from "../../src/services/seatEvents";
import { truncateAll } from "../helpers/db";

/**
 * Step 2 wiring test (D26, D27, D14): `seatEvents` -> publisher -> Redis ->
 * subscriber -> `/ws` room broadcast.
 *
 * Everything is event-driven: waiters resolve on the Redis `message` or
 * WebSocket frame that proves the step happened, so there are no fixed sleeps.
 * A plain ioredis connection acts as a wire-tap on the exact `seats:<eventId>`
 * channel, which proves the publisher groups same-tick emissions into a single
 * Redis publish rather than only proving that one message eventually arrived.
 */

const PASSWORD = "password123";
const SEAT_COUNT = 3;

interface SeatRow {
  id: string;
  number: number;
  status: SeatStatus;
}

interface WireMessage {
  channel: string;
  message: string;
}

interface TapWaiter {
  predicate: (entry: WireMessage) => boolean;
  resolve: (entry: WireMessage) => void;
}

interface FrameWaiter {
  predicate: (frame: unknown) => boolean;
  resolve: (frame: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") {
    return data;
  }

  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }

  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }

  return data.toString("utf8");
}

function parseSeatMessage(message: string): SeatEventMessage {
  return JSON.parse(message) as SeatEventMessage;
}

function isSeatUpdateFrame(frame: unknown): boolean {
  return isRecord(frame) && typeof frame.eventId === "string" && Array.isArray(frame.seats);
}

/** Minimal `ws` client that records every JSON frame and supports waiters. */
class TestSocket {
  readonly socket: WebSocket;
  readonly frames: unknown[] = [];
  private waiters: FrameWaiter[] = [];

  private constructor(socket: WebSocket) {
    this.socket = socket;

    socket.on("message", (data) => {
      let frame: unknown;

      try {
        frame = JSON.parse(rawDataToString(data)) as unknown;
      } catch {
        frame = rawDataToString(data);
      }

      this.frames.push(frame);

      const ready = this.waiters.filter((waiter) => waiter.predicate(frame));

      this.waiters = this.waiters.filter((waiter) => !waiter.predicate(frame));

      for (const waiter of ready) {
        waiter.resolve(frame);
      }
    });
  }

  static async connect(url: string): Promise<TestSocket> {
    const socket = new WebSocket(url);
    const client = new TestSocket(socket);

    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", (error) => reject(error));
    });

    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(predicate: (frame: unknown) => boolean): Promise<unknown> {
    const existing = this.frames.find(predicate);

    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise<unknown>((resolve) => {
      this.waiters.push({ predicate, resolve });
    });
  }

  close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.socket.once("close", () => resolve());
      this.socket.close();
    });
  }
}

/** Wire-tap: records raw `message` events on one exact channel. */
function createWireTap(client: Redis, channel: string) {
  const messages: WireMessage[] = [];
  let waiters: TapWaiter[] = [];

  client.on("message", (receivedChannel: string, message: string) => {
    const entry: WireMessage = { channel: receivedChannel, message };

    messages.push(entry);

    const ready = waiters.filter((waiter) => waiter.predicate(entry));

    waiters = waiters.filter((waiter) => !waiter.predicate(entry));

    for (const waiter of ready) {
      waiter.resolve(entry);
    }
  });

  function waitFor(predicate: (entry: WireMessage) => boolean): Promise<WireMessage> {
    const existing = messages.find(predicate);

    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise<WireMessage>((resolve) => {
      waiters.push({ predicate, resolve });
    });
  }

  return {
    messages,
    subscribe: () => client.subscribe(channel),
    waitFor,
  };
}

describe("realtime publisher/subscriber", () => {
  const log = pino({ level: "silent" });

  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;
  let server: Server;
  let port: number;
  let realtime: AttachedRealtimeServer;
  let publisher: SeatEventPublisherHandle;
  let subscriber: SeatEventSubscriberHandle;

  beforeAll(async () => {
    config = loadConfig(process.env);
    pool = createPool(config);
    redis = createRedisClient(config);
    app = createApp({ pool, redis, config });

    server = await new Promise<Server>((resolve) => {
      const listener = app.listen(0, () => {
        resolve(listener);
      });
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an ephemeral TCP port");
    }

    port = address.port;
    realtime = attachRealtimeServer(server, { config, log });
    publisher = startSeatEventPublisher({ config, logger: log });
    subscriber = startSeatEventSubscriber({ config, hub: realtime.hub, logger: log });

    // Both connections are ready before any test publishes, so the first
    // message cannot race the pub/sub handshake. A Redis-down environment
    // rejects instead of leaving `ready` pending, so fail fast and clearly
    // rather than hanging the suite; teardown still runs.
    try {
      await Promise.all([publisher.ready, subscriber.ready]);
    } catch (error) {
      throw new Error(
        "realtime pub/sub is unavailable; these tests require a running Redis",
        { cause: error },
      );
    }
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await subscriber.stop();
    await publisher.stop();
    await realtime.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
    redis.disconnect();
    await pool.end();
  });

  async function signupUser(
    role: UserRole,
  ): Promise<{ id: string; email: string; accessToken: string }> {
    const email = `realtime-${randomUUID()}@seatsync.local`;
    const response = await request(app)
      .post("/auth/signup")
      .send({ email, password: PASSWORD, role });

    expect(response.status).toBe(201);

    return {
      id: response.body.user.id,
      email,
      accessToken: response.body.accessToken,
    };
  }

  function eventPayload(): CreateEventRequest {
    return {
      title: "Realtime night",
      venue: "Main hall",
      startsAt: "2027-10-01T18:00:00.000Z",
      sections: [{ name: "Floor", rows: 1, seatsPerRow: SEAT_COUNT, pricePaise: 2500 }],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
  ): Promise<{ id: string; seats: SeatRow[] }> {
    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(eventPayload());

    expect(created.status).toBe(201);

    const published = await request(app)
      .post(`/events/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(published.status).toBe(200);

    return {
      id: created.body.id,
      seats: created.body.seats as SeatRow[],
    };
  }

  async function connectSubscribed(
    accessToken: string,
    eventId: string,
  ): Promise<TestSocket> {
    const client = await TestSocket.connect(`ws://127.0.0.1:${port}/ws`);

    client.send({ type: "auth", token: accessToken });
    await client.waitFor(
      (frame) => isRecord(frame) && frame.type === "auth_ok",
    );

    client.send({ type: "subscribe", eventId });
    await client.waitFor(
      (frame) =>
        isRecord(frame) && frame.type === "subscribed" && frame.eventId === eventId,
    );

    return client;
  }

  it("groups same-tick seat changes into one publish and broadcasts the batch", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    expect(event.seats).toHaveLength(SEAT_COUNT);

    const [first, second, third] = event.seats;

    if (first === undefined || second === undefined || third === undefined) {
      throw new Error("Expected three seats");
    }

    const socket = await connectSubscribed(attendee.accessToken, event.id);
    const wireTap = new Redis(config.REDIS_URL);
    const sentinelClient = new Redis(config.REDIS_URL);
    const channel = seatEventChannel(event.id);
    const sentinel = `flush-${randomUUID()}`;

    // Both helper connections must never crash the test on a Redis error.
    wireTap.on("error", () => {});
    sentinelClient.on("error", () => {});

    try {
      const tap = createWireTap(wireTap, channel);

      await tap.subscribe();

      const changes: SeatChange[] = [
        { eventId: event.id, seatIds: [first.id], status: "HELD", version: 5 },
        { eventId: event.id, seatIds: [second.id], status: "BOOKED", version: 2 },
        { eventId: event.id, seatIds: [third.id], status: "AVAILABLE", version: 7 },
      ];

      // Same tick: the publisher must group these into exactly one publish.
      for (const change of changes) {
        emitSeatChange(change);
      }

      const firstWireMessage = await tap.waitFor(
        (entry) => entry.channel === channel,
      );

      expect(firstWireMessage.channel).toBe(channel);

      const payload = parseSeatMessage(firstWireMessage.message);
      const expectedSeats = [
        { id: first.id, status: "HELD" as const, version: 5 },
        { id: second.id, status: "BOOKED" as const, version: 2 },
        { id: third.id, status: "AVAILABLE" as const, version: 7 },
      ].sort((left, right) => left.id.localeCompare(right.id));

      expect(payload).toEqual({ eventId: event.id, seats: expectedSeats });

      // The WS room receives the same grouped payload (step 1 hub fan-out).
      const frame = await socket.waitFor(isSeatUpdateFrame);

      expect(frame).toEqual(payload);

      // Ordering sentinel: a plain client publishes after the batch on the
      // same channel. Redis preserves per-connection order, so every publish
      // the buggy alternative would have made (one per seat) is already in the
      // wire-tap's message list when this sentinel arrives.
      await sentinelClient.publish(channel, sentinel);
      await tap.waitFor((entry) => entry.message === sentinel);

      const seatMessages = tap.messages.filter((entry) => entry.message !== sentinel);

      expect(seatMessages).toHaveLength(1);

      const wsSeatFrames = socket.frames.filter(isSeatUpdateFrame);

      expect(wsSeatFrames).toEqual([payload]);
    } finally {
      await socket.close();
      wireTap.disconnect();
      sentinelClient.disconnect();
    }
  });

  it("keeps only the later write when the same seat changes twice in one tick (D27)", async () => {
    const organizer = await signupUser("ORGANIZER");
    const event = await createPublishedEvent(organizer.accessToken);

    const [seat] = event.seats;

    if (seat === undefined) {
      throw new Error("Expected a seat");
    }

    const wireTap = new Redis(config.REDIS_URL);
    const sentinelClient = new Redis(config.REDIS_URL);
    const channel = seatEventChannel(event.id);
    const sentinel = `latest-${randomUUID()}`;

    // Both helper connections must never crash the test on a Redis error.
    wireTap.on("error", () => {});
    sentinelClient.on("error", () => {});

    try {
      const tap = createWireTap(wireTap, channel);

      await tap.subscribe();

      // Same synchronous tick: the publisher's per-event/microtask batch sees
      // both writes, and the per-seat map must keep only the later one.
      emitSeatChange({
        eventId: event.id,
        seatIds: [seat.id],
        status: "AVAILABLE",
        version: 2,
      });
      emitSeatChange({
        eventId: event.id,
        seatIds: [seat.id],
        status: "HELD",
        version: 3,
      });

      const message = await tap.waitFor((entry) => entry.channel === channel);

      expect(parseSeatMessage(message.message)).toEqual({
        eventId: event.id,
        seats: [{ id: seat.id, status: "HELD", version: 3 }],
      });

      // Sentinel: any further publish queued for this event would arrive before
      // it on the same Redis connection, so exactly one batch must exist.
      await sentinelClient.publish(channel, sentinel);
      await tap.waitFor((entry) => entry.message === sentinel);

      const seatMessages = tap.messages.filter((entry) => entry.message !== sentinel);

      expect(seatMessages).toHaveLength(1);
    } finally {
      wireTap.disconnect();
      sentinelClient.disconnect();
    }
  });

  it("ignores corrupt and oversized Redis messages without breaking the live socket", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [seat] = event.seats;

    if (seat === undefined) {
      throw new Error("Expected a seat");
    }

    const socket = await connectSubscribed(attendee.accessToken, event.id);
    const corruptPublisher = new Redis(config.REDIS_URL);

    corruptPublisher.on("error", () => {});

    try {
      const channel = seatEventChannel(event.id);
      const before = socket.frames.length;

      // Oversized, invalid JSON (parse failure path).
      await corruptPublisher.publish(channel, "x".repeat(128 * 1024));

      // Valid JSON but the wrong wire shape (schema failure path).
      await corruptPublisher.publish(
        channel,
        JSON.stringify({ eventId: event.id, seats: "not-an-array" }),
      );

      // Same connection, so Redis delivers the garbage first. If the
      // subscriber forwarded anything, it would arrive before this marker.
      const marker: SeatEventMessage = {
        eventId: event.id,
        seats: [{ id: seat.id, status: "HELD", version: 1 }],
      };

      await corruptPublisher.publish(channel, JSON.stringify(marker));

      const frame = await socket.waitFor(
        (candidate) =>
          isSeatUpdateFrame(candidate) &&
          (candidate as SeatEventMessage).seats.some(
            (update) => update.id === seat.id && update.version === 1,
          ),
      );

      expect(frame).toEqual(marker);
      expect(socket.frames.slice(before)).toEqual([marker]);
      expect(socket.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await socket.close();
      corruptPublisher.disconnect();
    }
  });
});
