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
