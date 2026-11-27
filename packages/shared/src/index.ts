import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

extendZodWithOpenApi(z);

export const HealthResponseSchema = z.object({
  db: z.enum(["ok", "error"]),
  redis: z.enum(["ok", "error"]),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const UserRoleSchema = z.enum(["ORGANIZER", "ATTENDEE"]);

export type UserRole = z.infer<typeof UserRoleSchema>;

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const SignupRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: UserRoleSchema,
});

export type SignupRequest = z.infer<typeof SignupRequestSchema>;

export const LoginRequestSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const AuthResponseSchema = z.object({
  user: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    role: UserRoleSchema,
  }),
  accessToken: z.string(),
});

export type AuthResponse = z.infer<typeof AuthResponseSchema>;

export const RefreshResponseSchema = z.object({
  accessToken: z.string(),
});

export type RefreshResponse = z.infer<typeof RefreshResponseSchema>;

export const EventStatusSchema = z.enum(["DRAFT", "PUBLISHED"]);

export type EventStatus = z.infer<typeof EventStatusSchema>;

export const SeatStatusSchema = z.enum(["AVAILABLE", "HELD", "BOOKED"]);

export type SeatStatus = z.infer<typeof SeatStatusSchema>;

export const EventSectionInputSchema = z.object({
  name: z.string().min(1),
  rows: z.number().int().positive(),
  seatsPerRow: z.number().int().positive(),
  pricePaise: z.number().int(),
});

export type EventSectionInput = z.infer<typeof EventSectionInputSchema>;

export const CreateEventRequestSchema = z.object({
  title: z.string().min(1),
  venue: z.string().min(1),
  startsAt: z.string().datetime({ offset: true }),
  sections: z.array(EventSectionInputSchema).min(1),
});

export type CreateEventRequest = z.infer<typeof CreateEventRequestSchema>;

export const UpdateEventRequestSchema = z
  .object({
    title: z.string().min(1),
    venue: z.string().min(1),
    startsAt: z.string().datetime({ offset: true }),
  })
  .partial();

export type UpdateEventRequest = z.infer<typeof UpdateEventRequestSchema>;

export const PaginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const EventSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  venue: z.string(),
  startsAt: z.string().datetime({ offset: true }),
  status: EventStatusSchema,
});

export type EventSummary = z.infer<typeof EventSummarySchema>;

export const SeatSchema = z.object({
  id: z.string().uuid(),
  section: z.string(),
  rowLabel: z.string(),
  number: z.number().int().positive(),
  pricePaise: z.number().int(),
  status: SeatStatusSchema,
  // D29: per-seat version for the client's stale-message filter. `GET
  // /events/:id` returns it, so a reconnecting client can rebuild its
  // `Map<seatId, version>` snapshot before applying live WS updates.
  version: z.number().int().nonnegative(),
  // D15: present only on the authenticated viewer's own active hold, so the
  // web app can offer Release after a reload. Public reads omit them.
  holdId: z.string().uuid().nullish(),
  heldUntil: z.string().datetime({ offset: true }).nullish(),
  heldByMe: z.boolean().optional(),
});

export type Seat = z.infer<typeof SeatSchema>;

export const EventDetailSchema = EventSummarySchema.extend({
  seats: z.array(SeatSchema),
});

export type EventDetail = z.infer<typeof EventDetailSchema>;

export const PaginatedEventsResponseSchema = z.object({
  events: z.array(EventSummarySchema),
  nextCursor: z.string().nullable(),
});

export type PaginatedEventsResponse = z.infer<typeof PaginatedEventsResponseSchema>;

export const HoldRequestSchema = z.object({
  seatIds: z.array(z.string().uuid()),
});

export type HoldRequest = z.infer<typeof HoldRequestSchema>;

export const HoldResponseSchema = z.object({
  holdId: z.string().uuid(),
  seatIds: z.array(z.string().uuid()),
  heldUntil: z.string().datetime({ offset: true }),
});

export type HoldResponse = z.infer<typeof HoldResponseSchema>;

export const BookingStatusSchema = z.enum([
  "PENDING",
  "CONFIRMED",
  "FAILED",
  "REFUNDED",
]);

export type BookingStatus = z.infer<typeof BookingStatusSchema>;

export const CheckoutResponseSchema = z.object({
  bookingId: z.string().uuid(),
  checkoutUrl: z.string(),
});

export type CheckoutResponse = z.infer<typeof CheckoutResponseSchema>;

/**
 * A booking's seat as the booking detail returns it. Section/row/number and
 * price come from the live `seats` row; `status` is that seat's current
 * AVAILABLE / HELD / BOOKED state, not the booking-level status.
 */
export const BookingSeatViewSchema = z.object({
  seatId: z.string().uuid(),
  section: z.string(),
  rowLabel: z.string(),
  number: z.number().int().positive(),
  status: SeatStatusSchema,
  pricePaise: z.number().int(),
});

export type BookingSeatView = z.infer<typeof BookingSeatViewSchema>;

export const BookingDetailSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  status: BookingStatusSchema,
  amountPaise: z.number().int(),
  paymentRef: z.string().nullable(),
  checkoutUrl: z.string().nullable(),
  holdId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  seats: z.array(BookingSeatViewSchema),
});

export type BookingDetail = z.infer<typeof BookingDetailSchema>;

export const MeBookingsItemSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  eventTitle: z.string(),
  eventStartsAt: z.string().datetime({ offset: true }),
  status: BookingStatusSchema,
  amountPaise: z.number().int(),
  seatCount: z.number().int(),
  createdAt: z.string().datetime({ offset: true }),
});

export type MeBookingsItem = z.infer<typeof MeBookingsItemSchema>;

export const MeBookingsResponseSchema = z.object({
  bookings: z.array(MeBookingsItemSchema),
});

export type MeBookingsResponse = z.infer<typeof MeBookingsResponseSchema>;

/**
 * D29 client-side stale filter (shared so the web app and API tests use one
 * implementation).
 *
 * `version` comes from `GET /events/:id` (`SeatSchema.version`) and from every
 * WebSocket seat update. A client keeps `Map<seatId, version>`; an update is
 * applied only when its version is strictly greater than the version already
 * seen for that seat. Strict `>` also drops duplicate deliveries of the same
 * version. A seat absent from the map (never seen, or a brand-new seat) has the
 * baseline version 0, so any committed change (versions start at 1) wins.
 */
export interface SeatVersionUpdate {
  id: string;
  version: number;
}

export interface SeatVersionFilterResult {
  /** Seat ids whose update should be applied (map was advanced for them). */
  accepted: string[];
  /** Seat ids whose update is outdated or a duplicate and must be ignored. */
  stale: string[];
}

/**
 * Filter `updates` against `current` and advance `current` for accepted ones.
 *
 * The map is mutated so callers can reuse it directly for the next message
 * (`current` is the single source of truth for what has been applied). Input
 * order is preserved; if the same id appears twice, the second is accepted
 * only when it carries a strictly newer version.
 */
export function applySeatVersionFilter(
  current: Map<string, number>,
  updates: ReadonlyArray<SeatVersionUpdate>,
): SeatVersionFilterResult {
  const accepted: string[] = [];
  const stale: string[] = [];

  for (const update of updates) {
    const currentVersion = current.get(update.id) ?? 0;

    if (update.version > currentVersion) {
      current.set(update.id, update.version);
      accepted.push(update.id);
    } else {
      stale.push(update.id);
    }
  }

  return { accepted, stale };
}

/**
 * Merge an authoritative `GET /events/:id` snapshot into the client's
 * `Map<seatId, version>` (D29 reconnect flow).
 *
 * Every seat in the snapshot overwrites its previous version, which is correct
 * after a reconnect: the database version is at least as new as anything the
 * client saw before losing the socket. Seats missing from the snapshot are
 * left untouched (the snapshot contains every seat, so this only preserves
 * stale ids if a caller passes a partial list). Pass a fresh map — or clear it
 * first — when the map must be fully repopulated for a different event.
 * Returns the same map instance for convenient chaining.
 */
export function mergeSeatSnapshot(
  current: Map<string, number>,
  seats: ReadonlyArray<SeatVersionUpdate>,
): Map<string, number> {
  for (const seat of seats) {
    current.set(seat.id, seat.version);
  }

  return current;
}
