import type { ErrorResponse, EventStatus, SeatStatus } from "@seatsync/shared";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { ApiError } from "../middleware/errors";
import { emitSeatChange } from "../services/seatEvents";
import {
  claimIdempotencyKey,
  storeIdempotencyResponse,
  type IdempotencyKeyRecord,
} from "./idempotency";

export interface SectionSeatInput {
  name: string;
  rows: number;
  seatsPerRow: number;
  pricePaise: number;
}

export interface SeatRecord {
  id: string;
  section: string;
  rowLabel: string;
  number: number;
  pricePaise: number;
  status: SeatStatus;
  /** D29: per-seat version; the client stale filter uses it (Rule 7). */
  version: number;
  /** Present only on the viewer's own active hold (D15). */
  holdId?: string;
  /** ISO timestamp of the viewer's own active hold (D15). */
  heldUntil?: string;
  /** Present only on the viewer's own active hold (D15). */
  heldByMe?: boolean;
}

export interface ListSeatsOptions {
  viewerUserId?: string;
}

export interface HoldSeatsInput {
  eventId: string;
  seatIds: string[];
  userId: string;
  holdId: string;
  holdTtlSeconds: number;
}

export interface HeldSeatVersion {
  id: string;
  version: number;
}

export interface HoldSeatsResult {
  holdId: string;
  seatIds: string[];
  heldUntil: Date;
  perSeat: HeldSeatVersion[];
}

export interface HoldSeatsWithIdempotencyInput extends HoldSeatsInput {
  idempotencyKey: string;
  bodyHash: string;
}

/** 201 body from the hold endpoint (D10): `heldUntil` is an ISO string. */
export interface HoldResponseBody {
  holdId: string;
  seatIds: string[];
  heldUntil: string;
}

/** Outcome of the D13 transaction: either the hold or the stored 409 replay. */
export type HoldRequestOutcome =
  | { statusCode: 201; body: HoldResponseBody }
  | { statusCode: 409; body: ErrorResponse };

export interface ReleaseHoldInput {
  holdId: string;
  userId: string;
}

interface SeatRow extends QueryResultRow {
  id: string;
  section: string;
  row_label: string;
  number: number;
  price_paise: number;
  status: SeatStatus;
  version: number;
  hold_id: string | null;
  held_until: Date | null;
}

interface EventStatusRow extends QueryResultRow {
  status: EventStatus;
}

interface ActiveHoldRow extends QueryResultRow {
  id: string;
}

interface HeldSeatRow extends QueryResultRow {
  id: string;
  held_until: Date;
  version: number;
}

interface SeatAvailabilityRow extends QueryResultRow {
  id: string;
  status: SeatStatus;
}

interface LockedHoldSeatRow extends QueryResultRow {
  id: string;
  held_by: string | null;
}

interface ReleasedSeatRow extends QueryResultRow {
  id: string;
  event_id: string;
  version: number;
}

const SEATS_ATTEMPT_SAVEPOINT = "seats_attempt";

/**
 * Insert one section's seats inside the caller's transaction. Row labels are
 * `R1..R{rows}` and seat numbers `1..seatsPerRow`; every value is a bound
 * parameter, never interpolated text.
 */
export async function insertSectionSeats(
  client: PoolClient,
  eventId: string,
  section: SectionSeatInput,
): Promise<void> {
  const tuples: string[] = [];
  // $1 = event_id, $2 = section, $3 = price_paise; each seat adds two params.
  const params: Array<string | number> = [eventId, section.name, section.pricePaise];

  for (let row = 1; row <= section.rows; row += 1) {
    for (let number = 1; number <= section.seatsPerRow; number += 1) {
      params.push(`R${row}`, number);
      tuples.push(`($1, $2, $${params.length - 1}, $${params.length}, $3)`);
    }
  }

  if (tuples.length === 0) {
    return;
  }

  await client.query(
    `INSERT INTO seats (event_id, section, row_label, number, price_paise)
     VALUES ${tuples.join(", ")}`,
    params,
  );
}

/**
 * List an event's seats for `GET /events/:id`.
 *
 * D9: an expired, not-yet-swept hold reads as `AVAILABLE`; the comparison uses
 * the database clock (`now()`), never a JS date, because the DB/WSL clock can
 * be seconds ahead of Node.
 *
 * D15: when a viewer is supplied, seats that the viewer personally holds right
 * now additionally expose `holdId`, `heldUntil` and `heldByMe` so the web can
 * offer Release after a reload. The CASE expressions return NULL for every
 * other seat, so no user ever sees another user's hold id or expiry.
 */
export async function listSeatsByEventId(
  pool: Pool,
  eventId: string,
  opts: ListSeatsOptions = {},
): Promise<SeatRecord[]> {
  const viewerUserId = opts.viewerUserId ?? null;
  const result = await pool.query<SeatRow>(
    `SELECT id,
            section,
            row_label,
            number,
            price_paise,
            CASE
              WHEN status = 'HELD' AND held_until < now() THEN 'AVAILABLE'
              ELSE status
            END AS status,
            version,
            CASE
              WHEN $2::uuid IS NOT NULL
               AND held_by = $2::uuid
               AND status = 'HELD'
               AND held_until >= now()
              THEN hold_id
            END AS hold_id,
            CASE
              WHEN $2::uuid IS NOT NULL
               AND held_by = $2::uuid
               AND status = 'HELD'
               AND held_until >= now()
              THEN held_until
            END AS held_until
       FROM seats
      WHERE event_id = $1
      ORDER BY section ASC, row_label ASC, number ASC`,
    [eventId, viewerUserId],
  );

  return result.rows.map((row) => {
    const seat: SeatRecord = {
      id: row.id,
      section: row.section,
      rowLabel: row.row_label,
      number: row.number,
      pricePaise: row.price_paise,
      status: row.status,
      version: row.version,
    };

    if (row.hold_id !== null && row.held_until !== null) {
      seat.holdId = row.hold_id;
      seat.heldUntil = row.held_until.toISOString();
      seat.heldByMe = true;
    }

    return seat;
  });
}

/**
 * Rule 1 hold core. Runs inside the caller's open transaction, manages no
 * transaction of its own and never emits: COMMIT and post-commit emission
 * belong to `holdSeatsWithIdempotency` (or a Step 3 composer).
 *
 * The two statements are the design's Rule 1 SQL verbatim; only placeholder
 * numbers differ per statement because they are separate queries. The lock
 * takes `$1 = event id`, `$2 = seat ids`; the UPDATE takes the documented
 * `$1 = hold id`, `$2 = held by`, `$3 = event id`, `$4 = seat ids`,
 * `$5 = HOLD_TTL_SECONDS`.
 */
export async function holdSeatsCore(
  client: PoolClient,
  input: HoldSeatsInput,
): Promise<HoldSeatsResult> {
  // D6: a missing event and an unpublished (DRAFT) event are both hidden as
  // 404. Plain read, never FOR UPDATE: the event row must not serialize holds.
  const eventResult = await client.query<EventStatusRow>(
    `SELECT status FROM events WHERE id = $1`,
    [input.eventId],
  );
  const event = eventResult.rows[0];

  if (event === undefined || event.status !== "PUBLISHED") {
    throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
  }

  // D8: a second active hold by the same user for the same event is a 409.
  // The plain read races only the same user against themselves; that is an
  // accepted gap (discovery §9 item 4).
  const activeHolds = await client.query<ActiveHoldRow>(
    `SELECT id
       FROM seats
      WHERE event_id = $1
        AND held_by = $2
        AND status = 'HELD'
        AND held_until >= now()
      ORDER BY id`,
    [input.eventId, input.userId],
  );

  if (activeHolds.rows.length > 0) {
    throw new ApiError(
      409,
      "SEATS_UNAVAILABLE",
      "You already have an active hold for this event",
      { seatIds: activeHolds.rows.map((row) => row.id) },
    );
  }

  // Rule 1, step 1: lock the target rows in deterministic ID order so
  // overlapping requests queue instead of deadlocking.
  await client.query(
    `SELECT id FROM seats
      WHERE event_id = $1 AND id = ANY($2)
      ORDER BY id
      FOR UPDATE`,
    [input.eventId, input.seatIds],
  );

  // Rule 1, step 2: the conditional UPDATE. Under READ COMMITTED a waiter
  // re-checks the WHERE clause after the row lock and gets 0 rows for a seat
  // that is now actively held.
  const updated = await client.query<HeldSeatRow>(
    `UPDATE seats
     SET status = 'HELD', hold_id = $1, held_by = $2,
         held_until = now() + make_interval(secs => $5),
         version = version + 1
     WHERE event_id = $3 AND id = ANY($4)
       AND (status = 'AVAILABLE'
            OR (status = 'HELD' AND held_until < now()))
     RETURNING id, held_until, version`,
    [input.holdId, input.userId, input.eventId, input.seatIds, input.holdTtlSeconds],
  );

  if (updated.rows.length < input.seatIds.length) {
    // No details here: this UPDATE may already have changed some rows, so the
    // caller must roll back to its savepoint and re-read availability before
    // it can name the unavailable seats (D7).
    throw new ApiError(409, "SEATS_UNAVAILABLE", "One or more seats are no longer available");
  }

  const first = updated.rows[0];

  if (first === undefined) {
    // Defensive: `seatIds` is validated as non-empty upstream.
    throw new ApiError(409, "SEATS_UNAVAILABLE", "One or more seats are no longer available");
  }

  return {
    holdId: input.holdId,
    seatIds: updated.rows.map((row) => row.id),
    // One statement reads `now()` once, so every row shares this value (D10).
    heldUntil: first.held_until,
    perSeat: updated.rows.map((row) => ({ id: row.id, version: row.version })),
  };
}

/**
 * Post-rollback availability read for a 409 details body (D7): the requested
 * seats that are neither AVAILABLE nor expired-HELD, plus requested ids that
 * do not exist in this event. Preserves the requested order.
 */
export async function findUnavailableSeatIds(
  client: PoolClient,
  eventId: string,
  seatIds: string[],
): Promise<string[]> {
  const result = await client.query<SeatAvailabilityRow>(
    `SELECT id,
            CASE
              WHEN status = 'HELD' AND held_until < now() THEN 'AVAILABLE'
              ELSE status
            END AS status
       FROM seats
      WHERE event_id = $1 AND id = ANY($2)`,
    [eventId, seatIds],
  );

  const available = new Set<string>();

  for (const row of result.rows) {
    if (row.status === "AVAILABLE") {
      available.add(row.id);
    }
  }

  return seatIds.filter((id) => !available.has(id));
}

function hasPgErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

function isSeatsUnavailable(error: unknown): error is ApiError {
  return error instanceof ApiError && error.statusCode === 409 && error.code === "SEATS_UNAVAILABLE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHoldResponseBody(value: unknown): value is HoldResponseBody {
  return (
    isRecord(value) &&
    typeof value.holdId === "string" &&
    typeof value.heldUntil === "string" &&
    Array.isArray(value.seatIds) &&
    value.seatIds.every((id) => typeof id === "string")
  );
}

function isErrorResponse(value: unknown): value is ErrorResponse {
  if (!isRecord(value) || !isRecord(value.error)) {
    return false;
  }

  return typeof value.error.code === "string" && typeof value.error.message === "string";
}

function readSeatIdsFromDetails(details: unknown): string[] {
  if (!isRecord(details) || !Array.isArray(details.seatIds)) {
    return [];
  }

  return details.seatIds.filter((id): id is string => typeof id === "string");
}

/** Rebuild the stored outcome verbatim (D2): same status code, same body. */
function toStoredOutcome(row: IdempotencyKeyRecord): HoldRequestOutcome {
  if (row.statusCode === 201 && isHoldResponseBody(row.response)) {
    return { statusCode: 201, body: row.response };
  }

  if (row.statusCode === 409 && isErrorResponse(row.response)) {
    return { statusCode: 409, body: row.response };
  }

  throw new Error(`Stored idempotency response for key ${row.key} is invalid`);
}

/** D14: one event per seat, each carrying its own RETURNING version. */
function emitHeldSeats(eventId: string, hold: HoldSeatsResult): void {
  for (const seat of hold.perSeat) {
    emitSeatChange({
      eventId,
      seatIds: [seat.id],
      status: "HELD",
      version: seat.version,
    });
  }
}

/**
 * D13: idempotency claim + Rule 1 hold in one transaction.
 *
 *   BEGIN
 *     claim key (INSERT ... ON CONFLICT DO NOTHING + SELECT ... FOR UPDATE)
 *     mismatch                    -> ROLLBACK, 422 VALIDATION_ERROR
 *     stored response             -> COMMIT, replay it verbatim
 *     SAVEPOINT seats_attempt
 *       holdSeatsCore
 *       shortfall / second hold   -> ROLLBACK TO SAVEPOINT, store 409, COMMIT
 *       deadlock                  -> ROLLBACK TO SAVEPOINT, retry once
 *       201                       -> store 201, COMMIT, emit per seat
 *   any other error               -> full ROLLBACK, rethrow to the error handler
 *
 * Expected hold outcomes are returned as data (`statusCode` + `body`) rather
 * than thrown, so the caller can replay a stored response exactly.
 * Only validation, missing-event and unexpected database errors are thrown.
 */
export async function holdSeatsWithIdempotency(
  pool: Pool,
  input: HoldSeatsWithIdempotencyInput,
): Promise<HoldRequestOutcome> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const claim = await claimIdempotencyKey(client, {
      key: input.idempotencyKey,
      userId: input.userId,
      bodyHash: input.bodyHash,
    });

    if (claim.mismatch) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "Idempotency-Key was already used with a different request",
      );
    }

    if (claim.outcome === "existing" && claim.row.response !== null) {
      const replay = toStoredOutcome(claim.row);

      await client.query("COMMIT");
      transactionOpen = false;

      return replay;
    }

    const coreInput: HoldSeatsInput = {
      eventId: input.eventId,
      seatIds: input.seatIds,
      userId: input.userId,
      holdId: input.holdId,
      holdTtlSeconds: input.holdTtlSeconds,
    };

    let hold: HoldSeatsResult | null = null;
    let conflict: ApiError | null = null;
    let deadlockRetried = false;

    while (hold === null && conflict === null) {
      // The key row was inserted/locked before this savepoint, so rolling
      // back to it keeps the claim while undoing any partially applied hold.
      await client.query(`SAVEPOINT ${SEATS_ATTEMPT_SAVEPOINT}`);

      try {
        hold = await holdSeatsCore(client, coreInput);
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${SEATS_ATTEMPT_SAVEPOINT}`);

        // Rule 1: a residual 40P01 deadlock gets one bounded retry.
        if (hasPgErrorCode(error, "40P01") && !deadlockRetried) {
          deadlockRetried = true;
          continue;
        }

        if (isSeatsUnavailable(error)) {
          conflict = error;
          continue;
        }

        if (hasPgErrorCode(error, "40P01")) {
          conflict = new ApiError(
            409,
            "SEATS_UNAVAILABLE",
            "Seat hold could not be completed due to database contention",
            { seatIds: [...input.seatIds] },
          );
          continue;
        }

        throw error;
      }
    }

    if (hold !== null) {
      const body: HoldResponseBody = {
        holdId: hold.holdId,
        seatIds: hold.seatIds,
        heldUntil: hold.heldUntil.toISOString(),
      };

      await storeIdempotencyResponse(client, {
        key: input.idempotencyKey,
        statusCode: 201,
        response: body,
      });

      await client.query("COMMIT");
      transactionOpen = false;

      // Rule 5: only after COMMIT, one event per seat (D14).
      emitHeldSeats(input.eventId, hold);

      return { statusCode: 201, body };
    }

    if (conflict === null) {
      // Unreachable: the loop exits only with one of the two set.
      throw new Error("Seat hold produced neither a result nor a conflict");
    }

    // The shortfall error carries no details (some rows may have changed before
    // the rollback); D8's error already names the user's active seats.
    const unavailableSeatIds =
      conflict.details === undefined
        ? await findUnavailableSeatIds(client, input.eventId, input.seatIds)
        : readSeatIdsFromDetails(conflict.details);

    const conflictBody: ErrorResponse = {
      error: {
        code: "SEATS_UNAVAILABLE",
        message: conflict.message,
        details: { seatIds: unavailableSeatIds },
      },
    };

    await storeIdempotencyResponse(client, {
      key: input.idempotencyKey,
      statusCode: 409,
      response: conflictBody,
    });

    await client.query("COMMIT");
    transactionOpen = false;

    return { statusCode: 409, body: conflictBody };
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}

/**
 * D1 release: lock the hold's active seats in ID order, verify ownership,
 * return them to AVAILABLE with a version bump, COMMIT, then emit per seat.
 *
 * An expired-but-unswept hold is not found here (`404 HOLD_NOT_FOUND`); the
 * sweeper owns expired rows. A hold id owned by another user is `403`.
 */
export async function releaseHoldSeats(pool: Pool, input: ReleaseHoldInput): Promise<void> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const locked = await client.query<LockedHoldSeatRow>(
      `SELECT id, held_by
         FROM seats
        WHERE hold_id = $1
          AND status = 'HELD'
          AND held_until >= now()
        ORDER BY id
        FOR UPDATE`,
      [input.holdId],
    );

    if (locked.rows.length === 0) {
      throw new ApiError(404, "HOLD_NOT_FOUND", "Hold not found or already expired");
    }

    if (locked.rows.some((row) => row.held_by !== input.userId)) {
      throw new ApiError(403, "FORBIDDEN", "Only the holder can release this hold");
    }

    const released = await client.query<ReleasedSeatRow>(
      `UPDATE seats
          SET status = 'AVAILABLE',
              hold_id = NULL,
              held_by = NULL,
              held_until = NULL,
              version = version + 1
        WHERE hold_id = $1
          AND status = 'HELD'
        RETURNING id, event_id, version`,
      [input.holdId],
    );

    await client.query("COMMIT");
    transactionOpen = false;

    // Rule 5: emit only after COMMIT, one event per released seat (D14).
    for (const seat of released.rows) {
      emitSeatChange({
        eventId: seat.event_id,
        seatIds: [seat.id],
        status: "AVAILABLE",
        version: seat.version,
      });
    }
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}
