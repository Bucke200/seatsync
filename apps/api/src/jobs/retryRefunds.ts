import type { Pool, QueryResultRow } from "pg";
import type { Config } from "../config";
import { logger } from "../logger";
import type { PaymentProvider } from "../payments";

/**
 * Refund retry job (D24, design Sprint 3 task "Refunds run after COMMIT").
 *
 * `status = 'FAILED' AND payment_ref IS NOT NULL` is the refundable predicate
 * (migration 0005 adds no refund bookkeeping columns), and `REFUNDED` is the
 * terminal state for both the booking and its `booking_seats`.
 *
 * One run is one transaction that locks every refundable booking in ID order
 * with `FOR UPDATE SKIP LOCKED`, so a concurrent webhook-triggered refund and
 * the interval job can never both claim the same booking. Each provider call
 * is guarded by a SAVEPOINT: a failing refund rolls back only that booking's
 * work (it stays FAILED for the next run) while successful refunds in the same
 * batch still commit. Refunds are called strictly after the webhook COMMIT
 * (the webhook service invokes this helper with `onlyBookingId`).
 */

export interface RefundRunSummary {
  /** Bookings whose provider refund succeeded and moved to REFUNDED. */
  refunded: number;
  /** Refund attempts that threw; those bookings stay FAILED for a later run. */
  failed: number;
}

export interface RefundRefundableOptions {
  /** Restrict the run to one booking (the post-COMMIT webhook trigger). */
  onlyBookingId?: string;
}

type RefundConfig = Pick<Config, "PAYMENT_PROVIDER" | "SWEEPER_INTERVAL_SECONDS">;

interface RefundableBookingRow extends QueryResultRow {
  id: string;
  payment_ref: string;
  amount_paise: number;
}

/**
 * Refund every FAILED booking that still carries a payment reference.
 *
 * At-most-once transition, not exactly-once provider calls: the row lock + the
 * `status = 'FAILED'` predicate make the FAILED -> REFUNDED commit happen at
 * most once per booking, and the `booking_seats` update repeats the guard. One
 * residual crash window remains: if the process dies after `provider.refund`
 * returned successfully but before this transaction commits, the booking is
 * still FAILED when it restarts, so the next run refunds it again. That retry
 * relies on the provider treating a repeated refund for the same payment ref
 * idempotently (the doc accepts this idempotent-retry design). A committed
 * REFUNDED booking is never selected again.
 *
 * A provider error is logged and swallowed: the booking stays FAILED and the
 * next run retries it. The caller (webhook route) still answers 200.
 */
export async function refundRefundableBookings(
  pool: Pool,
  config: RefundConfig,
  provider: PaymentProvider,
  options: RefundRefundableOptions = {},
): Promise<RefundRunSummary> {
  const client = await pool.connect();
  let transactionOpen = false;
  const summary: RefundRunSummary = { refunded: 0, failed: 0 };

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const filterParams: string[] = [];
    let where = `status = 'FAILED' AND payment_ref IS NOT NULL`;

    if (options.onlyBookingId !== undefined) {
      filterParams.push(options.onlyBookingId);
      where += ` AND id = $${filterParams.length}`;
    }

    const candidates = await client.query<RefundableBookingRow>(
      `SELECT id, payment_ref, amount_paise
         FROM bookings
        WHERE ${where}
        ORDER BY id
        FOR UPDATE SKIP LOCKED`,
      filterParams,
    );

    for (const booking of candidates.rows) {
      // A SAVEPOINT keeps a failed refund from rolling back other bookings
      // that were already refunded in this batch. The failing booking has no
      // UPDATE to undo (the provider throws before we write), so it stays
      // FAILED and is retried by the next run.
      await client.query("SAVEPOINT refund_booking");

      try {
        await provider.refund(booking.payment_ref, booking.amount_paise);

        await client.query(
          `UPDATE bookings
              SET status = 'REFUNDED'
            WHERE id = $1
              AND status = 'FAILED'`,
          [booking.id],
        );
        await client.query(
          `UPDATE booking_seats
              SET status = 'REFUNDED'
            WHERE booking_id = $1
              AND status = 'FAILED'`,
          [booking.id],
        );

        await client.query("RELEASE SAVEPOINT refund_booking");
        summary.refunded += 1;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT refund_booking");
        await client.query("RELEASE SAVEPOINT refund_booking");

        summary.failed += 1;
        logger.error(
          {
            err: error,
            bookingId: booking.id,
            provider: config.PAYMENT_PROVIDER,
          },
          "refund failed; booking stays FAILED for the next retry",
        );
      }
    }

    await client.query("COMMIT");
    transactionOpen = false;

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
 * One testable run of the retry job: the whole refundable set, no interval.
 * Tests call this directly (the same D4/D16 pattern as `runSweeperOnce`).
 */
export async function runRefundRetryOnce(
  pool: Pool,
  config: RefundConfig,
  provider: PaymentProvider,
): Promise<RefundRunSummary> {
  return refundRefundableBookings(pool, config, provider);
}

/**
 * Schedule the retry job every `SWEEPER_INTERVAL_SECONDS` (doc-unspecified
 * interval, recorded in the Sprint 3 report). Deliberately interval-only with
 * no boot-time run (D16). Per-tick errors are logged and swallowed; shutdown
 * clears the returned timer.
 */
export function startRetryRefundsJob(
  pool: Pool,
  config: RefundConfig,
  provider: PaymentProvider,
): NodeJS.Timeout {
  return setInterval(() => {
    runRefundRetryOnce(pool, config, provider).catch((error: unknown) => {
      logger.error({ err: error }, "refund retry run failed");
    });
  }, config.SWEEPER_INTERVAL_SECONDS * 1000);
}
