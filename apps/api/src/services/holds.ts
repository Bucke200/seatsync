import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Config } from "../config";
import {
  holdSeatsWithIdempotency,
  releaseHoldSeats,
  type HoldRequestOutcome,
} from "../db/seats";
import { ApiError } from "../middleware/errors";

/**
 * The config slice the hold path reads. `HOLDS_RATE_LIMIT_PER_MINUTE` is used
 * by the route's limiter (D33), not by `createHold`, but it belongs to the hold
 * contract and is wired from the environment (Rule 65), never hard-coded.
 */
export type HoldsConfig = Pick<
  Config,
  "HOLD_TTL_SECONDS" | "MAX_SEATS_PER_HOLD" | "HOLDS_RATE_LIMIT_PER_MINUTE"
>;

export interface CreateHoldInput {
  userId: string;
  eventId: string;
  seatIds: string[];
  idempotencyKey: string;
}

export interface ReleaseHoldInput {
  userId: string;
  holdId: string;
}

/**
 * D2 canonical body hash: sha256 hex of the compact JSON
 *
 *   {"eventId":"<uuid>","seatIds":["<uuid>", ...]}
 *
 * Keys appear in the literal order `eventId`, `seatIds`; seat ids are sorted
 * ascending (JavaScript string order) and duplicates are rejected before this
 * runs, so the same set of seats in any request order hashes identically.
 */
export function hashHoldRequest(eventId: string, seatIds: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ eventId, seatIds: [...seatIds].sort() }))
    .digest("hex");
}

/**
 * D7 defence in depth. The route already zod-parses every id as a UUID; the
 * service re-checks the seat-count and uniqueness rules so a direct caller
 * cannot bypass them.
 */
function validateSeatIds(seatIds: string[], maxSeats: number): void {
  if (seatIds.length < 1) {
    throw new ApiError(422, "VALIDATION_ERROR", "At least one seat is required");
  }

  if (seatIds.length > maxSeats) {
    throw new ApiError(
      422,
      "TOO_MANY_SEATS",
      `A hold may contain at most ${maxSeats} seats`,
    );
  }

  if (new Set(seatIds).size !== seatIds.length) {
    throw new ApiError(422, "VALIDATION_ERROR", "seatIds must not contain duplicates");
  }
}

/**
 * Orchestrate one hold request: validate D7, build the D2 canonical hash and
 * D1 hold id, then delegate the transaction, idempotency claim, row locking and
 * 409 body construction to the Step 2 db layer. Both a fresh `201` and a
 * stored `409` are returned as data so the route can replay them verbatim.
 */
export async function createHold(
  pool: Pool,
  config: HoldsConfig,
  input: CreateHoldInput,
): Promise<HoldRequestOutcome> {
  validateSeatIds(input.seatIds, config.MAX_SEATS_PER_HOLD);

  return holdSeatsWithIdempotency(pool, {
    eventId: input.eventId,
    seatIds: input.seatIds,
    userId: input.userId,
    holdId: randomUUID(),
    holdTtlSeconds: config.HOLD_TTL_SECONDS,
    idempotencyKey: input.idempotencyKey,
    bodyHash: hashHoldRequest(input.eventId, input.seatIds),
  });
}

/**
 * D1 release: the db helper locks the hold's seats, enforces holder-only
 * access (403) and treats a missing/expired hold as 404.
 */
export async function releaseHold(pool: Pool, input: ReleaseHoldInput): Promise<void> {
  await releaseHoldSeats(pool, input);
}
