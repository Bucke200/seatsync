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
 * the initial `PSUBSCRIBE` must run after the connection is ready; ioredis's
 * `autoResubscribe` re-issues it on reconnects by itself.
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
   * Resolves once the initial `psubscribe("seats:*")` has completed. Tests
   * await it before publishing; production code ignores it. It stays pending
   * while Redis is down.
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

  const ready = new Promise<void>((resolve) => {
    client.on("ready", () => {
      if (stopped) {
        return;
      }

      if (subscribed) {
        // `autoResubscribe` has already re-issued PSUBSCRIBE on a reconnect.
        resolve();
        return;
      }

      subscribed = true;
      void client.psubscribe(SEAT_EVENT_PATTERN).then(
        () => {
          resolve();
        },
        (error: unknown) => {
          // Ready but not subscribed: allow the next reconnect to retry.
          subscribed = false;
          log.warn({ err: error }, "Redis seats:* psubscribe failed; live updates degraded");
        },
      );
    });
  });

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
    client.off("pmessage", onPmessage);

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
