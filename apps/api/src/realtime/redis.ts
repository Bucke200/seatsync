import { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Config } from "../config";
import { logger } from "../logger";

/**
 * Pub/sub reconnect backoff (D26): start at 250 ms and double per failed
 * attempt, capped at 5 s so a long Redis outage never produces a hot retry
 * loop or an unbounded delay.
 */
const PUBSUB_RETRY_BASE_MS = 250;
const PUBSUB_RETRY_MAX_MS = 5_000;

/** ioredis calls `retryStrategy` with a 1-based attempt counter. */
function pubSubRetryStrategy(attempt: number): number {
  return Math.min(PUBSUB_RETRY_BASE_MS * 2 ** (attempt - 1), PUBSUB_RETRY_MAX_MS);
}

/** Dedicated clients: a subscriber-mode ioredis connection cannot run PING. */
export interface PubSubClients {
  publisher: Redis;
  subscriber: Redis;
}

/** Shared resilience options for every pub/sub connection (D26). */
const PUBSUB_CLIENT_OPTIONS = {
  lazyConnect: true,
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  // Explicit rather than relying on the library default: a reconnect must
  // re-issue the subscriber's PSUBSCRIBE (D26) without application help.
  autoResubscribe: true,
  retryStrategy: pubSubRetryStrategy,
} as const;

function attachErrorLogger(client: Redis, log: Logger, label: string): void {
  // Mandatory: without an `error` listener ioredis emits an unhandled event
  // and crashes the process when Redis is down.
  client.on("error", (error) => {
    log.warn({ err: error }, `${label}; live updates degraded`);
  });
}

/**
 * Create one dedicated publisher connection (D26).
 *
 * Step 2 exposes single-client factories so the publisher and subscriber each
 * own exactly one connection; creating a pair for every role would leak an
 * unused client per process. Both factories apply the identical resilience
 * settings described on `createPubSubClients`.
 */
export function createPubSubPublisher(config: Config, log: Logger = logger): Redis {
  const client = new Redis(config.REDIS_URL, PUBSUB_CLIENT_OPTIONS);
  attachErrorLogger(client, log, "Redis pub/sub publisher error");
  return client;
}

/** Create one dedicated subscriber connection (D26). */
export function createPubSubSubscriber(config: Config, log: Logger = logger): Redis {
  const client = new Redis(config.REDIS_URL, PUBSUB_CLIENT_OPTIONS);
  attachErrorLogger(client, log, "Redis pub/sub subscriber error");
  return client;
}

/**
 * Create the dedicated Redis client for the per-user hold rate limiter (D33).
 *
 * It copies the fail-soft template used by the shared and pub/sub clients
 * (lazy connect, no offline command queue, one retry per command, logging-only
 * `error` listener) and is deliberately separate from both: a limiter outage
 * must never degrade `/health` or the realtime fan-out. The socket is
 * `unref()`ed on every connect because this connection is auxiliary: the HTTP
 * server keeps the production process alive, while a test worker can exit
 * without an explicit close.
 */
export function createRateLimitRedisClient(
  config: Pick<Config, "REDIS_URL">,
  log: Logger = logger,
): Redis {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  client.on("error", (error) => {
    log.warn({ err: error }, "Redis rate limiter error; hold requests fail open");
  });

  // `connect` fires again after every successful reconnect, so the replacement
  // socket is unref'ed too.
  client.on("connect", () => {
    client.stream.unref();
  });

  return client;
}

/**
 * Create the shared Redis client.
 *
 * Redis is never required for correctness, so the client must never block or
 * crash the API: it connects lazily, refuses to queue commands while offline
 * and gives each command at most one retry.
 */
export function createRedisClient(config: Config, log: Logger = logger): Redis {
  const client = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });

  // Without a listener, ioredis emits 'error' as an unhandled event and the
  // process crashes. Logging keeps Redis outages non-fatal.
  client.on("error", (error) => {
    log.warn({ err: error }, "Redis error; live updates are degraded but bookings stay correct");
  });

  return client;
}

/**
 * Create the two dedicated pub/sub clients the realtime layer needs (D26).
 *
 * They must never reuse the shared `/health` client: `PSUBSCRIBE` puts an
 * ioredis connection into subscriber mode, where ordinary commands such as
 * `PING` are rejected. Both clients copy the shared client's resilience
 * settings (lazy connect, no offline command queue, one retry per request, a
 * logging-only `error` listener) and add a capped exponential reconnect
 * backoff, so Redis outages stay non-fatal for holds, bookings and webhooks.
 *
 * `enableOfflineQueue: false` means commands issued before the connection is
 * ready reject instead of queueing. The subscriber therefore must not
 * `psubscribe` while connecting; step 2 issues the initial subscription from
 * the client's `ready` event. That is safe on reconnects: ioredis
 * (`autoResubscribe`, default true) re-issues `PSUBSCRIBE` from `readyHandler`
 * after the status has already flipped to `ready`, so the command writes on a
 * live stream even with the offline queue disabled. An initial `connect()`
 * rejection also keeps retrying because connection close runs the configured
 * `retryStrategy`.
 */
export function createPubSubClients(config: Config, log: Logger = logger): PubSubClients {
  return {
    publisher: createPubSubPublisher(config, log),
    subscriber: createPubSubSubscriber(config, log),
  };
}

/**
 * Health check helper: PING Redis and report the result as a boolean.
 *
 * With `lazyConnect` the first command opens the connection, so do that
 * explicitly and surface any failure as "unhealthy" instead of throwing.
 */
export async function pingRedis(client: Redis): Promise<boolean> {
  try {
    if (client.status === "wait") {
      await client.connect();
    }

    const reply = await client.ping();
    return reply === "PONG";
  } catch {
    return false;
  }
}
