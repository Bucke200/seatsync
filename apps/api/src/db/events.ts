import type { EventSectionInput, EventStatus } from "@seatsync/shared";
import type { Pool, QueryResultRow } from "pg";
import { ApiError } from "../middleware/errors";
import { insertSectionSeats } from "./seats";

export interface EventRecord {
  id: string;
  organizerId: string;
  title: string;
  venue: string;
  startsAt: Date;
  status: EventStatus;
  createdAt: Date;
}

export interface CreateEventInput {
  organizerId: string;
  title: string;
  venue: string;
  startsAt: Date;
  sections: EventSectionInput[];
}

export interface UpdateEventInput {
  title?: string;
  venue?: string;
  startsAt?: Date;
}

export interface EventCursor {
  startsAt: Date;
  id: string;
}

export interface ListPublishedEventsInput {
  cursor: EventCursor | null;
  limit: number;
}

export interface PublishedEventPage {
  events: EventRecord[];
  nextCursor: EventCursor | null;
}

interface EventRow extends QueryResultRow {
  id: string;
  organizer_id: string;
  title: string;
  venue: string;
  starts_at: Date;
  status: EventStatus;
  created_at: Date;
}

const EVENT_COLUMNS = "id, organizer_id, title, venue, starts_at, status, created_at";

function toEventRecord(row: EventRow): EventRecord {
  return {
    id: row.id,
    organizerId: row.organizer_id,
    title: row.title,
    venue: row.venue,
    startsAt: row.starts_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

function hasPgErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

/**
 * Insert an event and every seat of its layout in one transaction. If any
 * section violates a seat constraint (negative price, duplicate seat), the
 * whole event is rolled back: there is never an event without its seats.
 */
export async function createEventWithSeats(
  pool: Pool,
  input: CreateEventInput,
): Promise<EventRecord> {
  const client = await pool.connect();
  let transactionOpen = false;

  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const result = await client.query<EventRow>(
      `INSERT INTO events (organizer_id, title, venue, starts_at)
       VALUES ($1, $2, $3, $4)
       RETURNING ${EVENT_COLUMNS}`,
      [input.organizerId, input.title, input.venue, input.startsAt],
    );
    const event = toEventRecord(result.rows[0]);

    for (const section of input.sections) {
      await insertSectionSeats(client, event.id, section);
    }

    await client.query("COMMIT");
    transactionOpen = false;

    return event;
  } catch (error) {
    if (transactionOpen) {
      await client.query("ROLLBACK");
    }

    if (hasPgErrorCode(error, "23514") || hasPgErrorCode(error, "23505")) {
      throw new ApiError(422, "INVALID_SEAT_LAYOUT", "Seat layout violates seat constraints");
    }

    throw error;
  } finally {
    client.release();
  }
}

export async function getEventById(pool: Pool, id: string): Promise<EventRecord | null> {
  const result = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];

  return row === undefined ? null : toEventRecord(row);
}

export async function updateEvent(
  pool: Pool,
  id: string,
  input: UpdateEventInput,
): Promise<EventRecord | null> {
  const result = await pool.query<EventRow>(
    `UPDATE events
        SET title = COALESCE($2, title),
            venue = COALESCE($3, venue),
            starts_at = COALESCE($4::timestamptz, starts_at)
      WHERE id = $1
      RETURNING ${EVENT_COLUMNS}`,
    [id, input.title ?? null, input.venue ?? null, input.startsAt ?? null],
  );
  const row = result.rows[0];

  return row === undefined ? null : toEventRecord(row);
}

export async function setEventStatus(
  pool: Pool,
  id: string,
  status: EventStatus,
): Promise<EventRecord | null> {
  const result = await pool.query<EventRow>(
    `UPDATE events
        SET status = $2
      WHERE id = $1
      RETURNING ${EVENT_COLUMNS}`,
    [id, status],
  );
  const row = result.rows[0];

  return row === undefined ? null : toEventRecord(row);
}

/**
 * Cursor page ordered by `(starts_at, id)`. Fetch one extra row so the caller
 * can tell whether another page exists without a second count query.
 */
export async function listPublishedEvents(
  pool: Pool,
  input: ListPublishedEventsInput,
): Promise<PublishedEventPage> {
  const result = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS}
       FROM events
      WHERE status = 'PUBLISHED'
        AND ($1::timestamptz IS NULL OR (starts_at, id) > ($1::timestamptz, $2::uuid))
      ORDER BY starts_at ASC, id ASC
      LIMIT $3`,
    [input.cursor?.startsAt ?? null, input.cursor?.id ?? null, input.limit + 1],
  );

  const rows = result.rows.map(toEventRecord);
  const hasMore = rows.length > input.limit;
  const events = hasMore ? rows.slice(0, input.limit) : rows;
  const last = events[events.length - 1];

  return {
    events,
    nextCursor: hasMore && last !== undefined ? { startsAt: last.startsAt, id: last.id } : null,
  };
}
