import type { Logger } from "pino";
import type { Pool, QueryResultRow } from "pg";
import type { Config } from "../config";
import { logger } from "../logger";
import { emitSeatChange } from "../services/seatEvents";

/**
 * Expired-hold sweeper (design Sprint 2 task 6, D4/D5).
 *
 * One run is one transaction:
 *   1. lock expired holds in id order with `SKIP LOCKED`, so the sweeper never
 *      blocks or deadlocks against the hold/confirm paths;
 *   2. release them back to AVAILABLE and bump each seat's `version` (Rule 7);
 *   3. prune retention tables: `idempotency_keys`, plus `processed_webhooks`
 *      only when it exists (Sprint 3 creates it, D5);
 *   4. COMMIT, then emit one AVAILABLE event per released seat with its own
 *      RETURNING version (Rule 5, D14).
 */

export interface SweeperSummary {
  released: number;
  prunedIdempotencyKeys: number;
  /** null when `processed_webhooks` does not exist yet (D5). */
  prunedWebhooks: number | null;
}

interface ExpiredHoldRow extends QueryResultRow {
  id: string;
  event_id: string;
}

interface ReleasedSeatRow extends QueryResultRow {
  id: string;
  event_id: string;
  version: number;
}

interface RegclassRow extends QueryResultRow {
  name: string | null;
}

/**
 * Run one sweep. Callers (tests, the interval below) await this directly; a
 * rejection means the transaction rolled back and nothing was emitted.
 */
export async function runSweeperOnce(
  pool: Pool,
  config: Config,
  log: Logger = logger,
): Promise<SweeperSummary> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    // Rule from the design task: deterministic id order plus SKIP LOCKED. The
    // rows locked here are exactly the rows the UPDATE may release, and no
    // concurrent hold/release can change them while this transaction holds
    // their locks.
    const expired = await client.query<ExpiredHoldRow>(
      `SELECT id, event_id
         FROM seats
        WHERE status = 'HELD'
          AND held_until < now()
        ORDER BY id
        FOR UPDATE SKIP LOCKED`,
    );

    let released: ReleasedSeatRow[] = [];

    if (expired.rows.length > 0) {
      const updated = await client.query<ReleasedSeatRow>(
        `UPDATE seats
            SET status = 'AVAILABLE',
                hold_id = NULL,
                held_by = NULL,
                held_until = NULL,
                version = version + 1
          WHERE id = ANY($1::uuid[])
          RETURNING id, event_id, version`,
        [expired.rows.map((row) => row.id)],
      );

      released = updated.rows;
    }

    // D5: prune idempotency records older than RETENTION_DAYS. The value is a
    // bound parameter; `make_interval` keeps the arithmetic on the DB clock.
    const prunedKeys = await client.query(
      `DELETE FROM idempotency_keys
        WHERE created_at < now() - make_interval(days => $1)`,
      [config.RETENTION_DAYS],
    );

    // D5: processed_webhooks does not exist until Sprint 3. `to_regclass`
    // returns NULL instead of erroring, so this run is safe before then.
    const webhooksTable = await client.query<RegclassRow>(
      `SELECT to_regclass('public.processed_webhooks') AS name`,
    );
    const webhooksTableName = webhooksTable.rows[0]?.name ?? null;
    let prunedWebhooks: number | null = null;

    if (webhooksTableName !== null) {
      const pruned = await client.query(
        `DELETE FROM processed_webhooks
          WHERE received_at < now() - make_interval(days => $1)`,
        [config.RETENTION_DAYS],
      );

      prunedWebhooks = pruned.rowCount ?? 0;
    }

    await client.query("COMMIT");
    transactionOpen = false;

    // Rule 5: emit only after COMMIT. D14: one event per seat, each carrying
    // the version returned by this run's UPDATE.
    for (const seat of released) {
      emitSeatChange({
        eventId: seat.event_id,
        seatIds: [seat.id],
        status: "AVAILABLE",
        version: seat.version,
      });
    }

    const summary: SweeperSummary = {
      released: released.length,
      prunedIdempotencyKeys: prunedKeys.rowCount ?? 0,
      prunedWebhooks,
    };

    log.info(summary, "expired hold sweep completed");

    return summary;
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
 * Schedule the sweeper every `SWEEPER_INTERVAL_SECONDS`.
 *
 * The interval is the only trigger: there is deliberately no boot-time run
 * (D16), matching the design's "run every SWEEPER_INTERVAL_SECONDS". A failed
 * run is logged and swallowed so the interval keeps ticking; shutdown is the
 * caller's job via `clearInterval` on the returned timer.
 */
export function startExpireHoldsJob(
  pool: Pool,
  config: Config,
  log: Logger = logger,
): NodeJS.Timeout {
  return setInterval(() => {
    runSweeperOnce(pool, config, log).catch((error: unknown) => {
      log.error({ err: error }, "expired hold sweep failed");
    });
  }, config.SWEEPER_INTERVAL_SECONDS * 1000);
}
