import {
  ErrorResponseSchema,
  HealthResponseSchema,
  SignupRequestSchema,
  LoginRequestSchema,
  AuthResponseSchema,
  RefreshResponseSchema,
  EventSectionInputSchema,
  CreateEventRequestSchema,
  UpdateEventRequestSchema,
  PaginationQuerySchema,
  EventSummarySchema,
  SeatSchema,
  EventDetailSchema,
  PaginatedEventsResponseSchema,
  HoldRequestSchema,
  HoldResponseSchema,
  BookingStatusSchema,
  CheckoutResponseSchema,
  BookingSeatViewSchema,
  BookingDetailSchema,
  MeBookingsItemSchema,
  MeBookingsResponseSchema,
} from "@seatsync/shared";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  type ResponseConfig,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

const EventIdParamsSchema = z.object({ id: z.string().uuid() });
const HoldIdParamsSchema = z.object({ id: z.string().uuid() });
const BookingIdParamsSchema = z.object({ id: z.string().uuid() });
const WebhookProviderParamsSchema = z.object({
  provider: z.string().min(1),
});
const WebhookHeadersSchema = z.object({
  "x-fake-signature": z.string().optional().openapi({
    description:
      "Hex HMAC-SHA256 of the exact raw body keyed by PAYMENT_WEBHOOK_SECRET. " +
      "Required when PAYMENT_PROVIDER=fake.",
  }),
  "X-Razorpay-Signature": z.string().optional().openapi({
    description:
      "Razorpay's HMAC-SHA256 webhook signature header. Required when " +
      "PAYMENT_PROVIDER=razorpay.",
  }),
});
const WebhookBodySchema = z.object({}).passthrough().openapi({
  description:
    "The provider's JSON payload, delivered as raw bytes. The signature is " +
    "computed over those exact bytes, so the API mounts a raw body parser on " +
    "/webhooks before express.json().",
});
const WebhookReceivedResponseSchema = z.object({ received: z.boolean() });
const IdempotencyKeyHeaderSchema = z.object({
  "Idempotency-Key": z
    .string()
    .min(1)
    .openapi({
      description:
        "Client-generated idempotency key. Reusing a key with the same user and " +
        "body replays the stored response; a different user or body returns 422.",
      example: "3f1c2a0e-8b1e-4f0a-9a5e-9d1f6b7c8d90",
    }),
});

function jsonResponse(description: string, schema: z.ZodTypeAny): ResponseConfig {
  return {
    description,
    content: {
      "application/json": { schema },
    },
  };
}

function errorResponse(description: string): ResponseConfig {
  return jsonResponse(description, ErrorResponseSchema);
}

/**
 * Build the OpenAPI 3 document from the same zod schemas the routes validate
 * with, so the docs cannot drift from the implementation. Servers are omitted
 * on purpose: OpenAPI then serves paths relative to wherever Swagger UI is
 * hosted (local, Docker, CI), with no environment-specific URL hard-coded.
 */
export function generateOpenApiDocument() {
  const registry = new OpenAPIRegistry();

  registry.register("HealthResponse", HealthResponseSchema);
  registry.register("ErrorResponse", ErrorResponseSchema);
  registry.register("SignupRequest", SignupRequestSchema);
  registry.register("LoginRequest", LoginRequestSchema);
  registry.register("AuthResponse", AuthResponseSchema);
  registry.register("RefreshResponse", RefreshResponseSchema);
  registry.register("EventSectionInput", EventSectionInputSchema);
  registry.register("CreateEventRequest", CreateEventRequestSchema);
  registry.register("UpdateEventRequest", UpdateEventRequestSchema);
  registry.register("PaginationQuery", PaginationQuerySchema);
  registry.register("EventSummary", EventSummarySchema);
  registry.register("Seat", SeatSchema);
  registry.register("EventDetail", EventDetailSchema);
  registry.register("PaginatedEventsResponse", PaginatedEventsResponseSchema);
  registry.register("HoldRequest", HoldRequestSchema);
  registry.register("HoldResponse", HoldResponseSchema);
  registry.register("BookingStatus", BookingStatusSchema);
  registry.register("CheckoutResponse", CheckoutResponseSchema);
  registry.register("BookingSeatView", BookingSeatViewSchema);
  registry.register("BookingDetail", BookingDetailSchema);
  registry.register("MeBookingsItem", MeBookingsItemSchema);
  registry.register("MeBookingsResponse", MeBookingsResponseSchema);

  registry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });
  registry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "refresh_token",
  });

  registry.registerPath({
    method: "get",
    path: "/health",
    tags: ["health"],
    summary: "Check API, Postgres and Redis health",
    responses: {
      200: jsonResponse("Postgres and Redis are healthy", HealthResponseSchema),
      503: jsonResponse("At least one dependency is unavailable", HealthResponseSchema),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/auth/signup",
    tags: ["auth"],
    summary: "Create an ORGANIZER or ATTENDEE account",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: SignupRequestSchema } },
      },
    },
    responses: {
      201: jsonResponse("Account created and refresh cookie set", AuthResponseSchema),
      400: errorResponse("Validation failed"),
      409: errorResponse("Email already registered"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/auth/login",
    tags: ["auth"],
    summary: "Log in with email and password",
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: LoginRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse("Logged in and refresh cookie set", AuthResponseSchema),
      400: errorResponse("Validation failed"),
      401: errorResponse("Invalid email or password"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/auth/refresh",
    tags: ["auth"],
    summary: "Rotate the refresh cookie and issue a new access token",
    security: [{ cookieAuth: [] }],
    responses: {
      200: jsonResponse("New access token issued; refresh cookie rotated", RefreshResponseSchema),
      401: errorResponse("Refresh token missing, revoked or expired"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/auth/logout",
    tags: ["auth"],
    summary: "Revoke the presented refresh token and all of the user's active tokens",
    security: [{ bearerAuth: [] }],
    responses: {
      204: { description: "Logged out; refresh cookie cleared" },
      401: errorResponse("Missing or invalid access token"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/events",
    tags: ["events"],
    summary: "Create an event and its full seat layout in one transaction",
    security: [{ bearerAuth: [] }],
    request: {
      body: {
        required: true,
        content: { "application/json": { schema: CreateEventRequestSchema } },
      },
    },
    responses: {
      201: jsonResponse("Event created in DRAFT with every seat", EventDetailSchema),
      400: errorResponse("Validation failed"),
      401: errorResponse("Missing or invalid access token"),
      403: errorResponse("Organizer role required"),
      422: errorResponse("Seat layout violates seat constraints"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/events",
    tags: ["events"],
    summary: "List published events with cursor pagination",
    request: {
      query: PaginationQuerySchema,
    },
    responses: {
      200: jsonResponse("One page of published events", PaginatedEventsResponseSchema),
      400: errorResponse("Invalid query or pagination cursor"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/events/{id}",
    tags: ["events"],
    summary: "Get an event and all of its seats",
    description:
      "Published events are public. A DRAFT is returned only to its owner " +
      "organizer when a valid Bearer token is supplied; everyone else gets 404.",
    security: [{}, { bearerAuth: [] }],
    request: {
      params: EventIdParamsSchema,
    },
    responses: {
      200: jsonResponse("Event with every seat and its status", EventDetailSchema),
      400: errorResponse("Event id is not a UUID"),
      404: errorResponse("Event not found or draft hidden"),
    },
  });

  registry.registerPath({
    method: "patch",
    path: "/events/{id}",
    tags: ["events"],
    summary: "Update an owned event's title, venue or start time",
    security: [{ bearerAuth: [] }],
    request: {
      params: EventIdParamsSchema,
      body: {
        required: true,
        content: { "application/json": { schema: UpdateEventRequestSchema } },
      },
    },
    responses: {
      200: jsonResponse("Updated event", EventSummarySchema),
      400: errorResponse("Validation failed"),
      401: errorResponse("Missing or invalid access token"),
      403: errorResponse("Organizer role required or event not owned"),
      404: errorResponse("Event not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/events/{id}/publish",
    tags: ["events"],
    summary: "Publish an owned event",
    security: [{ bearerAuth: [] }],
    request: {
      params: EventIdParamsSchema,
    },
    responses: {
      200: jsonResponse("Event is now PUBLISHED", EventSummarySchema),
      400: errorResponse("Event id is not a UUID"),
      401: errorResponse("Missing or invalid access token"),
      403: errorResponse("Organizer role required or event not owned"),
      404: errorResponse("Event not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/events/{id}/unpublish",
    tags: ["events"],
    summary: "Return an owned event to DRAFT",
    security: [{ bearerAuth: [] }],
    request: {
      params: EventIdParamsSchema,
    },
    responses: {
      200: jsonResponse("Event is now DRAFT", EventSummarySchema),
      400: errorResponse("Event id is not a UUID"),
      401: errorResponse("Missing or invalid access token"),
      403: errorResponse("Organizer role required or event not owned"),
      404: errorResponse("Event not found"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/events/{id}/holds",
    tags: ["holds"],
    summary: "Hold seats for HOLD_TTL_SECONDS",
    description:
      "Rule 1 lock-then-update: the request either holds every requested seat " +
      "or none. Requires the Idempotency-Key header; a replay of the same key, " +
      "user and body returns the stored response verbatim while the user stays " +
      "within HOLDS_RATE_LIMIT_PER_MINUTE. Every authenticated attempt, replays " +
      "included, counts toward that per-user limit; the next attempt after the " +
      "limit is a 429 RATE_LIMITED and writes nothing to Postgres. Idempotent " +
      "replay is therefore conditional on the fixed 60 s rate window.",
    security: [{ bearerAuth: [] }],
    request: {
      params: EventIdParamsSchema,
      headers: IdempotencyKeyHeaderSchema,
      body: {
        required: true,
        content: { "application/json": { schema: HoldRequestSchema } },
      },
    },
    responses: {
      201: jsonResponse("Every requested seat is HELD for this user", HoldResponseSchema),
      400: errorResponse("Missing or blank Idempotency-Key header"),
      401: errorResponse("Missing or invalid access token"),
      404: errorResponse("Event not found or draft hidden"),
      409: errorResponse("One or more seats are unavailable, or the user already holds seats"),
      422: errorResponse("Invalid seat ids, too many seats, or idempotency key conflict"),
      429: errorResponse(
        "The user's per-minute hold rate limit was exceeded. Replays of a " +
          "stored 201/409 also count toward the limit and return 429 (not the " +
          "stored response) while the window is exhausted.",
      ),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/holds/{id}",
    tags: ["holds"],
    summary: "Release a hold; only the holder may release it",
    security: [{ bearerAuth: [] }],
    request: {
      params: HoldIdParamsSchema,
    },
    responses: {
      204: { description: "Hold released and every seat is AVAILABLE again" },
      400: errorResponse("Hold id is not a UUID"),
      401: errorResponse("Missing or invalid access token"),
      403: errorResponse("The authenticated user is not the holder"),
      404: errorResponse("Hold not found or already expired"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/holds/{id}/checkout",
    tags: ["payments"],
    summary: "Create a PENDING booking for a held set of seats",
    description:
      "Holder-only. A first call creates the PENDING booking and its " +
      "booking_seats, calls the configured provider and returns its checkout " +
      "URL with 201. A second call for the same hold replays the stored " +
      "booking with 200 and does not call the provider again.",
    security: [{ bearerAuth: [] }],
    request: {
      params: HoldIdParamsSchema,
    },
    responses: {
      201: jsonResponse("New PENDING booking and its checkout URL", CheckoutResponseSchema),
      200: jsonResponse("Existing booking for this hold replayed", CheckoutResponseSchema),
      400: errorResponse("Hold id is not a UUID"),
      401: errorResponse("Missing or invalid access token"),
      403: errorResponse("The authenticated user is not the holder"),
      404: errorResponse("Hold not found or already expired"),
      502: errorResponse("Payment provider failed to create a checkout"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/webhooks/{provider}",
    tags: ["payments"],
    summary: "Receive a payment provider webhook",
    description:
      "The provider authenticates the delivery with an HMAC over the exact raw " +
      "body, so no bearer token is used. Signature headers: " +
      "`x-fake-signature` for the fake provider and `X-Razorpay-Signature` for " +
      "Razorpay. The `provider` path segment must equal PAYMENT_PROVIDER. " +
      "Duplicate events and already-terminal bookings are acknowledged with " +
      "200; a bad signature or unknown provider returns 400 before any DB work.",
    request: {
      params: WebhookProviderParamsSchema,
      headers: WebhookHeadersSchema,
      body: {
        required: true,
        content: { "application/json": { schema: WebhookBodySchema } },
      },
    },
    responses: {
      200: jsonResponse(
        "Delivery processed, already processed, or a no-op for a terminal booking",
        WebhookReceivedResponseSchema,
      ),
      400: errorResponse(
        "Invalid signature, malformed body, or provider not configured",
      ),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/bookings/{id}",
    tags: ["bookings"],
    summary: "Get one of the authenticated user's bookings",
    description:
      "Owner only. The response carries the booking status, amount, payment " +
      "reference, checkout URL and every booked seat with its live seat status.",
    security: [{ bearerAuth: [] }],
    request: {
      params: BookingIdParamsSchema,
    },
    responses: {
      200: jsonResponse("The booking with its seats", BookingDetailSchema),
      400: errorResponse("Booking id is not a UUID"),
      401: errorResponse("Missing or invalid access token"),
      403: errorResponse("The booking belongs to another user"),
      404: errorResponse("Booking not found"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/me/bookings",
    tags: ["bookings"],
    summary: "List the authenticated user's bookings newest-first",
    security: [{ bearerAuth: [] }],
    responses: {
      200: jsonResponse(
        "The caller's bookings with event title/start and seat count",
        MeBookingsResponseSchema,
      ),
      401: errorResponse("Missing or invalid access token"),
    },
  });

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.3",
    info: {
      title: "SeatSync API",
      version: "1.0.0",
      description:
        "Event booking API: auth, organizer event management and published-event discovery.",
    },
  });
}
