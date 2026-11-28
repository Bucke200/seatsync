import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type {
  CreateEventRequest,
  EventDetail,
  SeatStatus,
  UserRole,
} from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Pool, QueryResultRow } from "pg";
import request from "supertest";
import { WebSocket, type RawData } from "ws";
import { createApp } from "../../src/app";
import type { Config } from "../../src/config";
import type { HoldsRateLimiter } from "../../src/middleware/rateLimit";
import {
  startSeatEventPublisher,
  type SeatEventPublisherHandle,
} from "../../src/realtime/publisher";
import {
  startSeatEventSubscriber,
  type SeatEventSubscriberHandle,
} from "../../src/realtime/subscriber";
import {
  attachRealtimeServer,
  type AttachedRealtimeServer,
} from "../../src/realtime/ws";
import { signAccessToken } from "../../src/services/auth";

/**
 * Shared harness for the Sprint 4 realtime acceptance suites.
 *
 * Everything here is event-driven: waiters resolve on the WebSocket frame,
 * Redis message or HTTP response that proves the step happened. `setTimeout` is
 * only used to bound a waiter so a missing delivery fails the test instead of
 * hanging it; it is never used to "wait for" a real-time effect.
 */

export const TEST_PASSWORD = "password123";

/**
 * Generous waiter bound. The spec threshold (`LIVE_UPDATE_MAX_MS`, 1 000 ms) is
 * asserted separately on the measured arrival time, so a slow CI cannot turn a
 * late-but-correct delivery into a hang, and a genuinely fast delivery still
 * has to meet the design threshold.
 */
export const WAITER_TIMEOUT_MS = 5_000;

export const DEFAULT_SEAT_COUNT = 3;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A grouped seat update frame: `{ eventId, seats: [{ id, status, version }] }`. */
export function isSeatUpdateFrame(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.eventId === "string" &&
    Array.isArray(value.seats)
  );
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

/** Race a promise against a bounded timer so a broken waiter never hangs. */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface ReceivedFrame {
  frame: unknown;
  /** `Date.now()` when the client processed the frame (arrival time). */
  receivedAt: number;
}

export interface CloseInfo {
  code: number;
  reason: string;
}

interface FrameWaiter {
  predicate: (frame: unknown) => boolean;
  resolve: (entry: ReceivedFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function summariseFrames(frames: readonly unknown[]): string {
  const tail = frames.slice(-5);

  try {
    return JSON.stringify(tail);
  } catch {
    return `${tail.length} frames`;
  }
}

/**
 * Minimal `ws` client that records every JSON frame with its arrival time and
 * supports bounded waiters. A socket closed before a waiter is satisfied
 * rejects that waiter instead of leaking it until the test timeout.
 */
export class TestSocket {
  readonly socket: WebSocket;
  readonly frames: unknown[] = [];
  readonly frameTimes: number[] = [];
  private waiters: FrameWaiter[] = [];
  private closeInfo: CloseInfo | null = null;
  private readonly closePromise: Promise<CloseInfo>;
  private closeResolve: (info: CloseInfo) => void = () => {};

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.closePromise = new Promise<CloseInfo>((resolve) => {
      this.closeResolve = resolve;
    });

    socket.on("message", (data) => {
      let frame: unknown;

      try {
        frame = JSON.parse(rawDataToString(data)) as unknown;
      } catch {
        frame = rawDataToString(data);
      }

      const receivedAt = Date.now();

      this.frames.push(frame);
      this.frameTimes.push(receivedAt);

      const remaining: FrameWaiter[] = [];

      for (const waiter of this.waiters) {
        let matches = false;

        try {
          matches = waiter.predicate(frame);
        } catch (error) {
          clearTimeout(waiter.timer);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
          continue;
        }

        if (matches) {
          clearTimeout(waiter.timer);
          waiter.resolve({ frame, receivedAt });
        } else {
          remaining.push(waiter);
        }
      }

      this.waiters = remaining;
    });

    socket.on("close", (code: number, reason: Buffer) => {
      this.closeInfo = { code, reason: reason.toString("utf8") };
      this.closeResolve(this.closeInfo);

      const pending = this.waiters;

      this.waiters = [];

      for (const waiter of pending) {
        clearTimeout(waiter.timer);
        waiter.reject(
          new Error(
            `WebSocket closed (${code}) before the expected frame; received ${summariseFrames(this.frames)}`,
          ),
        );
      }
    });

    // Without an error listener a socket error becomes an unhandled 'error'
    // event; the close event carries the actionable outcome for assertions.
    socket.on("error", () => {});
  }

  static async connect(
    url: string,
    timeoutMs: number = WAITER_TIMEOUT_MS,
  ): Promise<TestSocket> {
    const socket = new WebSocket(url);
    const client = new TestSocket(socket);

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once("open", () => resolve());
        socket.once("error", (error) => reject(error));
      }),
      timeoutMs,
      `WebSocket did not open within ${timeoutMs} ms: ${url}`,
    );

    return client;
  }

  send(message: unknown): void {
    this.socket.send(JSON.stringify(message));
  }

  /**
   * Resolve with the first recorded or future frame matching `predicate`.
   * Searches frames received before the call, so there is no race with a frame
   * that arrived while the test was still preparing.
   */
  waitFor(
    predicate: (frame: unknown) => boolean,
    timeoutMs: number = WAITER_TIMEOUT_MS,
  ): Promise<ReceivedFrame> {
    const index = this.frames.findIndex(predicate);

    if (index !== -1) {
      const frame = this.frames[index];

      if (frame !== undefined) {
        return Promise.resolve({
          frame,
          receivedAt: this.frameTimes[index] ?? Date.now(),
        });
      }
    }

    return new Promise<ReceivedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(
          (candidate) => candidate.resolve !== resolve,
        );
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for a WebSocket frame; received ${summariseFrames(this.frames)}`,
          ),
        );
      }, timeoutMs);

      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  waitForClose(timeoutMs: number = WAITER_TIMEOUT_MS): Promise<CloseInfo> {
    if (this.closeInfo !== null) {
      return Promise.resolve(this.closeInfo);
    }

    return withTimeout(
      this.closePromise,
      timeoutMs,
      `Timed out after ${timeoutMs} ms waiting for the WebSocket to close`,
    );
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

export interface WireEntry {
  channel: string;
  message: string;
}

interface TapWaiter {
  predicate: (entry: WireEntry) => boolean;
  resolve: (entry: WireEntry) => void;
  timer: NodeJS.Timeout;
}

export interface ChannelTap {
  readonly messages: WireEntry[];
  subscribe(): Promise<void>;
  waitFor(
    predicate: (entry: WireEntry) => boolean,
    timeoutMs?: number,
  ): Promise<WireEntry>;
}

/**
 * Wire-tap on one exact Redis channel. Used to prove a message really was
 * published (e.g. while a WebSocket client was disconnected) and to inject
 * hand-crafted payloads through the real subscriber path.
 */
export function createWireTap(client: Redis, channel: string): ChannelTap {
  const messages: WireEntry[] = [];
  let waiters: TapWaiter[] = [];

  client.on("message", (receivedChannel: string, message: string) => {
    const entry: WireEntry = { channel: receivedChannel, message };

    messages.push(entry);

    const remaining: TapWaiter[] = [];

    for (const waiter of waiters) {
      let matches = false;

      try {
        matches = waiter.predicate(entry);
      } catch {
        matches = false;
      }

      if (matches) {
        clearTimeout(waiter.timer);
        waiter.resolve(entry);
      } else {
        remaining.push(waiter);
      }
    }

    waiters = remaining;
  });

  function waitFor(
    predicate: (entry: WireEntry) => boolean,
    timeoutMs: number = WAITER_TIMEOUT_MS,
  ): Promise<WireEntry> {
    const existing = messages.find(predicate);

    if (existing !== undefined) {
      return Promise.resolve(existing);
    }

    return new Promise<WireEntry>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((candidate) => candidate.resolve !== resolve);
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for a Redis message on ${channel}`,
          ),
        );
      }, timeoutMs);

      waiters.push({ predicate, resolve, timer });
    });
  }

  return {
    messages,
    async subscribe(): Promise<void> {
      await client.subscribe(channel);
    },
    waitFor,
  };
}

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

export async function signupUser(
  app: Express,
  role: UserRole,
): Promise<TestUser> {
  const email = `realtime-${randomUUID()}@seatsync.local`;
  const response = await request(app)
    .post("/auth/signup")
    .send({ email, password: TEST_PASSWORD, role });

  if (response.status !== 201) {
    throw new Error(
      `signup for ${role} failed with ${response.status}: ${response.text}`,
    );
  }

  return {
    id: response.body.user.id as string,
    email,
    accessToken: response.body.accessToken as string,
  };
}

interface SeededUserRow extends QueryResultRow {
  id: string;
  email: string;
}

/**
 * D11 bulk seed: one INSERT with a placeholder password hash and JWTs signed
 * directly with the exported service helper. Used where signup latency would
 * dominate (the Redis-down hold race).
 */
export async function seedAttendees(
  pool: Pool,
  config: Config,
  count: number,
  prefix: string = "realtime-race",
): Promise<TestUser[]> {
  const emails: string[] = [];
  const placeholders: string[] = [];

  for (let index = 0; index < count; index += 1) {
    emails.push(`${prefix}-${index}-${randomUUID()}@seatsync.local`);
    placeholders.push(`($${index + 1}, 'race-test-placeholder', 'ATTENDEE')`);
  }

  const inserted = await pool.query<SeededUserRow>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ${placeholders.join(", ")}
     RETURNING id, email`,
    emails,
  );

  if (inserted.rows.length !== count) {
    throw new Error(
      `expected to seed ${count} attendees, inserted ${inserted.rows.length}`,
    );
  }

  const idByEmail = new Map(
    inserted.rows.map((row) => [row.email, row.id] as const),
  );

  return emails.map((email) => {
    const id = idByEmail.get(email);

    if (id === undefined) {
      throw new Error(`seeded attendee ${email} is missing its id`);
    }

    return {
      id,
      email,
      accessToken: signAccessToken(config, { id, email, role: "ATTENDEE" }),
    };
  });
}

export interface TestSeat {
  id: string;
  number: number;
  status: SeatStatus;
  version?: number;
}

/** Create + publish an event through the real REST surface. */
export async function createPublishedEvent(
  app: Express,
  accessToken: string,
  seatsPerRow: number = DEFAULT_SEAT_COUNT,
): Promise<{ id: string; seats: TestSeat[] }> {
  const payload: CreateEventRequest = {
    title: "Realtime acceptance",
    venue: "Main hall",
    startsAt: "2027-10-01T18:00:00.000Z",
    sections: [
      { name: "Floor", rows: 1, seatsPerRow, pricePaise: 2500 },
    ],
  };

  const created = await request(app)
    .post("/events")
    .set("Authorization", `Bearer ${accessToken}`)
    .send(payload);

  if (created.status !== 201) {
    throw new Error(
      `event creation failed with ${created.status}: ${created.text}`,
    );
  }

  const published = await request(app)
    .post(`/events/${created.body.id}/publish`)
    .set("Authorization", `Bearer ${accessToken}`);

  if (published.status !== 200) {
    throw new Error(
      `event publish failed with ${published.status}: ${published.text}`,
    );
  }

  return {
    id: created.body.id as string,
    seats: created.body.seats as TestSeat[],
  };
}

export function holdSeats(
  app: Express,
  accessToken: string,
  eventId: string,
  seatIds: string[],
  idempotencyKey: string = randomUUID(),
) {
  return request(app)
    .post(`/events/${eventId}/holds`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("Idempotency-Key", idempotencyKey)
    .send({ seatIds });
}

export async function getEventDetail(
  app: Express,
  accessToken: string,
  eventId: string,
): Promise<EventDetail> {
  const response = await request(app)
    .get(`/events/${eventId}`)
    .set("Authorization", `Bearer ${accessToken}`);

  if (response.status !== 200) {
    throw new Error(
      `event detail failed with ${response.status}: ${response.text}`,
    );
  }

  return response.body as EventDetail;
}

export interface BootTestAppOptions {
  config: Config;
  pool: Pool;
  redis: Redis;
  /** Optional test/child logger; defaults to the process logger. */
  log?: Logger;
  /** Protocol-only suites can skip pub/sub entirely. */
  startPubSub?: boolean;
  /**
   * Override the config the publisher/subscriber use (e.g. a Redis URL at a
   * closed port to simulate an outage without touching Docker).
   */
  pubSubConfig?: Config;
  /**
   * Default true. `false` is for deliberate Redis-outage boots: readiness is
   * surfaced through the handles, and both keep retrying in the background.
   */
  awaitPubSubReady?: boolean;
}

export interface TestHarness {
  app: Express;
  server: Server;
  port: number;
  wsUrl: string;
  realtime: AttachedRealtimeServer;
  publisher: SeatEventPublisherHandle | null;
  subscriber: SeatEventSubscriberHandle | null;
  /** Simulated outage recovery: stop the current pair and start a fresh one. */
  restartPubSub(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Boot the real Express app on an ephemeral port and attach the real `/ws`
 * server, optionally with the real publisher/subscriber pair pointed at the
 * compose Redis. Mirrors `server.ts` wiring without starting the jobs.
 */
export async function bootTestApp(
  options: BootTestAppOptions,
): Promise<TestHarness> {
  const { config, pool, redis, log } = options;
  const app = createApp({ pool, redis, config });
  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, () => {
      resolve(listener);
    });
  });
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected an ephemeral TCP port");
  }

  const port = address.port;
  const realtime = attachRealtimeServer(server, { config, log });

  let publisher: SeatEventPublisherHandle | null = null;
  let subscriber: SeatEventSubscriberHandle | null = null;

  async function startPubSub(awaitReady: boolean): Promise<void> {
    const pubSubConfig = options.pubSubConfig ?? config;
    const nextPublisher = startSeatEventPublisher({
      config: pubSubConfig,
      logger: log,
    });
    const nextSubscriber = startSeatEventSubscriber({
      config: pubSubConfig,
      hub: realtime.hub,
      logger: log,
    });

    publisher = nextPublisher;
    subscriber = nextSubscriber;

    const ready = Promise.all([nextPublisher.ready, nextSubscriber.ready]);

    if (awaitReady) {
      try {
        await ready;
      } catch (error) {
        throw new Error(
          "realtime pub/sub is unavailable; these tests require a running Redis",
          { cause: error },
        );
      }
    } else {
      // Both handles attach internal no-op catches; this is the test-side
      // catch for the combined readiness, so a deliberate outage can never
      // produce an unhandled rejection.
      void ready.catch(() => {});
    }
  }

  async function stopPubSub(): Promise<void> {
    const currentPublisher = publisher;
    const currentSubscriber = subscriber;

    publisher = null;
    subscriber = null;

    if (currentPublisher !== null) {
      await currentPublisher.stop();
    }

    if (currentSubscriber !== null) {
      await currentSubscriber.stop();
    }
  }

  if (options.startPubSub !== false) {
    await startPubSub(options.awaitPubSubReady !== false);
  }

  async function restartPubSub(): Promise<void> {
    await stopPubSub();
    await startPubSub(true);
  }

  async function close(): Promise<void> {
    // D33: `createApp` owns a dedicated limiter connection unless the caller
    // injected one. Close it after pub/sub and before the WS attachment / HTTP
    // drain, mirroring `server.ts` (stop traffic sources, then auxiliary Redis
    // clients, then pool/health teardown in the caller). `close()` is
    // idempotent, so a caller that already closed an injected limiter is safe.
    const limiter = app.locals["holdsRateLimiter"] as HoldsRateLimiter | undefined;

    await stopPubSub();

    if (limiter !== undefined) {
      await limiter.close();
    }

    await realtime.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    server.closeAllConnections();
  }

  return {
    app,
    server,
    port,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    realtime,
    get publisher() {
      return publisher;
    },
    get subscriber() {
      return subscriber;
    },
    restartPubSub,
    close,
  };
}
