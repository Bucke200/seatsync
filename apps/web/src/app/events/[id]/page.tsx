"use client";

import type { EventDetail, EventStatus, Seat, SeatStatus } from "@seatsync/shared";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { getEvent } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";

const SEAT_STATUS_STYLES: Record<SeatStatus, string> = {
  AVAILABLE: "border-green-300 bg-green-100 text-green-800",
  HELD: "border-amber-300 bg-amber-100 text-amber-800",
  BOOKED: "border-red-300 bg-red-100 text-red-800",
};

const EVENT_STATUS_STYLES: Record<EventStatus, string> = {
  DRAFT: "bg-amber-100 text-amber-800",
  PUBLISHED: "bg-green-100 text-green-800",
};

interface SeatRowGroup {
  rowLabel: string;
  seats: Seat[];
}

interface SectionGroup {
  name: string;
  pricePaise: number;
  rows: SeatRowGroup[];
}

function groupSeatsBySection(seats: Seat[]): SectionGroup[] {
  const sections = new Map<string, Map<string, Seat[]>>();

  for (const seat of seats) {
    const rows = sections.get(seat.section) ?? new Map<string, Seat[]>();
    const rowSeats = rows.get(seat.rowLabel) ?? [];
    rowSeats.push(seat);
    rows.set(seat.rowLabel, rowSeats);
    sections.set(seat.section, rows);
  }

  return [...sections.entries()].map(([name, rows]) => {
    const rowGroups = [...rows.entries()].map(([rowLabel, rowSeats]) => ({
      rowLabel,
      seats: [...rowSeats].sort((left, right) => left.number - right.number),
    }));
    const firstSeat = rowGroups[0]?.seats[0];

    return {
      name,
      pricePaise: firstSeat?.pricePaise ?? 0,
      rows: rowGroups,
    };
  });
}

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const eventId = params.id;
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadEvent(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const detail = await getEvent(eventId);

        if (!cancelled) {
          setEvent(detail);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load this event.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadEvent();

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const sections = event === null ? [] : groupSeatsBySection(event.seats);

  return (
    <main className="mx-auto max-w-6xl space-y-8 p-8">
      <header className="space-y-2">
        <Link href="/events" className="text-sm text-slate-500 underline">
          ← Back to events
        </Link>

        {event !== null ? (
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{event.title}</h1>
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${EVENT_STATUS_STYLES[event.status]}`}
            >
              {event.status}
            </span>
          </div>
        ) : (
          <h1 className="text-3xl font-bold tracking-tight">Event details</h1>
        )}

        {event !== null ? (
          <p className="text-slate-600">
            {event.venue} · {formatDateTime(event.startsAt)}
          </p>
        ) : null}
      </header>

      {loading && event === null ? <p className="text-slate-600">Loading event…</p> : null}

      {error !== null ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}

      {event !== null ? (
        <>
          <div className="flex flex-wrap items-center gap-4 text-xs text-slate-600">
            <span className="font-medium text-slate-700">Seat status</span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-green-300 bg-green-100" />
              AVAILABLE
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-amber-300 bg-amber-100" />
              HELD
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-red-300 bg-red-100" />
              BOOKED
            </span>
          </div>

          {sections.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-600">
              This event has no seats yet.
            </p>
          ) : (
            <div className="space-y-6">
              {sections.map((section) => (
                <section
                  key={section.name}
                  className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                  <header className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                    <h2 className="text-xl font-semibold">{section.name}</h2>
                    <p className="text-sm text-slate-600">
                      {formatPaise(section.pricePaise)} per seat
                    </p>
                  </header>

                  <div className="space-y-2 overflow-x-auto">
                    {section.rows.map((row) => (
                      <div key={row.rowLabel} className="flex items-center gap-3">
                        <span className="w-8 shrink-0 text-xs font-medium text-slate-500">
                          {row.rowLabel}
                        </span>
                        <div className="flex flex-wrap gap-1">
                          {row.seats.map((seat) => (
                            <span
                              key={seat.id}
                              title={`Row ${row.rowLabel} seat ${seat.number}: ${seat.status}`}
                              className={`flex h-7 w-7 items-center justify-center rounded border text-[10px] font-medium ${SEAT_STATUS_STYLES[seat.status]}`}
                            >
                              {seat.number}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </>
      ) : null}
    </main>
  );
}
