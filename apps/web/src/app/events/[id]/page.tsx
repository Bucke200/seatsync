"use client";

import type { ErrorResponse, EventDetail, EventStatus, Seat, SeatStatus } from "@seatsync/shared";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { createCheckout, createHold, getEvent, releaseHold } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";

/**
 * D17: local copy of the seat-per-hold cap so the grid can stop selection at
 * six seats without a config endpoint. The server's `MAX_SEATS_PER_HOLD` is
 * authoritative and still answers 422 `TOO_MANY_SEATS`; this value only avoids
 * sending a request the web already knows will fail.
 */
const MAX_SEATS_PER_HOLD = 6;

const SEAT_STATUS_STYLES: Record<SeatStatus, string> = {
  AVAILABLE:
    "border-green-300 bg-green-100 text-green-800 hover:border-green-600 hover:bg-green-200",
  HELD: "border-amber-300 bg-amber-100 text-amber-800",
  BOOKED: "border-red-300 bg-red-100 text-red-800",
};

const SELECTED_SEAT_STYLE = "border-slate-900 bg-slate-900 text-white";
const MY_HOLD_SEAT_STYLE = "border-blue-400 bg-blue-100 text-blue-800";

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

interface ActiveHold {
  holdId: string;
  seatIds: string[];
  heldUntil: string;
}

interface OwnHeldSeat extends Seat {
  holdId: string;
  heldUntil: string;
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

/** D15: `GET /events/:id` exposes hold details only for the viewer's own seats. */
function isOwnHeldSeat(seat: Seat): seat is OwnHeldSeat {
  return (
    seat.heldByMe === true &&
    typeof seat.holdId === "string" &&
    typeof seat.heldUntil === "string"
  );
}

/**
 * Re-attach to an existing hold after a reload. D8 allows at most one active
 * hold per user per event, so the first own-held seat names the hold and the
 * rest of that hold's seats are grouped with it.
 */
function activeHoldFromEvent(detail: EventDetail): ActiveHold | null {
  const ownSeats = detail.seats.filter(isOwnHeldSeat);
  const first = ownSeats[0];

  if (first === undefined) {
    return null;
  }

  const seats = ownSeats.filter((seat) => seat.holdId === first.holdId);

  return {
    holdId: first.holdId,
    seatIds: seats.map((seat) => seat.id),
    heldUntil: first.heldUntil,
  };
}

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function seatLabel(seat: Seat): string {
  return `${seat.section} ${seat.rowLabel}${seat.number}`;
}

/** `details.seatIds` from a 409 envelope; defensive because `details` is unknown. */
function unavailableSeatIdsFrom(error: ErrorResponse): string[] {
  const details = error.error.details;

  if (typeof details !== "object" || details === null || !("seatIds" in details)) {
    return [];
  }

  const seatIds = (details as { seatIds?: unknown }).seatIds;

  if (!Array.isArray(seatIds)) {
    return [];
  }

  return seatIds.filter((id): id is string => typeof id === "string");
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export default function EventDetailPage() {
  const params = useParams<{ id: string }>();
  const eventId = params.id;
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>([]);
  const [activeHold, setActiveHold] = useState<ActiveHold | null>(null);
  const [holdError, setHoldError] = useState<string | null>(null);
  const [unavailableSeatIds, setUnavailableSeatIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const [paying, setPaying] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const refreshEvent = useCallback(async (): Promise<void> => {
    try {
      const detail = await getEvent(eventId);

      setEvent(detail);
      setActiveHold(activeHoldFromEvent(detail));
      // A refresh can turn a selected seat into HELD/BOOKED; drop those ids so
      // the next request never includes a seat that is no longer selectable.
      setSelectedSeatIds((current) =>
        current.filter((id) =>
          detail.seats.some((seat) => seat.id === id && seat.status === "AVAILABLE"),
        ),
      );
    } catch (err) {
      setError(messageFor(err));
    }
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;

    setSelectedSeatIds([]);
    setActiveHold(null);
    setHoldError(null);
    setUnavailableSeatIds([]);

    async function loadEvent(): Promise<void> {
      setLoading(true);
      setError(null);

      try {
        const detail = await getEvent(eventId);

        if (!cancelled) {
          setEvent(detail);
          setActiveHold(activeHoldFromEvent(detail));
        }
      } catch (err) {
        if (!cancelled) {
          setError(messageFor(err));
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

  // One shared ticker keeps the countdown and the per-seat tooltips live.
  useEffect(() => {
    if (activeHold === null) {
      return;
    }

    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, [activeHold]);

  const remainingMs = activeHold === null ? 0 : Date.parse(activeHold.heldUntil) - now;
  const holdExpired = activeHold !== null && remainingMs <= 0;
  const countdown = activeHold === null ? null : formatCountdown(remainingMs);

  // Display-only expiry: D9 already makes the expired seats read AVAILABLE, so
  // refreshing the detail is enough — no auto-release call is sent.
  useEffect(() => {
    if (!holdExpired) {
      return;
    }

    void refreshEvent();
  }, [holdExpired, refreshEvent]);

  const sections = event === null ? [] : groupSeatsBySection(event.seats);

  function labelForSeatId(seatId: string): string {
    const seat = event?.seats.find((candidate) => candidate.id === seatId);

    return seat === undefined ? seatId : seatLabel(seat);
  }

  function toggleSeat(seatId: string): void {
    setSelectedSeatIds((current) => {
      if (current.includes(seatId)) {
        return current.filter((id) => id !== seatId);
      }

      if (current.length >= MAX_SEATS_PER_HOLD) {
        return current;
      }

      return [...current, seatId];
    });
  }

  async function handleHold(): Promise<void> {
    if (selectedSeatIds.length === 0 || submitting) {
      return;
    }

    setSubmitting(true);
    setHoldError(null);
    setUnavailableSeatIds([]);

    try {
      // D2: a fresh key per click; never reuse a key for a different attempt.
      const result = await createHold(eventId, selectedSeatIds, crypto.randomUUID());

      if (result.status === 201) {
        setActiveHold({
          holdId: result.body.holdId,
          seatIds: result.body.seatIds,
          heldUntil: result.body.heldUntil,
        });
        setSelectedSeatIds([]);
        await refreshEvent();
      } else {
        setUnavailableSeatIds(unavailableSeatIdsFrom(result.body));
        setHoldError(result.body.error.message);
        await refreshEvent();
      }
    } catch (err) {
      // 422/400/404 and other errors carry the API envelope message.
      setHoldError(messageFor(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRelease(): Promise<void> {
    if (activeHold === null || releasing) {
      return;
    }

    setReleasing(true);
    setHoldError(null);
    setUnavailableSeatIds([]);

    try {
      await releaseHold(activeHold.holdId);
      setActiveHold(null);
      await refreshEvent();
    } catch (err) {
      setHoldError(messageFor(err));
      await refreshEvent();
    } finally {
      setReleasing(false);
    }
  }

  async function handlePay(): Promise<void> {
    if (activeHold === null || paying || holdExpired) {
      return;
    }

    setPaying(true);
    setHoldError(null);
    setUnavailableSeatIds([]);

    try {
      const checkout = await createCheckout(activeHold.holdId);

      // Fake URLs are same-origin paths; Razorpay's are absolute. Both work
      // with a full navigation.
      window.location.href = checkout.checkoutUrl;
    } catch (err) {
      setHoldError(messageFor(err));
      setPaying(false);
    }
  }

  const unavailableLabels = unavailableSeatIds.map(labelForSeatId);

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
          {holdError !== null ? (
            <div
              className={`rounded-lg px-4 py-3 text-sm ${
                unavailableLabels.length > 0
                  ? "bg-amber-50 text-amber-800"
                  : "bg-red-50 text-red-700"
              }`}
            >
              <p>{holdError}</p>
              {unavailableLabels.length > 0 ? (
                <p className="mt-1 font-medium">
                  No longer available: {unavailableLabels.join(", ")}
                </p>
              ) : null}
            </div>
          ) : null}

          {activeHold !== null ? (
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-blue-200 bg-blue-50 p-4">
              <div className="space-y-1">
                <p className="font-semibold text-blue-900">
                  {holdExpired ? "Hold expired" : `Your hold · ${countdown ?? "00:00"}`}
                </p>
                <p className="text-sm text-blue-800">
                  {activeHold.seatIds.length} seat
                  {activeHold.seatIds.length === 1 ? "" : "s"} ·{" "}
                  {activeHold.seatIds.map(labelForSeatId).join(", ")}
                </p>
                <p className="text-xs text-blue-700">
                  Expires {formatDateTime(activeHold.heldUntil)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handlePay()}
                  disabled={paying || holdExpired}
                  className="rounded-lg bg-blue-700 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {paying ? "Starting checkout…" : "Pay"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleRelease()}
                  disabled={releasing}
                  className="rounded-lg border border-blue-300 bg-white px-4 py-2 text-sm font-medium text-blue-900 transition hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {releasing ? "Releasing…" : "Release hold"}
                </button>
              </div>
            </section>
          ) : null}

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
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-slate-900 bg-slate-900" />
              SELECTED
            </span>
            <span className="flex items-center gap-1">
              <span className="h-3 w-3 rounded border border-blue-400 bg-blue-100" />
              YOUR HOLD
            </span>
          </div>

          {event.status === "PUBLISHED" ? (
            <div className="space-y-3 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold">Hold seats</h2>
                  <p className="text-sm text-slate-600">
                    {selectedSeatIds.length} of {MAX_SEATS_PER_HOLD} selected
                    {selectedSeatIds.length === MAX_SEATS_PER_HOLD
                      ? " · maximum reached"
                      : ""}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleHold()}
                  disabled={
                    selectedSeatIds.length === 0 || submitting || activeHold !== null
                  }
                  className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Holding…" : "Hold selected seats"}
                </button>
              </div>
              {activeHold !== null ? (
                <p className="text-xs text-slate-500">
                  Release your current hold before holding other seats.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-800">
              Publish this event before holding seats.
            </p>
          )}

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
                          {row.seats.map((seat) => {
                            const isSelected = selectedSeatIds.includes(seat.id);
                            const isMine = seat.heldByMe === true;

                            if (seat.status === "AVAILABLE") {
                              return (
                                <button
                                  key={seat.id}
                                  type="button"
                                  aria-pressed={isSelected}
                                  title={`Row ${row.rowLabel} seat ${seat.number}: ${
                                    isSelected ? "selected" : "available"
                                  }`}
                                  onClick={() => toggleSeat(seat.id)}
                                  className={`flex h-7 w-7 items-center justify-center rounded border text-[10px] font-medium transition ${
                                    isSelected
                                      ? SELECTED_SEAT_STYLE
                                      : SEAT_STATUS_STYLES.AVAILABLE
                                  }`}
                                >
                                  {seat.number}
                                </button>
                              );
                            }

                            return (
                              <button
                                key={seat.id}
                                type="button"
                                disabled
                                title={`Row ${row.rowLabel} seat ${seat.number}: ${
                                  isMine
                                    ? `your hold${countdown === null ? "" : `, ${countdown} left`}`
                                    : seat.status
                                }`}
                                className={`flex h-7 w-7 cursor-not-allowed items-center justify-center rounded border text-[10px] font-medium ${
                                  isMine
                                    ? MY_HOLD_SEAT_STYLE
                                    : SEAT_STATUS_STYLES[seat.status]
                                }`}
                              >
                                {seat.number}
                              </button>
                            );
                          })}
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
