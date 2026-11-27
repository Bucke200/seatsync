import type {
  CreateEventRequest,
  EventDetail,
  EventSummary,
  PaginatedEventsResponse,
  PaginationQuery,
  UpdateEventRequest,
} from "@seatsync/shared";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createEventWithSeats,
  getEventById,
  listPublishedEvents,
  setEventStatus,
  updateEvent as updateEventRecord,
  type EventCursor,
  type EventRecord,
} from "../db/events";
import { listSeatsByEventId } from "../db/seats";
import { ApiError } from "../middleware/errors";

const CursorPayloadSchema = z.object({
  startsAt: z.string().datetime({ offset: true }),
  id: z.string().uuid(),
});

function toEventSummary(event: EventRecord): EventSummary {
  return {
    id: event.id,
    title: event.title,
    venue: event.venue,
    startsAt: event.startsAt.toISOString(),
    status: event.status,
  };
}

function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(
    JSON.stringify({ startsAt: cursor.startsAt.toISOString(), id: cursor.id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): EventCursor {
  try {
    const payload = CursorPayloadSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );

    return { startsAt: new Date(payload.startsAt), id: payload.id };
  } catch {
    throw new ApiError(400, "INVALID_CURSOR", "Invalid pagination cursor");
  }
}

function eventNotFound(): ApiError {
  return new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
}

async function requireOwnedEvent(
  pool: Pool,
  eventId: string,
  userId: string,
): Promise<EventRecord> {
  const event = await getEventById(pool, eventId);

  if (event === null) {
    throw eventNotFound();
  }

  if (event.organizerId !== userId) {
    throw new ApiError(403, "FORBIDDEN", "You do not own this event");
  }

  return event;
}

async function buildEventDetail(
  pool: Pool,
  event: EventRecord,
  viewerUserId?: string,
): Promise<EventDetail> {
  // D15: only the viewer's own active hold adds holdId/heldUntil/heldByMe;
  // every other seat and every anonymous read omits them.
  const seats = await listSeatsByEventId(pool, event.id, { viewerUserId });

  return { ...toEventSummary(event), seats };
}

async function changeStatus(
  pool: Pool,
  eventId: string,
  userId: string,
  status: "PUBLISHED" | "DRAFT",
): Promise<EventSummary> {
  await requireOwnedEvent(pool, eventId, userId);

  const updated = await setEventStatus(pool, eventId, status);

  if (updated === null) {
    throw eventNotFound();
  }

  return toEventSummary(updated);
}

export async function createEvent(
  pool: Pool,
  organizerId: string,
  input: CreateEventRequest,
): Promise<EventDetail> {
  const event = await createEventWithSeats(pool, {
    organizerId,
    title: input.title,
    venue: input.venue,
    startsAt: new Date(input.startsAt),
    sections: input.sections,
  });

  return buildEventDetail(pool, event);
}

export async function listEvents(
  pool: Pool,
  query: PaginationQuery,
): Promise<PaginatedEventsResponse> {
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const page = await listPublishedEvents(pool, { cursor, limit: query.limit });

  return {
    events: page.events.map(toEventSummary),
    nextCursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
  };
}

/**
 * Published events are public. A DRAFT is only visible to its owner organizer;
 * everyone else gets the same 404 as a missing event so drafts stay hidden.
 */
export async function getEventDetail(
  pool: Pool,
  eventId: string,
  viewer: { id: string } | undefined,
): Promise<EventDetail> {
  const event = await getEventById(pool, eventId);

  if (event === null || (event.status !== "PUBLISHED" && viewer?.id !== event.organizerId)) {
    throw eventNotFound();
  }

  return buildEventDetail(pool, event, viewer?.id);
}

export async function updateEvent(
  pool: Pool,
  eventId: string,
  userId: string,
  input: UpdateEventRequest,
): Promise<EventSummary> {
  await requireOwnedEvent(pool, eventId, userId);

  const updated = await updateEventRecord(pool, eventId, {
    title: input.title,
    venue: input.venue,
    startsAt: input.startsAt === undefined ? undefined : new Date(input.startsAt),
  });

  if (updated === null) {
    throw eventNotFound();
  }

  return toEventSummary(updated);
}

export async function publishEvent(
  pool: Pool,
  eventId: string,
  userId: string,
): Promise<EventSummary> {
  return changeStatus(pool, eventId, userId, "PUBLISHED");
}

export async function unpublishEvent(
  pool: Pool,
  eventId: string,
  userId: string,
): Promise<EventSummary> {
  return changeStatus(pool, eventId, userId, "DRAFT");
}
