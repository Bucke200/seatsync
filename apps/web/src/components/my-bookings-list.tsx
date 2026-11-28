"use client";

import type { BookingStatus, MeBookingsItem } from "@seatsync/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiClientError, listMyBookings } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";

const STATUS_STYLES: Record<BookingStatus, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  CONFIRMED: "bg-green-100 text-green-800",
  FAILED: "bg-red-100 text-red-800",
  REFUNDED: "bg-blue-100 text-blue-800",
};

function bookingsErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.status === 401) {
    return "Please log in to see your bookings.";
  }

  return error instanceof Error ? error.message : "Could not load your bookings.";
}

/**
 * Shared by `/me/bookings` and the profile page's bookings section: loads the
 * caller's bookings and renders each as a link to its detail page.
 */
export function MyBookingsList() {
  const [bookings, setBookings] = useState<MeBookingsItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const response = await listMyBookings();

        if (!cancelled) {
          setBookings(response.bookings);
        }
      } catch (err) {
        if (!cancelled) {
          setError(bookingsErrorMessage(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-4">
      {error !== null ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}

      {loading ? <p className="text-slate-600">Loading bookings…</p> : null}

      {!loading && error === null && bookings.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-600">
          You have no bookings yet. Hold seats on an event to start one.
        </p>
      ) : null}

      <ul className="space-y-4">
        {bookings.map((booking) => (
          <li key={booking.id}>
            <Link
              href={`/bookings/${booking.id}`}
              className="block rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-slate-400 hover:shadow"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">{booking.eventTitle}</h2>
                  <p className="mt-1 text-sm text-slate-600">
                    {formatDateTime(booking.eventStartsAt)}
                  </p>
                </div>
                <span
                  className={`rounded-full px-3 py-1 text-xs font-semibold ${STATUS_STYLES[booking.status]}`}
                >
                  {booking.status}
                </span>
              </div>
              <p className="mt-4 text-sm text-slate-700">
                {booking.seatCount} seat{booking.seatCount === 1 ? "" : "s"} ·{" "}
                {formatPaise(booking.amountPaise)}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
