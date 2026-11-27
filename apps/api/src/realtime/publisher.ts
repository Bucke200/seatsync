import type { SeatStatus } from "@seatsync/shared";
import type { Redis } from "ioredis";
import type { Logger } from "pino";
import type { Config } from "../config";
import { logger as defaultLogger } from "../logger";
import { seatEvents, type SeatChange } from "../services/seatEvents";
import { createPubSubPublisher } from "./redis";

/**
 * Sprint 4 realtime seat map — in-process emitter -> Redis publisher (D27).
 *
 * `seatEvents` emits one change per seat (D14), synchronously after COMMIT
 * (Rule 5). Publishing one Redis message per seat would multiply wire traffic
 * for a multi-seat hold, so same-tick emissions are grouped per `eventId` and
 * flushed once per microtask. The batch is only a transport detail: every seat
 * keeps the exact `version` its own `UPDATE ... RETURNING` produced (Rule 7,
 * D14), and clients still filter per seat (D29).
 *
 * Redis is never required for correctness (design §60-69). A failed publish is
 * logged and dropped; it must never throw into an emitter call-site, because
 * that call-site is a hold/booking/webhook request that has already committed.
 */

/** Redis channel carrying one event's grouped seat changes. */
export const SEAT_EVENT_CHANNEL_PREFIX = "seats:";

/** `PSUBSCRIBE` pattern matching every event channel. */
export const SEAT_EVENT_PATTERN = `${SEAT_EVENT_CHANNEL_PREFIX}*`;

/** One seat inside the wire payload; `version` is that seat's own version. */
export interface SeatUpdate {
  id: string;
  status: SeatStatus;
  version: number;
}

/** Grouped wire payload: `{ eventId, seats: [{ id, status, version }] }`. */
export interface SeatEventMessage {
  eventId: string;
  seats: SeatUpdate[];
}

export interface StartSeatEventPublisherOptions {
  config: Config;
  /** Optional test/child logger; defaults to the process logger. */
  logger?: Logger;
}

export interface SeatEventPublisherHandle {
  /**
   * Settles exactly once and therefore can never hang:
   * - resolves when the publisher's Redis connection first becomes usable;
   * - rejects with a clear error when the first connection attempt fails while
   *   still connecting, or when `stop()` runs before readiness.
   *
   * Production ignores it (the handle attaches an internal no-op catch, so a
   * Redis-down boot cannot produce an unhandled rejection). Tests own the only
   * await and should treat a rejection as "Redis is unavailable" rather than
   * waiting forever. Messages published while Redis is down are dropped, never
   * queued.
   */
  ready: Promise<void>;
  /** Stop listening to `seatEvents`, drop pending work and disconnect. */
  stop(): Promise<void>;
}

/** Channel for one event's updates, shared with the subscriber/tests. */
export function seatEventChannel(eventId: string): string {
  return `${SEAT_EVENT_CHANNEL_PREFIX}${eventId}`;
}

export function startSeatEventPublisher({
  config,
  logger: log = defaultLogger,
}: StartSeatEventPublisherOptions): SeatEventPublisherHandle {
  // Dedicated connection (D26): never the shared `/health` client.
  const client: Redis = createPubSubPublisher(config, log);

  /** eventId -> seatId -> latest same-tick update; later writes win. */
  const pending = new Map<string, Map<string, SeatUpdate>>();
  let flushScheduled = false;
  let stopped = false;

  /** Readiness settles exactly once: resolve on 'ready', reject on failure/stop. */
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

  function onReady(): void {
    if (readySettled) {
      return;
    }

    readySettled = true;
    detachReadyListeners();
    resolveReady();
  }

  function onReadyError(error: Error): void {
    if (readySettled) {
      return;
    }

    // First connection error before readiness: fail fast instead of leaving
    // `ready` pending forever. `retryStrategy` still reconnects in the
    // background, but this handle's readiness was already falsified.
    readySettled = true;
    detachReadyListeners();
    rejectReady(
      new Error(`Redis pub/sub publisher was not ready: ${error.message}`, { cause: error }),
    );
  }

  client.once("ready", onReady);
  client.on("error", onReadyError);

  function flush(): void {
    flushScheduled = false;

    if (stopped) {
      pending.clear();
      return;
    }

    // Snapshot and clear before publishing so emissions that happen while a
    // publish rejection is being handled start a fresh microtask batch.
    const batches = [...pending.entries()];

    pending.clear();

    for (const [eventId, seatsById] of batches) {
      const payload: SeatEventMessage = {
        eventId,
        // Deterministic seat order is a transport detail; versions are not
        // re-derived or grouped, so D14 truthfulness is preserved.
        seats: [...seatsById.values()].sort((left, right) =>
          left.id.localeCompare(right.id),
        ),
      };

      let serialized: string;

      try {
        serialized = JSON.stringify(payload);
      } catch (error) {
        log.warn({ err: error, eventId }, "seat update serialisation failed; batch dropped");
        continue;
      }

      try {
        void client.publish(seatEventChannel(eventId), serialized).catch((error) => {
          // Redis outages are expected (Rule 64): degrade, never propagate.
          log.warn(
            { err: error, eventId, seatCount: payload.seats.length },
            "seat update publish failed; live update dropped",
          );
        });
      } catch (error) {
        // Defensive: publish normally rejects rather than throws, but a
        // synchronous failure must not escape into the HTTP request path.
        log.warn({ err: error, eventId }, "seat update publish failed; live update dropped");
      }
    }
  }

  function onSeatChange(change: SeatChange): void {
    if (stopped) {
      return;
    }

    let seatsById = pending.get(change.eventId);

    if (seatsById === undefined) {
      seatsById = new Map<string, SeatUpdate>();
      pending.set(change.eventId, seatsById);
    }

    // D14 emissions carry one seatId today; iterating makes the grouping
    // correct even if a future emitter groups seats itself.
    for (const seatId of change.seatIds) {
      seatsById.set(seatId, {
        id: seatId,
        status: change.status,
        version: change.version,
      });
    }

    if (!flushScheduled) {
      flushScheduled = true;
      queueMicrotask(flush);
    }
  }

  seatEvents.on("seatChange", onSeatChange);

  // Open the connection eagerly. Failures keep retrying in the background via
  // `retryStrategy`; publishes attempted before `ready` reject and are dropped.
  void client.connect().catch((error) => {
    log.warn({ err: error }, "Redis pub/sub publisher connect failed; retrying in background");
  });

  async function stop(): Promise<void> {
    if (stopped) {
      return;
    }

    stopped = true;
    seatEvents.off("seatChange", onSeatChange);
    pending.clear();
    // The already-queued microtask (if any) observes `stopped` and no-ops.
    flushScheduled = false;
    // Remove the readiness listeners *before* disconnecting: a 'ready' or
    // 'error' emitted by the dying client must not settle `ready` afterwards.
    detachReadyListeners();

    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Redis pub/sub publisher stopped before becoming ready"));
    }

    client.disconnect();
  }

  return { ready, stop };
}
