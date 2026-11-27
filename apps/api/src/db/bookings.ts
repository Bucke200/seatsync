import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Config } from "../config";
import { ApiError } from "../middleware/errors";
import type { PaymentProvider } from "../payments";

/**
 * Hand-written SQL for the checkout flow (Sprint 3, D21).
 *
 * One `POST /holds/:id/checkout` request is one transaction: lock the hold's
 * existing booking (replay) or its HELD seats, insert the PENDING booking and
 * its PENDING `booking_seats`, ask the provider for a checkout URL and store it
 * on the same booking row. The provider call happens inside the transaction,
 * so a provider failure rolls back both inserts and the request can be retried.
 */

/** The config slice the checkout transaction reads (only for diagnostics). */
export type CheckoutConfig = Pick<Config, "PAYMENT_PROVIDER">;

export interface CheckoutForHoldInput {
  holdId: string;
  userId: string;
}

export interface CheckoutForHoldResult {
  bookingId: string;
  checkoutUrl: string;
  /** `true` for a fresh booking, `false` when an existing booking was replayed. */
  created: boolean;
}

interface LockedBookingRow extends QueryResultRow {
  id: string;
  user_id: string;
  checkout_url: string | null;
}

interface LockedHeldSeatRow extends QueryResultRow {
  id: string;
  event_id: string;
  price_paise: number;
  held_by: string | null;
  /** D9: computed by Postgres, never by a JS date (clock skew). */
  expired: boolean;
}

interface InsertedBookingRow extends QueryResultRow {
  id: string;
}

/**
 * Lock the booking already bound to this hold (the unique `hold_id` makes it
 * at most one row). No row can be locked before the first checkout commits;
 * the duplicate-request guard below re-runs this after the seat locks.
 */
async function lockBookingByHoldId(
  client: PoolClient,
  holdId: string,
): Promise<LockedBookingRow | null> {
  const result = await client.query<LockedBookingRow>(
    `SELECT id, user_id, checkout_url
       FROM bookings
      WHERE hold_id = $1
      FOR UPDATE`,
    [holdId],
  );

  return result.rows[0] ?? null;
}

/**
 * Build the replay response for an existing booking.
 *
 * Deliberately status-agnostic (D21): the spec says a second checkout for a
 * hold that already has a booking returns the existing `{ bookingId,
 * checkoutUrl }`, so a CONFIRMED/FAILED/REFUNDED booking replays too instead of
 * racing the unique `bookings.hold_id` constraint. Only the owner may replay.
 */
function toReplayResult(
  booking: LockedBookingRow,
  userId: string,
): CheckoutForHoldResult {
  if (booking.user_id !== userId) {
    throw new ApiError(403, "FORBIDDEN", "Only the holder can check out this hold");
  }

  if (booking.checkout_url === null) {
    // Unreachable through this endpoint: the URL is stored before COMMIT.
    throw new ApiError(
      500,
      "INTERNAL_ERROR",
      "Existing booking has no checkout URL",
    );
  }

  return {
    bookingId: booking.id,
    checkoutUrl: booking.checkout_url,
    created: false,
  };
}

/**
 * D21 checkout. Runs one transaction and manages its own COMMIT/ROLLBACK.
 *
 *   BEGIN
 *     lock booking by hold_id
 *       wrong user -> 403 FORBIDDEN
 *       found      -> COMMIT, replay the stored checkout URL
 *     lock HELD seats ORDER BY id FOR UPDATE
 *       0 rows                 -> 404 HOLD_NOT_FOUND
 *       held_by <> caller      -> 403 FORBIDDEN
 *       any held_until < now() -> 404 HOLD_NOT_FOUND (the sweeper owns expiry)
 *     re-lock booking (a concurrent duplicate may have committed while we
 *       waited on the seats) -> replay
 *     INSERT PENDING booking (amount = sum of price_paise, integer paise)
 *     INSERT PENDING booking_seats
 *     provider.createCheckout
 *     UPDATE bookings.checkout_url
 *   COMMIT -> { bookingId, checkoutUrl, created }
 *
 * Any throw rolls the whole transaction back, so a provider failure leaves no
 * booking rows behind and is safe to retry.
 */
export async function createCheckoutForHold(
  pool: Pool,
  config: CheckoutConfig,
  provider: PaymentProvider,
  input: CheckoutForHoldInput,
): Promise<CheckoutForHoldResult> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const existing = await lockBookingByHoldId(client, input.holdId);

    if (existing !== null) {
      const replay = toReplayResult(existing, input.userId);

      await client.query("COMMIT");
      transactionOpen = false;

      return replay;
    }

    const seats = await client.query<LockedHeldSeatRow>(
      `SELECT id, event_id, price_paise, held_by,
              (held_until IS NULL OR held_until < now()) AS expired
         FROM seats
        WHERE hold_id = $1
          AND status = 'HELD'
        ORDER BY id
        FOR UPDATE`,
      [input.holdId],
    );

    if (seats.rows.length === 0) {
      throw new ApiError(404, "HOLD_NOT_FOUND", "Hold not found or already expired");
    }

    if (seats.rows.some((seat) => seat.held_by !== input.userId)) {
      throw new ApiError(403, "FORBIDDEN", "Only the holder can check out this hold");
    }

    // D9: the database clock decides expiry; the sweeper owns expired rows.
    if (seats.rows.some((seat) => seat.expired)) {
      throw new ApiError(404, "HOLD_NOT_FOUND", "Hold not found or already expired");
    }

    // Concurrent duplicates both pass the first lock (there is no row to lock
    // yet) and then serialize on the seat row locks. The loser sees the
    // winner's committed booking here and replays it instead of hitting the
    // unique `bookings.hold_id` constraint.
    const committedWhileWaiting = await lockBookingByHoldId(client, input.holdId);

    if (committedWhileWaiting !== null) {
      const replay = toReplayResult(committedWhileWaiting, input.userId);

      await client.query("COMMIT");
      transactionOpen = false;

      return replay;
    }

    const firstSeat = seats.rows[0];

    if (firstSeat === undefined) {
      // Unreachable: the zero-row case threw above.
      throw new ApiError(404, "HOLD_NOT_FOUND", "Hold not found or already expired");
    }

    const eventId = firstSeat.event_id;
    const consistentEvent = seats.rows.every((seat) => seat.event_id === eventId);

    if (!consistentEvent) {
      // Unreachable: a hold id is generated per request and seats are only
      // held by one event, so one hold can never span events.
      throw new Error(`Hold ${input.holdId} spans more than one event`);
    }

    // Rule 6: integer paise only; the column is INTEGER.
    const amountPaise = seats.rows.reduce(
      (total, seat) => total + seat.price_paise,
      0,
    );

    const inserted = await client.query<InsertedBookingRow>(
      `INSERT INTO bookings (user_id, event_id, hold_id, status, amount_paise)
       VALUES ($1, $2, $3, 'PENDING', $4)
       RETURNING id`,
      [input.userId, eventId, input.holdId, amountPaise],
    );
    const booking = inserted.rows[0];

    if (booking === undefined) {
      throw new Error("Inserting the checkout booking returned no row");
    }

    await client.query(
      `INSERT INTO booking_seats (booking_id, seat_id, status)
       SELECT $1, unnest($2::uuid[]), 'PENDING'`,
      [booking.id, seats.rows.map((seat) => seat.id)],
    );

    let checkoutUrl: string;

    try {
      ({ checkoutUrl } = await provider.createCheckout({
        bookingId: booking.id,
        holdId: input.holdId,
        amountPaise,
      }));
    } catch {
      // No booking rows may survive a failed provider call; the rollback in the
      // catch below removes them. 502 marks the provider as the failing party.
      throw new ApiError(
        502,
        "PROVIDER_ERROR",
        `Payment provider (${config.PAYMENT_PROVIDER}) failed to create a checkout`,
      );
    }

    await client.query(
      `UPDATE bookings
          SET checkout_url = $2
        WHERE id = $1`,
      [booking.id, checkoutUrl],
    );

    await client.query("COMMIT");
    transactionOpen = false;

    return { bookingId: booking.id, checkoutUrl, created: true };
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}
