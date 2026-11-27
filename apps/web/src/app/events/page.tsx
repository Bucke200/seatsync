"use client";

import type { EventSummary } from "@seatsync/shared";
import Link from "next/link";
import { useEffect, useState } from "react";
import { listPublishedEvents } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const PAGE_SIZE = 10;

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "Could not load events.";
}

export default function EventsPage() {
  const [events, setEvents] = useState<EventSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadFirstPage(): Promise<void> {
      try {
        const page = await listPublishedEvents(PAGE_SIZE, null);

        if (!cancelled) {
          setEvents(page.events);
          setNextCursor(page.nextCursor);
        }
      } catch (err) {
        if (!cancelled) {
          setError(messageFor(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setLoaded(true);
        }
      }
    }

    void loadFirstPage();

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleNextPage(): Promise<void> {
    if (nextCursor === null) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const page = await listPublishedEvents(PAGE_SIZE, nextCursor);
      setEvents((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-8 p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <Link href="/" className="text-sm text-slate-500 underline">
            ← SeatSync home
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Published events</h1>
          <p className="text-slate-600">Open an event to see its static seat grid.</p>
        </div>
        <nav className="flex gap-3 text-sm">
          <Link href="/login" className="rounded-lg border border-slate-300 px-3 py-2">
            Log in
          </Link>
          <Link href="/signup" className="rounded-lg border border-slate-300 px-3 py-2">
            Sign up
          </Link>
          <Link
            href="/organizer/events/new"
            className="rounded-lg bg-slate-900 px-3 py-2 font-medium text-white"
          >
            Create event
          </Link>
        </nav>
      </header>

      {error !== null ? (
        <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
      ) : null}

      {loading && events.length === 0 ? <p className="text-slate-600">Loading events…</p> : null}

      {loaded && events.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-slate-300 p-8 text-center text-slate-600">
          No published events yet.
        </p>
      ) : null}

      <ul className="grid gap-4 sm:grid-cols-2">
        {events.map((event) => (
          <li key={event.id}>
            <Link
              href={`/events/${event.id}`}
              className="block h-full rounded-2xl border border-slate-200 bg-white p-6 shadow-sm transition hover:border-slate-400 hover:shadow"
            >
              <h2 className="text-lg font-semibold text-slate-900">{event.title}</h2>
              <p className="mt-1 text-sm text-slate-600">{event.venue}</p>
              <p className="mt-3 text-sm text-slate-500">{formatDateTime(event.startsAt)}</p>
            </Link>
          </li>
        ))}
      </ul>

      <div className="flex justify-center">
        <button
          type="button"
          onClick={() => void handleNextPage()}
          disabled={nextCursor === null || loading}
          className="rounded-lg bg-slate-900 px-5 py-2 font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Loading…" : nextCursor === null ? "All events loaded" : "Next page"}
        </button>
      </div>
    </main>
  );
}
