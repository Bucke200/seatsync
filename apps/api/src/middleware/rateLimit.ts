import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Config } from "../config";
import { logger } from "../logger";
import { createRateLimitRedisClient } from "../realtime/redis";
import { ApiError } from "./errors";

/**
 * D33 / design §362 — per-user fail-open Redis rate limit for holds.
 *
 * The limiter is keyed strictly by the authenticated `user.id` that
 * `requireAuth` put on the request, never by IP or a global counter: the
 * Sprint 2 race is 200 different users holding at once, and a global/IP limit
 * would turn it into 429s. It runs after `requireAuth` and before
 * `readIdempotencyKey` / `parseHoldRequest` / `pool.connect()`, so a rejected
 * request never touches Postgres or `idempotency_keys`.
 *
 * Every authenticated attempt is counted, including attempts that later fail
 * validation (422) or the second-hold/availability checks (409). Counting
 * before validation is the documented choice: the limit protects the request
 * path itself, and an attempt that reaches Redis has already paid the auth
 * cost. Requests that fail authentication never reach this middleware.
 *
 * IMPORTANT replay semantics (D33 design caveat, do not "fix" by moving this
 * middleware after the idempotency claim): because the limiter runs before
 * `readIdempotencyKey`, a replay of a stored 201/409 by a user whose counter is
 * already exhausted returns `429 RATE_LIMITED`, not the stored response. The
 * Sprint 2/D2 contract "same key + same body always replays the stored
 * outcome" is therefore conditional on the fixed 60 s rate window: within
 * budget a replay keeps the stored response; once over budget, even a
 * byte-for-byte replay is 429 until the next window.
 *
 * Redis is never required for correctness (design Rules 60–69): every Redis
 * operation is wrapped in `try/catch`, a not-yet-connected client is treated as
 * unavailable, and a live-but-unresponsive command is bounded by a deadline.
 * Every failure path logs a throttled warning and calls `next()`. There is no
 * code path in which a Redis failure rejects or blocks a hold.
 */

/** Fixed 60 s window; the key carries the UTC epoch minute. */
const HOLD_RATE_LIMIT_WINDOW_SECONDS = 60;
const HOLD_RATE_LIMIT_WINDOW_MS = HOLD_RATE_LIMIT_WINDOW_SECONDS * 1_000;
const HOLD_RATE_LIMIT_KEY_PREFIX = "holds:rl:";

/**
 * A Redis outage lasts seconds to minutes; one warning per failed request would
 * flood the log. Warnings are emitted at most once per this interval per
 * limiter instance.
 */
const RATE_LIMIT_WARN_INTERVAL_MS = 30_000;

/**
 * Deadline for the limiter's EVAL (D33 fail-open). Connection-level failures
 * reject quickly because the offline queue is disabled, but a connection that
 * is `ready` while the server stops replying (slow/hung Redis, packet loss)
 * would otherwise hold the hold request open indefinitely. 1.5 s is far above
 * a healthy local/Upstash p99 yet well under a user-visible hold delay; a
 * timeout is handled exactly like a Redis error (throttled warn + allow). The
 * command may still complete server-side after the deadline; the request just
 * stops waiting for it.
 */
const RATE_LIMIT_REDIS_TIMEOUT_MS = 1_500;

/**
 * Atomic increment + expiry. A Lua script makes INCR and the first-hit EXPIRE
 * one round trip and one indivisible operation, so a counter can never be
 * created without a TTL (a TTL-less key would lock a user out forever). The
 * EXPIRE runs only when INCR returns 1; later hits keep the original TTL
 * instead of extending the window on every request.
 */
const INCREMENT_WITH_EXPIRY_LUA = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

/**
 * Race an operation against a deadline. The timer is always cleared once the
 * race settles (resolve, reject or timeout), so no timer outlives the request.
 * The loser of the race is the caller's responsibility to observe; `increment`
 * attaches a no-op rejection handler to the EVAL before racing it.
 */
async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export interface HoldsRateLimitOptions {
  config: Pick<Config, "REDIS_URL" | "HOLDS_RATE_LIMIT_PER_MINUTE">;
  logger?: Logger;
  /**
   * Test/override seam. When supplied, the limiter uses (and owns) this client
   * instead of creating one from `config.REDIS_URL`.
   */
  client?: Redis;
}

/**
 * Callable Express middleware with its lifecycle exposed.
 *
 * `client` lets tests simulate an outage (disconnect it) and inspect/delete
 * keys; `close()` is idempotent and used by tests and `server.ts` shutdown.
 */
export interface HoldsRateLimiter extends RequestHandler {
  client: Redis;
  close(): Promise<void>;
}

/**
 * Build the key for the fixed window containing `nowMs`:
 *
 *   holds:rl:<userId>:<epochMinuteUtc>
 *
 * Exported as the test seam for the window-rollover assertion: a test can
 * delete the exact key instead of waiting up to 60 real seconds (design Rule
 * 68 forbids time-based waits). The default clock is only read in production
 * code; the optional timestamp is a pure parameter.
 */
export function holdsRateLimitKey(
  userId: string,
  nowMs: number = Date.now(),
): string {
  const epochMinute = Math.floor(nowMs / HOLD_RATE_LIMIT_WINDOW_MS);

  return `${HOLD_RATE_LIMIT_KEY_PREFIX}${userId}:${epochMinute}`;
}

export function createHoldsRateLimiter(
  options: HoldsRateLimitOptions,
): HoldsRateLimiter {
  const { config } = options;
  const log = options.logger ?? logger;
  const client =
    options.client ?? createRateLimitRedisClient(config, log);

  if (client.status === "wait") {
    // Start the auxiliary connection without awaiting it. If Redis is down the
    // first requests fail open and the client keeps retrying in the background.
    void client.connect().catch(() => {
      // The client's `error` listener reports the outage; nothing may propagate.
    });
  }

  let lastWarnAt = 0;

  /** Throttled fail-open warning; never throws. */
  function warnUnavailable(error: unknown): void {
    const now = Date.now();

    if (now - lastWarnAt < RATE_LIMIT_WARN_INTERVAL_MS) {
      return;
    }

    lastWarnAt = now;
    log.warn(
      { err: error },
      "holds rate limiter unavailable; allowing request (fail-open)",
    );
  }

  async function increment(key: string): Promise<number> {
    if (client.status !== "ready") {
      throw new Error(`rate limit Redis client is ${client.status}, not ready`);
    }

    const command = client.eval(
      INCREMENT_WITH_EXPIRY_LUA,
      1,
      key,
      HOLD_RATE_LIMIT_WINDOW_SECONDS,
    );

    // If the deadline wins, the command can still settle later (a late
    // rejection would otherwise be unhandled). A late success is ignored by
    // the already-settled race; nothing after the timeout may throw.
    void command.catch(() => {
      // Reported by the timeout's throttled warn, not from this guard.
    });

    const reply: unknown = await withDeadline(
      command,
      RATE_LIMIT_REDIS_TIMEOUT_MS,
      `rate limit Redis command did not answer within ${RATE_LIMIT_REDIS_TIMEOUT_MS} ms`,
    );
    const count = typeof reply === "number" ? reply : Number(reply);

    if (!Number.isInteger(count)) {
      throw new Error("rate limit Redis script returned a non-integer count");
    }

    return count;
  }

  async function run(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    const userId = req.user?.id;

    // requireAuth already rejected anonymous requests; this is defensive only.
    if (userId === undefined) {
      next();
      return;
    }

    const limit = config.HOLDS_RATE_LIMIT_PER_MINUTE;
    let count: number;

    try {
      count = await increment(holdsRateLimitKey(userId));
    } catch (error) {
      warnUnavailable(error);
      next();
      return;
    }

    if (count > limit) {
      next(
        new ApiError(
          429,
          "RATE_LIMITED",
          `Too many hold requests; at most ${limit} per minute`,
          { limit, windowSeconds: HOLD_RATE_LIMIT_WINDOW_SECONDS },
        ),
      );
      return;
    }

    next();
  }

  const limiter = ((req: Request, res: Response, next: NextFunction): void => {
    // Belt and braces: `run` itself never throws for a Redis failure, but an
    // unexpected bug must still fail open instead of hanging the request.
    void run(req, res, next).catch((error: unknown) => {
      warnUnavailable(error);
      next();
    });
  }) as HoldsRateLimiter;

  limiter.client = client;
  limiter.close = async (): Promise<void> => {
    if (client.status === "wait") {
      client.disconnect();
      return;
    }

    // ioredis arms a 2 s connector-cleanup timer if `disconnect()` is called on
    // an already-ended client; leave it alone.
    if (client.status === "end") {
      return;
    }

    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  };

  return limiter;
}
