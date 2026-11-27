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
import { WebSocket } from "ws";
import { loadConfig, type Config } from "../../src/config";
import { createPool } from "../../src/db/pool";
import { createRedisClient } from "../../src/realtime/redis";
import { truncateAll } from "../helpers/db";
import {
  TestSocket,
  bootTestApp,
  isRecord,
  signupUser,
  type TestHarness,
} from "./helpers";

/**
 * D28 protocol lock for `/ws`.
 *
 * These cases pin the observable handshake contract that the live/reconnect
 * suites (and the web client) depend on:
 *
 *   - the first message must be `{ type: "auth", token }`; no anonymous mode;
 *   - a bad token, a non-auth first message and a pre-auth subscribe all reply
 *     UNAUTHORIZED and close 1008;
 *   - protocol noise after authentication (duplicate auth, unknown types) gets
 *     BAD_MESSAGE but never kills a live feed;
 *   - a malformed subscribe (non-UUID) is fatal (BAD_MESSAGE + close 1008);
 *   - subscribe rooms are event-scoped and deliberately not validated against
 *     the database, so an unknown-but-valid UUID is accepted.
 *
 * No Redis publisher/subscriber is started: this suite only exercises sockets.
 */

function frameIs(type: string) {
  return (frame: unknown): boolean => isRecord(frame) && frame.type === type;
}

function frameIsError(code: string) {
  return (frame: unknown): boolean =>
    isRecord(frame) && frame.type === "error" && frame.code === code;
}

function frameIsSubscribed(eventId: string) {
  return (frame: unknown): boolean =>
    isRecord(frame) && frame.type === "subscribed" && frame.eventId === eventId;
}

describe("realtime /ws protocol (D28)", () => {
  const log = pino({ level: "silent" });

  let pool: Pool;
  let redis: Redis;
  let config: Config;
  let harness: TestHarness;
  let accessToken: string;

  beforeAll(async () => {
    config = loadConfig(process.env);
    pool = createPool(config);
    redis = createRedisClient(config);
    harness = await bootTestApp({
      config,
      pool,
      redis,
      log,
      startPubSub: false,
    });

    // The token is verified statelessly, so truncating the users table between
    // tests does not invalidate it; one real signup is enough.
    const user = await signupUser(harness.app, "ATTENDEE");

    accessToken = user.accessToken;
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

  async function connect(): Promise<TestSocket> {
    return TestSocket.connect(harness.wsUrl);
  }

  async function authenticate(client: TestSocket): Promise<void> {
    client.send({ type: "auth", token: accessToken });
    await client.waitFor(frameIs("auth_ok"));
  }

  it("acknowledges a valid token with auth_ok and keeps the socket open", async () => {
    const client = await connect();

    try {
      client.send({ type: "auth", token: accessToken });

      const ack = await client.waitFor(frameIs("auth_ok"));

      expect(ack.frame).toEqual({ type: "auth_ok" });
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
      expect(client.frames.some(frameIsError("UNAUTHORIZED"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("rejects a bad token with UNAUTHORIZED and close 1008", async () => {
    const client = await connect();

    try {
      client.send({ type: "auth", token: "definitely-not-a-jwt" });

      const error = await client.waitFor(frameIsError("UNAUTHORIZED"));

      expect(error.frame).toMatchObject({
        type: "error",
        code: "UNAUTHORIZED",
        message: expect.any(String),
      });

      const closed = await client.waitForClose();

      expect(closed.code).toBe(1008);
      expect(client.frames.some(frameIs("auth_ok"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("rejects a non-auth first message with UNAUTHORIZED and close 1008", async () => {
    const client = await connect();

    try {
      // Never anonymous: even a syntactically valid frame is not an identity.
      client.send({ type: "hello" });

      const error = await client.waitFor(frameIsError("UNAUTHORIZED"));

      expect(error.frame).toMatchObject({
        type: "error",
        code: "UNAUTHORIZED",
      });

      const closed = await client.waitForClose();

      expect(closed.code).toBe(1008);
      expect(client.frames.some(frameIs("auth_ok"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("rejects a pre-auth subscribe with UNAUTHORIZED and close 1008", async () => {
    const client = await connect();

    try {
      client.send({ type: "subscribe", eventId: randomUUID() });

      const error = await client.waitFor(frameIsError("UNAUTHORIZED"));

      expect(error.frame).toMatchObject({
        type: "error",
        code: "UNAUTHORIZED",
      });

      const closed = await client.waitForClose();

      expect(closed.code).toBe(1008);
      expect(client.frames.some(frameIs("auth_ok"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("answers a duplicate auth with BAD_MESSAGE and keeps the socket usable", async () => {
    const client = await connect();

    try {
      await authenticate(client);

      client.send({ type: "auth", token: accessToken });

      const error = await client.waitFor(frameIsError("BAD_MESSAGE"));

      expect(error.frame).toEqual({
        type: "error",
        code: "BAD_MESSAGE",
        message: "Already authenticated",
      });

      // Still open and still processing: a late subscribe must work.
      expect(client.socket.readyState).toBe(WebSocket.OPEN);

      const eventId = randomUUID();

      client.send({ type: "subscribe", eventId });
      await client.waitFor(frameIsSubscribed(eventId));
    } finally {
      await client.close();
    }
  });

  it("treats a non-UUID subscribe as fatal (BAD_MESSAGE + close 1008)", async () => {
    const client = await connect();

    try {
      await authenticate(client);

      client.send({ type: "subscribe", eventId: "not-a-uuid" });

      const error = await client.waitFor(frameIsError("BAD_MESSAGE"));

      expect(error.frame).toMatchObject({
        type: "error",
        code: "BAD_MESSAGE",
        message: "subscribe requires a UUID eventId",
      });

      const closed = await client.waitForClose();

      expect(closed.code).toBe(1008);
    } finally {
      await client.close();
    }
  });

  it("answers an unknown post-auth type with BAD_MESSAGE and stays open", async () => {
    const client = await connect();

    try {
      await authenticate(client);

      client.send({ type: "live-feed-v2" });

      const error = await client.waitFor(frameIsError("BAD_MESSAGE"));

      expect(error.frame).toEqual({
        type: "error",
        code: "BAD_MESSAGE",
        message: "Unknown message type: live-feed-v2",
      });

      expect(client.socket.readyState).toBe(WebSocket.OPEN);

      const eventId = randomUUID();

      client.send({ type: "subscribe", eventId });
      await client.waitFor(frameIsSubscribed(eventId));
    } finally {
      await client.close();
    }
  });

  it("accepts an unknown-but-valid-UUID eventId: rooms are event-scoped, not DB-validated", async () => {
    const client = await connect();

    try {
      await authenticate(client);

      const eventId = randomUUID();

      client.send({ type: "subscribe", eventId });

      const ack = await client.waitFor(frameIsSubscribed(eventId));

      // Current (and intended D28) behaviour: subscribing never touches the
      // database. An event id that does not exist is still a valid room name;
      // no seat updates will ever be published to it.
      expect(ack.frame).toEqual({ type: "subscribed", eventId });
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await client.close();
    }
  });
});
