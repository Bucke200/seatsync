"use client";

import type { BookingDetail, BookingStatus } from "@seatsync/shared";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ApiClientError, getBooking } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";

const POLL_INTERVAL_MS = 2_000;

const TERMINAL_STATUSES: ReadonlySet<BookingStatus> = new Set([
  "CONFIRMED",
  "FAILED",
  "REFUNDED",
]);

const STATUS_STYLES: Record<BookingStatus, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  CONFIRMED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
  REFUNDED: "bg-blue-100 text-blue-800",
};

const STATUS_HINTS: Record<BookingStatus, string> = {
  PENDING: "Waiting for the payment provider to confirm this booking.",
  CONFIRMED: "Payment confirmed — your seats are booked.",
  FAILED: "This payment could not be completed. A refund follows if money was taken.",
  REFUNDED: "This booking was refunded. The seats are no longer reserved.",
};

/**
 * 401/403/404 come from the API envelope and stop the poll; any other error is
 * treated as transient so the page keeps retrying.
 */
function bookingErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 401) {
      return "Please log in to view this booking.";
    }

    if (error.status === 403) {
      return "This booking belongs to another account.";
    }

    if (error.status === 404) {
      return "Booking not found.";
    }

    return error.message;
  }

  return error instanceof Error ? error.message : "Could not load this booking.";
}

function isTerminalError(error: unknown): boolean {
  return (
    error instanceof ApiClientError &&
    (error.status === 401 || error.status === 403 || error.status === 404)
  );
}

export default function BookingDetailPage() {
  const params = useParams<{ id: string }>();
  const bookingId = params.id;
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll(): Promise<void> {
      try {
        const detail = await getBooking(bookingId);

        if (cancelled) {
          return;
        }

        setBooking(detail);
        setError(null);
        setLoading(false);

        if (!TERMINAL_STATUSES.has(detail.status)) {
          timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }

        setError(bookingErrorMessage(err));
        setLoading(false);

        if (!isTerminalError(err)) {
          timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
        }
      }
    }

    void poll();

    return () => {
      cancelled = true;

      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [bookingId]);

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-8">
      <header className="space-y-1">
        <Link href="/me/bookings" className="text-sm text-slate-500 underline">
          ← My bookings
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Booking</h1>
        {booking !== null ? (
          <p className="text-slate-600">
            <Link href={`/events/${booking.eventId}`} className="underline">
              View event
            </Link>{" "}
            · created {formatDateTime(booking.createdAt)}
          </p>
        ) : null}
      </header>

      {loading && booking === null ? (
        <p className="text-slate-600">Loading booking…</p>
      ) : null}

      {error !== null ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}

      {booking !== null ? (
        <>
          <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[booking.status]}`}
              >
                {booking.status}
              </span>
              <p className="text-2xl font-semibold">{formatPaise(booking.amountPaise)}</p>
            </div>

            <p className="text-sm text-slate-600">{STATUS_HINTS[booking.status]}</p>

            {booking.status === "PENDING" ? (
              <p className="text-xs text-slate-500">
                This page refreshes every {POLL_INTERVAL_MS / 1000} seconds until the
                provider answers.
              </p>
            ) : null}

            <div className="space-y-2">
              <h2 className="text-lg font-semibold">
                {booking.seats.length} seat{booking.seats.length === 1 ? "" : "s"}
              </h2>
              <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
                {booking.seats.map((seat) => (
                  <li
                    key={seat.seatId}
                    className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm"
                  >
                    <span className="font-medium">
                      {seat.section} · {seat.rowLabel}
                      {seat.number}
                    </span>
                    <span className="text-slate-600">
                      {formatPaise(seat.pricePaise)} · {seat.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <p className="text-xs text-slate-500">
            Payment reference: {booking.paymentRef ?? "not captured yet"}
          </p>
        </>
      ) : null}
    </main>
  );
}
