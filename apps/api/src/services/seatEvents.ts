import { EventEmitter } from "node:events";
import type { SeatStatus } from "@seatsync/shared";

/**
 * In-process seat-change notifications (Rule 5).
 *
 * This module is deliberately pure: it imports nothing from `src/` (only the
 * Node event emitter and a type from `@seatsync/shared`), so both `src/db` and
 * `src/services` can emit without creating a layering cycle. Nothing listens
 * yet; Sprint 4 will subscribe and fan these events out over WebSockets/Redis.
 *
 * Emission contract: callers emit only AFTER `COMMIT`. A transaction that may
 * roll back must never emit, or clients would see a change that never existed.
 */

export interface SeatChange {
  eventId: string;
  seatIds: string[];
  status: SeatStatus;
  version: number;
}

export interface SeatEventMap {
  seatChange: [change: SeatChange];
}

/**
 * Typed emitter. Subscription example:
 * `seatEvents.on("seatChange", (change) => { ... })`.
 */
export const seatEvents: EventEmitter<SeatEventMap> = new EventEmitter<SeatEventMap>();

/**
 * Emit one change after its transaction has committed.
 *
 * Version semantics (D14): `version` is the exact `seats.version` returned by
 * the UPDATE for this seat. Because versions are per-row (Rule 7), a change to
 * several seats is emitted as one event per seat — each carrying its own
 * truthful version — rather than one grouped event that could not name a
 * single version.
 */
export function emitSeatChange(change: SeatChange): void {
  seatEvents.emit("seatChange", change);
}
