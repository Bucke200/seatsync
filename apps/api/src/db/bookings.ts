import type { BookingStatus, SeatStatus } from "@seatsync/shared";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import type { Config } from "../config";
import { ApiError } from "../middleware/errors";
import type { PaymentProvider, VerifiedWebhookEvent } from "../payments";
import { emitSeatChange } from "../services/seatEvents";

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

/** The config slice the webhook transaction reads (the dedupe `provider` column). */
export type WebhookConfig = Pick<Config, "PAYMENT_PROVIDER">;

export interface ProcessWebhookEventResult {
  /** True when the event id was already in `processed_webhooks` (Rule 4). */
  alreadyProcessed: boolean;
  /**
   * The booking whose payment must be refunded AFTER this transaction commits,
   * or null when no refund is owed. The refund itself never runs in here
   * (Rule 5 / D24).
   */
  refundBookingId: string | null;
}

interface WebhookBookingRow extends QueryResultRow {
  id: string;
  event_id: string;
  hold_id: string;
  status: BookingStatus;
  payment_ref: string | null;
  amount_paise: number;
}

interface WebhookSeatRow extends QueryResultRow {
  id: string;
  event_id: string;
  version: number;
}

interface CountRow extends QueryResultRow {
  count: number;
}

/** Emit one event per seat with that seat's own RETURNING version (D14). */
function emitSeatChanges(
  seats: WebhookSeatRow[],
  status: "BOOKED" | "AVAILABLE",
): void {
  for (const seat of seats) {
    emitSeatChange({
      eventId: seat.event_id,
      seatIds: [seat.id],
      status,
      version: seat.version,
    });
  }
}

/**
 * Rule 4 + Rule 2 webhook transaction (D23).
 *
 *   BEGIN
 *     INSERT processed_webhooks ON CONFLICT DO NOTHING
 *       0 rows -> COMMIT, already processed (200)
 *     provider.runAfterDedupeHook?.()          // fake rollback-test seam
 *     SELECT booking FOR UPDATE
 *       0 rows / hold mismatch -> COMMIT, processing is a no-op (200)
 *     checkout_expired  -> release HELD seats, FAIL booking
 *     payment_succeeded -> status PENDING ? confirm-or-release : maybe capture
 *                          a late payment_ref on a FAILED booking
 *   COMMIT -> seatEvents only now (Rule 5)
 *
 * Returns `refundBookingId` when the caller must run `refundRefundableBookings`
 * AFTER this transaction (never inside it, D24). Throwing rolls the whole
 * transaction back, including the dedupe row, so provider redelivery is
 * processed from scratch.
 */
export async function processWebhookEvent(
  pool: Pool,
  config: WebhookConfig,
  provider: PaymentProvider,
  event: VerifiedWebhookEvent,
): Promise<ProcessWebhookEventResult> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    // Rule 4: the only dedupe point in the system. A fresh insert means this
    // delivery owns the transaction; 0 rows means a previous delivery already
    // committed (possibly a concurrent one that we just waited on).
    const dedupe = await client.query(
      `INSERT INTO processed_webhooks (event_id, provider)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, config.PAYMENT_PROVIDER],
    );

    if ((dedupe.rowCount ?? 0) === 0) {
      await client.query("COMMIT");
      transactionOpen = false;

      return { alreadyProcessed: true, refundBookingId: null };
    }

    // Test-only seam (D20a): called only on the fresh-insert path, so the
    // already-processed path can never observe it.
    provider.runAfterDedupeHook?.();

    // Rule 2 lock (design.md:143-147): when the event carries a hold id, the
    // hold binding is part of the lock predicate, so a mismatched payload
    // locks 0 rows and commits as a no-op. The fake provider permits events
    // without holdId (doc-unspecified), and those lock by booking id alone.
    const locked =
      event.holdId === undefined
        ? await client.query<WebhookBookingRow>(
            `SELECT id, event_id, hold_id, status, payment_ref, amount_paise
               FROM bookings
              WHERE id = $1
              FOR UPDATE`,
            [event.bookingId],
          )
        : await client.query<WebhookBookingRow>(
            `SELECT id, event_id, hold_id, status, payment_ref, amount_paise
               FROM bookings
              WHERE id = $1
                AND hold_id = $2
              FOR UPDATE`,
            [event.bookingId, event.holdId],
          );
    const booking = locked.rows[0];

    // 0 rows: unknown booking, or one bound to a different hold. Either way
    // the dedupe row stays committed and the delivery is a 200 no-op.
    if (booking === undefined) {
      await client.query("COMMIT");
      transactionOpen = false;

      return { alreadyProcessed: false, refundBookingId: null };
    }

    if (event.type === "checkout_expired") {
      if (booking.status !== "PENDING") {
        await client.query("COMMIT");
        transactionOpen = false;

        return { alreadyProcessed: false, refundBookingId: null };
      }

      // Pre-lock the hold's remaining HELD seats in ID order (Rule 2 shape),
      // then release exactly those rows. No payment happened, so the booking
      // is FAILED without a payment_ref and no refund is triggered.
      await client.query(
        `SELECT id
           FROM seats
          WHERE hold_id = $1
            AND status = 'HELD'
          ORDER BY id
          FOR UPDATE`,
        [booking.hold_id],
      );

      const released = await client.query<WebhookSeatRow>(
        `UPDATE seats
            SET status = 'AVAILABLE',
                hold_id = NULL,
                held_by = NULL,
                held_until = NULL,
                version = version + 1
          WHERE hold_id = $1
            AND status = 'HELD'
          RETURNING id, event_id, version`,
        [booking.hold_id],
      );

      await client.query(
        `UPDATE bookings
            SET status = 'FAILED'
          WHERE id = $1`,
        [booking.id],
      );
      await client.query(
        `UPDATE booking_seats
            SET status = 'FAILED'
          WHERE booking_id = $1`,
        [booking.id],
      );

      await client.query("COMMIT");
      transactionOpen = false;

      emitSeatChanges(released.rows, "AVAILABLE");

      return { alreadyProcessed: false, refundBookingId: null };
    }

    // payment_succeeded
    if (booking.status !== "PENDING") {
      // Rule 2's one exception: a payment that lands after checkout_expired
      // (or any terminal state) must be captured on a FAILED booking so the
      // refund job can return it. Every other terminal state commits silently.
      let refundBookingId: string | null = null;

      if (booking.status === "FAILED" && event.paymentRef !== null) {
        await client.query(
          `UPDATE bookings
              SET payment_ref = COALESCE(payment_ref, $2)
            WHERE id = $1`,
          [booking.id, event.paymentRef],
        );
        refundBookingId = booking.id;
      }

      await client.query("COMMIT");
      transactionOpen = false;

      return { alreadyProcessed: false, refundBookingId };
    }

    const expectedSeats = await client.query<CountRow>(
      `SELECT count(*)::int AS count
         FROM booking_seats
        WHERE booking_id = $1`,
      [booking.id],
    );
    const expected = expectedSeats.rows[0]?.count ?? 0;

    // Rule 2 step 1: pre-lock all HELD seats for this hold in ID order.
    const lockedSeats = await client.query<WebhookSeatRow>(
      `SELECT id, event_id, version
         FROM seats
        WHERE hold_id = $1
          AND status = 'HELD'
        ORDER BY id
        FOR UPDATE`,
      [booking.hold_id],
    );

    let shortfall = lockedSeats.rows.length !== expected;
    let confirmedSeats: WebhookSeatRow[] = [];

    if (!shortfall) {
      // Rule 2 step 2a: all-or-nothing confirm. `hold_id` stays intact on the
      // now-BOOKED rows; only `held_until` is cleared.
      const confirmed = await client.query<WebhookSeatRow>(
        `UPDATE seats
            SET status = 'BOOKED',
                held_until = NULL,
                version = version + 1
          WHERE hold_id = $1
            AND status = 'HELD'
          RETURNING id, event_id, version`,
        [booking.hold_id],
      );

      if (confirmed.rows.length < expected) {
        // Rule 2's explicit paranoia: the confirm claimed fewer rows than the
        // expected seat count, so this transaction falls through to 2b.
        shortfall = true;
      } else {
        confirmedSeats = confirmed.rows;
      }
    }

    if (!shortfall) {
      await client.query(
        `UPDATE bookings
            SET status = 'CONFIRMED',
                payment_ref = COALESCE(payment_ref, $2)
          WHERE id = $1`,
        [booking.id, event.paymentRef],
      );
      await client.query(
        `UPDATE booking_seats
            SET status = 'CONFIRMED'
          WHERE booking_id = $1`,
        [booking.id],
      );

      await client.query("COMMIT");
      transactionOpen = false;

      // Rule 5: emit only after COMMIT. D14: one event per seat.
      emitSeatChanges(confirmedSeats, "BOOKED");

      return { alreadyProcessed: false, refundBookingId: null };
    }

    // Rule 2 step 2b: a seat was lost before or mid-flight. Release every seat
    // still carrying this hold (HELD or BOOKED) and fail the booking so the
    // payment is refunded after COMMIT.
    const released = await client.query<WebhookSeatRow>(
      `UPDATE seats
          SET status = 'AVAILABLE',
              hold_id = NULL,
              held_by = NULL,
              held_until = NULL,
              version = version + 1
        WHERE hold_id = $1
          AND status IN ('HELD', 'BOOKED')
        RETURNING id, event_id, version`,
      [booking.hold_id],
    );

    await client.query(
      `UPDATE bookings
          SET status = 'FAILED',
              payment_ref = $2
        WHERE id = $1`,
      [booking.id, event.paymentRef],
    );
    await client.query(
      `UPDATE booking_seats
          SET status = 'FAILED'
        WHERE booking_id = $1`,
      [booking.id],
    );

    await client.query("COMMIT");
    transactionOpen = false;

    emitSeatChanges(released.rows, "AVAILABLE");

    return { alreadyProcessed: false, refundBookingId: booking.id };
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }

    throw error;
  } finally {
    client.release();
  }
}

/** One seat on a booking detail read, joined to its live seat row. */
export interface BookingSeatViewRecord {
  seatId: string;
  section: string;
  rowLabel: string;
  number: number;
  /** The live seat status (AVAILABLE / HELD / BOOKED), from `seats`. */
  status: SeatStatus;
  pricePaise: number;
}

export interface BookingDetailInput {
  bookingId: string;
  userId: string;
}

export interface BookingDetailRecord {
  id: string;
  eventId: string;
  status: BookingStatus;
  amountPaise: number;
  paymentRef: string | null;
  checkoutUrl: string | null;
  holdId: string;
  createdAt: Date;
  /** `bookings.user_id = $2`, computed by the booking row query. */
  owned: boolean;
  seats: BookingSeatViewRecord[];
}

export interface UserBookingRecord {
  id: string;
  eventId: string;
  eventTitle: string;
  eventStartsAt: Date;
  status: BookingStatus;
  amountPaise: number;
  seatCount: number;
  createdAt: Date;
}

interface BookingDetailBookingRow extends QueryResultRow {
  id: string;
  event_id: string;
  status: BookingStatus;
  amount_paise: number;
  payment_ref: string | null;
  checkout_url: string | null;
  hold_id: string;
  created_at: Date;
  owned: boolean;
}

interface BookingSeatViewRow extends QueryResultRow {
  seat_id: string;
  section: string;
  row_label: string;
  number: number;
  status: SeatStatus;
  price_paise: number;
}

interface UserBookingRow extends QueryResultRow {
  id: string;
  event_id: string;
  event_title: string;
  event_starts_at: Date;
  status: BookingStatus;
  amount_paise: number;
  seat_count: number;
  created_at: Date;
}

/**
 * D25 owner-scoped booking detail.
 *
 * The booking row is selected by id alone with `user_id = $2` computed as an
 * `owned` flag, so a missing booking (404) and another user's booking (403)
 * stay distinguishable without a second query. The seats join reads the live
 * seat state for section/row/number/status/price; `booking_seats` supplies
 * membership.
 */
export async function getBookingDetail(
  pool: Pool,
  input: BookingDetailInput,
): Promise<BookingDetailRecord | null> {
  const bookingResult = await pool.query<BookingDetailBookingRow>(
    `SELECT id, event_id, status, amount_paise, payment_ref, checkout_url,
            hold_id, created_at, (user_id = $2) AS owned
       FROM bookings
      WHERE id = $1`,
    [input.bookingId, input.userId],
  );
  const booking = bookingResult.rows[0];

  if (booking === undefined) {
    return null;
  }

  const seatResult = await pool.query<BookingSeatViewRow>(
    `SELECT bs.seat_id, s.section, s.row_label, s.number, s.status,
            s.price_paise
       FROM booking_seats bs
       JOIN seats s ON s.id = bs.seat_id
      WHERE bs.booking_id = $1
      ORDER BY s.section, s.row_label, s.number`,
    [input.bookingId],
  );

  return {
    id: booking.id,
    eventId: booking.event_id,
    status: booking.status,
    amountPaise: booking.amount_paise,
    paymentRef: booking.payment_ref,
    checkoutUrl: booking.checkout_url,
    holdId: booking.hold_id,
    createdAt: booking.created_at,
    owned: booking.owned,
    seats: seatResult.rows.map((seat) => ({
      seatId: seat.seat_id,
      section: seat.section,
      rowLabel: seat.row_label,
      number: seat.number,
      status: seat.status,
      pricePaise: seat.price_paise,
    })),
  };
}

/**
 * D25 `GET /me/bookings`: the caller's bookings, newest first, with event
 * title/start and a seat count. The query is owner-scoped, so another user's
 * rows never enter the result.
 */
export async function listUserBookings(
  pool: Pool,
  userId: string,
): Promise<UserBookingRecord[]> {
  const result = await pool.query<UserBookingRow>(
    `SELECT b.id, b.event_id, e.title AS event_title,
            e.starts_at AS event_starts_at, b.status, b.amount_paise,
            b.created_at,
            (SELECT count(*)::int
               FROM booking_seats bs
              WHERE bs.booking_id = b.id) AS seat_count
       FROM bookings b
       JOIN events e ON e.id = b.event_id
      WHERE b.user_id = $1
      ORDER BY b.created_at DESC, b.id DESC`,
    [userId],
  );

  return result.rows.map((booking) => ({
    id: booking.id,
    eventId: booking.event_id,
    eventTitle: booking.event_title,
    eventStartsAt: booking.event_starts_at,
    status: booking.status,
    amountPaise: booking.amount_paise,
    seatCount: booking.seat_count,
    createdAt: booking.created_at,
  }));
}
