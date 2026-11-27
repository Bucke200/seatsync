import { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Config } from "../config";
import { logger } from "../logger";

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
