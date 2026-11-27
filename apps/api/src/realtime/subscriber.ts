import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { z } from "zod";
import { SeatStatusSchema } from "@seatsync/shared";
import type { Config } from "../config";
import { logger as defaultLogger } from "../logger";
import {
  SEAT_EVENT_CHANNEL_PREFIX,
  SEAT_EVENT_PATTERN,
  type SeatEventMessage,
} from "./publisher";
import { createPubSubSubscriber } from "./redis";
import type { RealtimeHub } from "./ws";

/**
 * Sprint 4 realtime seat map — Redis subscriber -> WebSocket room fan-out.
 *
 * One dedicated subscriber connection per API instance (D26): `PSUBSCRIBE`
 * permanently puts an ioredis connection into subscriber mode, so the shared
 * `/health` client can never be used here. With `enableOfflineQueue: false`
 * the initial `PSUBSCRIBE` must run after the connection is ready; the explicit
 * `autoResubscribe: true` option re-issues it on reconnects by itself.
 *
 * Every failure is logged and swallowed: a corrupt message or Redis outage
 * must never crash the API, and a dropped live update is acceptable because
 * Redis is optional for correctness (design §60-69). The REST snapshot remains
 * authoritative and reconnecting clients refetch it (D29).
 */

const SeatUpdateWireSchema = z.object({
  id: z.string().uuid(),
  status: SeatStatusSchema,
  version: z.number().int().nonnegative(),
});

const SeatEventMessageSchema = z.object({
  eventId: z.string().uuid(),
  seats: z.array(SeatUpdateWireSchema).min(1),
});

export interface StartSeatEventSubscriberOptions {
  config: Config;
  /** This attachment's room hub (returned by `attachRealtimeServer`). */
  hub: RealtimeHub;
  /** Optional test/child logger; defaults to the process logger. */
  logger?: Logger;
}

export interface SeatEventSubscriberHandle {
  /**
   * Settles exactly once and therefore can never hang:
   * - resolves once the initial `psubscribe("seats:*")` has completed;
   * - rejects with a clear error on the first connection error before that, if
   *   the initial `psubscribe` fails, or when `stop()` runs before readiness.
   *
   * Production ignores it (the handle attaches an internal no-op catch, so a
   * Redis-down boot cannot produce an unhandled rejection). Tests own the only
   * await and should treat a rejection as "Redis is unavailable". After a
   * rejection the subscriber still retries in the background on reconnect.
   */
  ready: Promise<void>;
  /** Unsubscribe, detach listeners and disconnect. Safe to call twice. */
  stop(): Promise<void>;
}

export function startSeatEventSubscriber({
  config,
  hub,
  logger: log = defaultLogger,
}: StartSeatEventSubscriberOptions): SeatEventSubscriberHandle {
  // Dedicated connection (D26): never the shared `/health` client.
  const client: Redis = createPubSubSubscriber(config, log);

  let subscribed = false;
  let stopped = false;

  /** Readiness settles exactly once: resolve on subscribe, reject otherwise. */
  let readySettled = false;
  let resolveReady: () => void = () => {};
  let rejectReady: (error: Error) => void = () => {};

  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  // Readiness is informational in production; only tests await it. Attach a
  // no-op rejection handler immediately so a Redis-down boot never raises an
  // unhandled rejection. Consumers still observe the rejection themselves.
  void ready.catch(() => {});

  /** Detach the readiness listeners so a stopped client cannot settle later. */
  function detachReadyListeners(): void {
    client.off("ready", onReady);
    client.off("error", onReadyError);
  }

  function settleReady(): void {
    if (readySettled) {
      return;
    }

    readySettled = true;
    detachReadyListeners();
    resolveReady();
  }

  function failReady(error: Error): void {
    if (readySettled) {
      return;
    }

    readySettled = true;
    // Keep the 'ready' listener: `subscribed` goes back to false, so a later
    // reconnect can still establish the subscription even though `ready`
    // already settled as failed. Only the readiness error listener goes away,
    // so the failure is reported once.
    client.off("error", onReadyError);
    rejectReady(error);
  }

  function onReady(): void {
    if (stopped) {
      return;
    }

    if (subscribed) {
      // `autoResubscribe` has already re-issued PSUBSCRIBE on a reconnect.
      settleReady();
      return;
    }

    subscribed = true;
    void client.psubscribe(SEAT_EVENT_PATTERN).then(
      () => {
        settleReady();
      },
      (error: unknown) => {
        // Ready but not subscribed: allow the next reconnect to retry.
        subscribed = false;
        log.warn({ err: error }, "Redis seats:* psubscribe failed; live updates degraded");
        failReady(
          new Error(
            `Redis pub/sub subscriber psubscribe failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
            { cause: error },
          ),
        );
      },
    );
  }

  function onReadyError(error: Error): void {
    if (stopped) {
      return;
    }

    failReady(
      new Error(`Redis pub/sub subscriber was not ready: ${error.message}`, { cause: error }),
    );
  }

  client.on("ready", onReady);
  client.on("error", onReadyError);

  function onPmessage(_pattern: string, channel: string, message: string): void {
    // pmessage itself must never throw: an unhandled 'error' from the emitter
    // would take down a process that is still serving committed bookings.
    try {
      if (!channel.startsWith(SEAT_EVENT_CHANNEL_PREFIX)) {
        return;
      }

      const eventId = channel.slice(SEAT_EVENT_CHANNEL_PREFIX.length);

      if (eventId.length === 0) {
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(message) as unknown;
      } catch {
        log.warn(
          { channel, bytes: message.length },
          "Redis seat update was not valid JSON; message dropped",
        );
        return;
      }

      const result = SeatEventMessageSchema.safeParse(parsed);

      if (!result.success) {
        log.warn(
          { channel, issues: result.error.issues },
          "Redis seat update did not match the wire schema; message dropped",
        );
        return;
      }

      if (result.data.eventId !== eventId) {
        log.warn(
          { channel, payloadEventId: result.data.eventId },
          "Redis seat update eventId does not match its channel; message dropped",
        );
        return;
      }

      hub.broadcast(eventId, result.data satisfies SeatEventMessage);
    } catch (error) {
      log.warn({ err: error, channel }, "Failed to handle Redis seat update");
    }
  }

  client.on("pmessage", onPmessage);

  // `lazyConnect` + no offline queue: start the connection, then subscribe
  // from 'ready'. If the first connect fails, retryStrategy keeps reconnecting.
  void client.connect().catch((error) => {
    log.warn({ err: error }, "Redis pub/sub subscriber connect failed; retrying in background");
  });

  async function stop(): Promise<void> {
    if (stopped) {
      return;
    }

    stopped = true;
    // Remove the readiness listeners *before* disconnecting: a 'ready' or
    // 'error' emitted by the dying client must not settle `ready` afterwards.
    detachReadyListeners();
    client.off("pmessage", onPmessage);

    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Redis pub/sub subscriber stopped before becoming ready"));
    }

    if (client.status === "ready") {
      try {
        await client.punsubscribe(SEAT_EVENT_PATTERN);
      } catch (error) {
        log.warn({ err: error }, "Redis seats:* punsubscribe failed during shutdown");
      }
    }

    client.disconnect();
  }

  return { ready, stop };
}
