import { randomUUID } from "node:crypto";
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
  isRecord,
  isSeatUpdateFrame,
  signupUser,
  type TestHarness,
} from "./helpers";

/**
 * `design.md:340` — multi-instance acceptance check.
 *
 * Two API instances share the compose Postgres and Redis, but each one owns a
 * separate Postgres pool, shared health client, publisher, subscriber and `/ws`
 * server, exactly like two `server.ts` processes. Nothing is mocked: a REST
 * hold/release is sent over real HTTP to instance 2's ephemeral port, and the
 * assertions read the frames a client subscribed on instance 1 (and instance 2)
 * actually received through Redis.
 *
 * Same-process caveat: `seatEvents` is a process-global emitter, so both
 * publishers may publish the same committed change. That cannot fake the
 * delivery asserted here: the WS hub is only ever fed by the Redis subscriber,
 * so a frame arriving on a socket proves the Redis `seats:*` fan-out path.
 *
 * All waits are event-driven; the only timers are the 5 s waiter bounds. The
 * design threshold (`LIVE_UPDATE_MAX_MS`) is asserted on arrival-minus-send.
 */

interface HoldBody {
  holdId: string;
  seatIds: string[];
  heldUntil: string;
}

interface HttpResult {
  status: number;
  body: unknown;
  text: string;
}

/** JSON request against an instance's real ephemeral HTTP port (not its app). */
async function requestThroughPort(
  harness: TestHarness,
  path: string,
  init: RequestInit,
): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${harness.port}${path}`, init);
  const text = await response.text();
  let body: unknown = null;

  if (text.length > 0) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = null;
    }
  }

  return { status: response.status, body, text };
}

function holdThroughInstance(
  harness: TestHarness,
  accessToken: string,
  eventId: string,
  seatIds: string[],
): Promise<HttpResult> {
  return requestThroughPort(harness, `/events/${eventId}/holds`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Idempotency-Key": randomUUID(),
    },
    body: JSON.stringify({ seatIds }),
  });
}

function releaseThroughInstance(
  harness: TestHarness,
  accessToken: string,
  holdId: string,
): Promise<HttpResult> {
  return requestThroughPort(harness, `/holds/${holdId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

function requireHoldBody(result: HttpResult): HoldBody {
  if (result.body === null || typeof result.body !== "object") {
    throw new Error(`Expected a hold body, got: ${result.text}`);
  }

  return result.body as HoldBody;
}

/** Open a socket, authenticate and subscribe to one event's room. */
async function subscribeOn(
  harness: TestHarness,
  accessToken: string,
  eventId: string,
): Promise<TestSocket> {
  const client = await TestSocket.connect(harness.wsUrl);

  try {
    client.send({ type: "auth", token: accessToken });
    await client.waitFor(
      (frame) => isRecord(frame) && frame.type === "auth_ok",
    );

    client.send({ type: "subscribe", eventId });
    await client.waitFor(
      (frame) =>
        isRecord(frame) &&
        frame.type === "subscribed" &&
        frame.eventId === eventId,
    );

    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

function asSeatEvent(frame: unknown): SeatEventMessage {
  return frame as SeatEventMessage;
}

describe("realtime across two API instances", () => {
  const log = pino({ level: "silent" });

  let config: Config;
  let poolA: Pool;
  let poolB: Pool;
  let redisA: Redis;
  let redisB: Redis;
  let instanceA: TestHarness;
  let instanceB: TestHarness;

  beforeAll(async () => {
    config = loadConfig(process.env);
    // Two separate pools: each instance behaves like its own process.
    poolA = createPool(config);
    poolB = createPool(config);
    redisA = createRedisClient(config);
    redisB = createRedisClient(config);
    instanceA = await bootTestApp({
      config,
      pool: poolA,
      redis: redisA,
      log,
    });
    instanceB = await bootTestApp({
      config,
      pool: poolB,
      redis: redisB,
      log,
    });
  });

  beforeEach(async () => {
    // One pool is enough: both instances share the same Postgres database.
    await truncateAll(poolA);
  });

  afterEach(async () => {
    await truncateAll(poolA);
  });

  afterAll(async () => {
    await instanceA.close();
    await instanceB.close();
    redisA.disconnect();
    redisB.disconnect();
    await poolA.end();
    await poolB.end();
  });

  it("delivers a hold made through instance 2 to a client subscribed on instance 1", async () => {
    const organizer = await signupUser(instanceA.app, "ORGANIZER");
    const attendee = await signupUser(instanceA.app, "ATTENDEE");
    const event = await createPublishedEvent(
      instanceA.app,
      organizer.accessToken,
      3,
    );

    const [first, second] = event.seats;

    if (first === undefined || second === undefined) {
      throw new Error("Expected at least two seats");
    }

    const client = await subscribeOn(
      instanceA,
      attendee.accessToken,
      event.id,
    );

    try {
      // Everything from here on is cross-instance: the committed change is
      // produced by instance 2's HTTP request path, and instance 1 only learns
      // about it through the shared Redis `seats:{eventId}` channel.
      const sendTime = Date.now();
      const hold = await holdThroughInstance(
        instanceB,
        attendee.accessToken,
        event.id,
        [first.id, second.id],
      );

      expect(hold.status).toBe(201);

      const holdBody = requireHoldBody(hold);

      expect(holdBody.seatIds).toHaveLength(2);

      const message = await client.waitFor(isSeatUpdateFrame);
      const elapsed = message.receivedAt - sendTime;

      // Spec threshold, not the waiter bound.
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(elapsed).toBeLessThan(config.LIVE_UPDATE_MAX_MS);

      const payload = asSeatEvent(message.frame);

      expect(payload.eventId).toBe(event.id);
      expect(payload.seats.map((seat) => seat.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );

      // Instance 1's own REST snapshot is the reference for the versions the
      // client received; a different instance wrote them.
      const snapshot = await getEventDetail(
        instanceA.app,
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
        // Rule 7 / D29: the wire version is the committed version.
        expect(update.version).toBe(snapshotSeat.version);
        expect(snapshotSeat.status).toBe("HELD");
      }
    } finally {
      await client.close();
    }
  }, WAITER_TIMEOUT_MS * 2);

  it("broadcasts a change made through instance 2 to clients subscribed on both instances", async () => {
    const organizer = await signupUser(instanceA.app, "ORGANIZER");
    const attendee = await signupUser(instanceA.app, "ATTENDEE");
    const event = await createPublishedEvent(
      instanceA.app,
      organizer.accessToken,
      3,
    );

    const [seat] = event.seats;

    if (seat === undefined) {
      throw new Error("Expected at least one seat");
    }

    // The hold is created through instance 2 before either client subscribes,
    // so the only frame each client can observe is the release below.
    const hold = await holdThroughInstance(
      instanceB,
      attendee.accessToken,
      event.id,
      [seat.id],
    );

    expect(hold.status).toBe(201);

    const holdId = requireHoldBody(hold).holdId;
    const clientA = await subscribeOn(
      instanceA,
      attendee.accessToken,
      event.id,
    );
    const clientB = await subscribeOn(
      instanceB,
      attendee.accessToken,
      event.id,
    );

    try {
      const sendTime = Date.now();
      const release = await releaseThroughInstance(
        instanceB,
        attendee.accessToken,
        holdId,
      );

      expect(release.status).toBe(204);

      // Both subscribers receive the same Redis message: one through instance
      // 1's subscriber (cross-instance) and one through instance 2's subscriber
      // (the instance that handled the REST call).
      const [messageA, messageB] = await Promise.all([
        clientA.waitFor(isSeatUpdateFrame),
        clientB.waitFor(isSeatUpdateFrame),
      ]);

      for (const message of [messageA, messageB]) {
        const elapsed = message.receivedAt - sendTime;

        expect(elapsed).toBeGreaterThanOrEqual(0);
        expect(elapsed).toBeLessThan(config.LIVE_UPDATE_MAX_MS);
      }

      const payloadA = asSeatEvent(messageA.frame);
      const payloadB = asSeatEvent(messageB.frame);

      expect(payloadA).toEqual(payloadB);
      expect(payloadA.eventId).toBe(event.id);
      expect(payloadA.seats).toHaveLength(1);

      const [update] = payloadA.seats;

      if (update === undefined) {
        throw new Error("Expected one seat update");
      }

      expect(update.id).toBe(seat.id);
      expect(update.status).toBe("AVAILABLE");

      const snapshot = await getEventDetail(
        instanceA.app,
        attendee.accessToken,
        event.id,
      );
      const snapshotSeat = snapshot.seats.find(
        (candidate) => candidate.id === seat.id,
      );

      if (snapshotSeat === undefined) {
        throw new Error(`Snapshot is missing seat ${seat.id}`);
      }

      expect(snapshotSeat.status).toBe("AVAILABLE");
      expect(update.version).toBe(snapshotSeat.version);
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
    }
  }, WAITER_TIMEOUT_MS * 2);
});
