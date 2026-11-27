"use client";

import {
  CreateEventRequestSchema,
  type CreateEventRequest,
  type EventDetail,
} from "@seatsync/shared";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ApiClientError, createEvent, getAccessToken, publishEvent } from "@/lib/api";
import { formatDateTime, formatPaise } from "@/lib/format";

interface SectionDraft {
  name: string;
  rows: string;
  seatsPerRow: string;
  pricePaise: string;
}

function emptySection(): SectionDraft {
  return { name: "", rows: "1", seatsPerRow: "1", pricePaise: "100" };
}

export default function NewEventPage() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [title, setTitle] = useState("");
  const [venue, setVenue] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [sections, setSections] = useState<SectionDraft[]>([emptySection()]);
  const [created, setCreated] = useState<EventDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setAuthenticated(getAccessToken() !== null);
  }, []);

  function updateSection(index: number, field: keyof SectionDraft, value: string): void {
    setSections((current) =>
      current.map((section, position) => {
        if (position !== index) {
          return section;
        }

        const updated = { ...section };
        updated[field] = value;
        return updated;
      }),
    );
  }

  function addSection(): void {
    setSections((current) => [...current, emptySection()]);
  }

  function removeSection(index: number): void {
    setSections((current) =>
      current.length <= 1 ? current : current.filter((_, position) => position !== index),
    );
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setCreated(null);

    const start = new Date(startsAt);

    if (Number.isNaN(start.getTime())) {
      setError("Pick a valid start date and time.");
      return;
    }

    const payload: CreateEventRequest = {
      title,
      venue,
      startsAt: start.toISOString(),
      sections: sections.map((section) => ({
        name: section.name,
        rows: Number(section.rows),
        seatsPerRow: Number(section.seatsPerRow),
        pricePaise: Number(section.pricePaise),
      })),
    };

    const parsed = CreateEventRequestSchema.safeParse(payload);

    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check the event details.");
      return;
    }

    setCreating(true);

    try {
      const detail = await createEvent(parsed.data);
      setCreated(detail);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not create the event.");
    } finally {
      setCreating(false);
    }
  }

  async function handlePublish(): Promise<void> {
    if (created === null) {
      return;
    }

    setError(null);
    setPublishing(true);

    try {
      const summary = await publishEvent(created.id);
      setCreated({ ...created, status: summary.status });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not publish the event.");
    } finally {
      setPublishing(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-8">
      <header className="space-y-2">
        <Link href="/" className="text-sm text-slate-500 underline">
          ← SeatSync home
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Create an event</h1>
        <p className="text-slate-600">
          Build a seat layout, create the event as a draft, then publish it.
        </p>
      </header>

      {authenticated === null ? <p className="text-slate-600">Checking your session…</p> : null}

      {authenticated === false ? (
        <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
          <p>You need an organizer account to create events.</p>
          <p className="flex gap-4">
            <Link href="/login" className="font-medium underline">
              Log in
            </Link>
            <Link href="/signup" className="font-medium underline">
              Sign up as an organizer
            </Link>
          </p>
        </div>
      ) : null}

      {authenticated === true ? (
        <>
          {created !== null ? (
            <section className="space-y-3 rounded-2xl border border-green-200 bg-green-50 p-6">
              <div className="flex flex-wrap items-center gap-3">
                <h2 className="text-xl font-semibold text-green-900">
                  {created.status === "PUBLISHED" ? "Event published" : "Event created"}
                </h2>
                <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-green-800">
                  {created.status}
                </span>
              </div>
              <p className="text-sm text-green-900">
                {created.title} · {created.venue} · {formatDateTime(created.startsAt)}
              </p>
              <p className="text-sm text-green-900">
                {created.seats.length} seats ·{" "}
                {created.seats.length > 0 ? formatPaise(created.seats[0].pricePaise) : "—"}
              </p>
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <Link
                  href={`/events/${created.id}`}
                  className="font-medium text-green-900 underline"
                >
                  View event and seat grid
                </Link>
                {created.status === "DRAFT" ? (
                  <button
                    type="button"
                    onClick={() => void handlePublish()}
                    disabled={publishing}
                    className="rounded-lg bg-green-800 px-4 py-2 font-medium text-white transition hover:bg-green-700 disabled:opacity-60"
                  >
                    {publishing ? "Publishing…" : "Publish event"}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}

          {error !== null ? (
            <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
          ) : null}

          <form onSubmit={(event) => void handleCreate(event)} className="space-y-6">
            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-semibold">Event details</h2>

              <label className="block text-sm font-medium text-slate-700">
                Title
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Venue
                <input
                  type="text"
                  required
                  value={venue}
                  onChange={(event) => setVenue(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </label>

              <label className="block text-sm font-medium text-slate-700">
                Starts at
                <input
                  type="datetime-local"
                  required
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                />
              </label>
            </section>

            <section className="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Sections</h2>
                <button
                  type="button"
                  onClick={addSection}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium"
                >
                  Add section
                </button>
              </div>

              <div className="space-y-4">
                {sections.map((section, index) => (
                  <div
                    key={index}
                    className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
                  >
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-slate-700">Section {index + 1}</h3>
                      <button
                        type="button"
                        onClick={() => removeSection(index)}
                        disabled={sections.length <= 1}
                        className="text-sm font-medium text-red-700 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block text-sm font-medium text-slate-700">
                        Name
                        <input
                          type="text"
                          required
                          value={section.name}
                          onChange={(event) => updateSection(index, "name", event.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                        />
                      </label>

                      <label className="block text-sm font-medium text-slate-700">
                        Rows
                        <input
                          type="number"
                          required
                          min={1}
                          step={1}
                          value={section.rows}
                          onChange={(event) => updateSection(index, "rows", event.target.value)}
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                        />
                      </label>

                      <label className="block text-sm font-medium text-slate-700">
                        Seats per row
                        <input
                          type="number"
                          required
                          min={1}
                          step={1}
                          value={section.seatsPerRow}
                          onChange={(event) =>
                            updateSection(index, "seatsPerRow", event.target.value)
                          }
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                        />
                      </label>

                      <label className="block text-sm font-medium text-slate-700">
                        Price per seat (paise)
                        <input
                          type="number"
                          required
                          step={1}
                          value={section.pricePaise}
                          onChange={(event) =>
                            updateSection(index, "pricePaise", event.target.value)
                          }
                          className="mt-1 w-full rounded-lg border border-slate-300 px-3 py-2 font-normal outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                        />
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <button
              type="submit"
              disabled={creating}
              className="w-full rounded-lg bg-slate-900 px-4 py-3 font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
            >
              {creating ? "Creating event…" : "Create event"}
            </button>
          </form>
        </>
      ) : null}
    </main>
  );
}
