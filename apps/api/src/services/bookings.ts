import type {
  BookingDetail,
  MeBookingsItem,
  MeBookingsResponse,
} from "@seatsync/shared";
import type { Pool } from "pg";
import type { Config } from "../config";
import {
  createCheckoutForHold,
  getBookingDetail as getBookingDetailRecord,
  listUserBookings,
  type BookingDetailRecord,
  type UserBookingRecord,
} from "../db/bookings";
import { ApiError } from "../middleware/errors";
import { createPaymentProvider } from "../payments";

/**
 * Checkout orchestration (D21). Thin on purpose: the transaction, locking and
 * SQL live in `db/bookings.ts`; this layer only builds the configured provider
 * and turns `created` into the HTTP status (201 new, 200 replayed).
 */

export interface CheckoutHoldInput {
  holdId: string;
  userId: string;
}

export interface CheckoutHoldOutcome {
  statusCode: 200 | 201;
  body: {
    bookingId: string;
    checkoutUrl: string;
  };
}

export async function checkoutHold(
  pool: Pool,
  config: Config,
  input: CheckoutHoldInput,
): Promise<CheckoutHoldOutcome> {
  let provider: ReturnType<typeof createPaymentProvider>;

  try {
    provider = createPaymentProvider(config);
  } catch {
    // A misconfigured/unimplemented provider is the provider's fault, not the
    // caller's; keep the response shape identical to a mid-transaction failure.
    throw new ApiError(
      502,
      "PROVIDER_ERROR",
      `Payment provider (${config.PAYMENT_PROVIDER}) is not available`,
    );
  }

  const result = await createCheckoutForHold(pool, config, provider, input);

  return {
    statusCode: result.created ? 201 : 200,
    body: {
      bookingId: result.bookingId,
      checkoutUrl: result.checkoutUrl,
    },
  };
}

function toBookingDetail(record: BookingDetailRecord): BookingDetail {
  return {
    id: record.id,
    eventId: record.eventId,
    status: record.status,
    amountPaise: record.amountPaise,
    paymentRef: record.paymentRef,
    checkoutUrl: record.checkoutUrl,
    holdId: record.holdId,
    createdAt: record.createdAt.toISOString(),
    seats: record.seats,
  };
}

function toMeBookingsItem(record: UserBookingRecord): MeBookingsItem {
  return {
    id: record.id,
    eventId: record.eventId,
    eventTitle: record.eventTitle,
    eventStartsAt: record.eventStartsAt.toISOString(),
    status: record.status,
    amountPaise: record.amountPaise,
    seatCount: record.seatCount,
    createdAt: record.createdAt.toISOString(),
  };
}

/**
 * D25 `GET /bookings/:id`. Missing bookings are 404; a booking that belongs to
 * someone else is 403. The db row query computes ownership from the same row,
 * so the two cases cannot collapse into one empty result.
 */
export async function getBookingDetail(
  pool: Pool,
  bookingId: string,
  userId: string,
): Promise<BookingDetail> {
  const record = await getBookingDetailRecord(pool, { bookingId, userId });

  if (record === null) {
    throw new ApiError(404, "BOOKING_NOT_FOUND", "Booking not found");
  }

  if (!record.owned) {
    throw new ApiError(403, "FORBIDDEN", "You do not own this booking");
  }

  return toBookingDetail(record);
}

/** D25 `GET /me/bookings`: the caller's bookings, newest first. */
export async function listMyBookings(
  pool: Pool,
  userId: string,
): Promise<MeBookingsResponse> {
  const records = await listUserBookings(pool, userId);

  return { bookings: records.map(toMeBookingsItem) };
}
