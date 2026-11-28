import {
  AuthResponseSchema,
  BookingDetailSchema,
  CheckoutResponseSchema,
  ErrorResponseSchema,
  EventDetailSchema,
  EventSummarySchema,
  HoldResponseSchema,
  MeBookingsResponseSchema,
  PaginatedEventsResponseSchema,
  RefreshResponseSchema,
} from "@seatsync/shared";
import type {
  AuthResponse,
  BookingDetail,
  CheckoutResponse,
  CreateEventRequest,
  ErrorResponse,
  EventDetail,
  EventSummary,
  HoldResponse,
  LoginRequest,
  MeBookingsResponse,
  PaginatedEventsResponse,
  SignupRequest,
  UserRole,
} from "@seatsync/shared";

const ACCESS_TOKEN_KEY = "seatsync.accessToken";
const AUTH_USER_KEY = "seatsync.authUser";

/**
 * Same-tab broadcast fired whenever the stored session changes. The root nav
 * and the profile page listen for it so a login, logout or token refresh
 * re-renders the auth UI without a full page load.
 */
export const AUTH_CHANGE_EVENT = "seatsync:auth";

/** The identity the web app can render for the signed-in user. */
export interface AuthUser {
  email: string;
  role: UserRole;
}

/**
 * The access token's JWT payload only signs `sub` and `role` (see
 * `apps/api/src/services/auth.ts`), so `setAccessToken` opportunistically
 * caches the email returned by login/signup. The cache carries the same `sub`
 * and is only used while it still matches the token in storage.
 */
interface CachedAuthUser extends AuthUser {
  sub: string | null;
}

function notifyAuthChange(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.dispatchEvent(new CustomEvent(AUTH_CHANGE_EVENT));
}

/** Errors surfaced by the API, carrying its machine-readable code. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** The parsed `{ error: { ... } }` envelope, when the API sent one. */
    public readonly body?: ErrorResponse,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export function getAccessToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

/**
 * Store an access token and, when the caller has it, the identity returned by
 * login/signup. The optional identity is only used for the email, which the
 * signed JWT does not carry; the role is read from the token itself.
 *
 * Always dispatches `AUTH_CHANGE_EVENT` (guarded for the server) so the nav
 * re-renders after every login, logout and transparent refresh.
 */
export function setAccessToken(token: string, user?: AuthUser): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);

  if (user !== undefined) {
    const cached: CachedAuthUser = { sub: jwtSubject(token), email: user.email, role: user.role };
    window.sessionStorage.setItem(AUTH_USER_KEY, JSON.stringify(cached));
  } else {
    const cached = readCachedAuthUser();

    // A refreshed token for a different `sub` must not inherit another user's
    // email. The identity guard in `requestJson` normally prevents that path;
    // this is the cheap storage-level backstop.
    if (cached !== null && cached.sub !== jwtSubject(token)) {
      window.sessionStorage.removeItem(AUTH_USER_KEY);
    }
  }

  notifyAuthChange();
}

export function clearAccessToken(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  window.sessionStorage.removeItem(AUTH_USER_KEY);
  notifyAuthChange();
}

function readCachedAuthUser(): CachedAuthUser | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.sessionStorage.getItem(AUTH_USER_KEY);

  if (raw === null) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const role = record.role;

    if (typeof record.email !== "string" || (role !== "ORGANIZER" && role !== "ATTENDEE")) {
      return null;
    }

    return {
      sub: typeof record.sub === "string" ? record.sub : null,
      email: record.email,
      role,
    };
  } catch {
    return null;
  }
}

/**
 * Decode a JWT payload without verifying its signature. The API owns
 * verification; the web app only needs the claims it renders and the identity
 * comparisons that guard token refreshes. Tokens are base64url-encoded JWT
 * segments, so `atob` needs the URL alphabet mapped back and the padding
 * restored. `atob` yields latin1 bytes, so the payload goes through
 * `TextDecoder` before `JSON.parse`; non-ASCII claims must not decode to
 * mojibake. Malformed input yields `null`.
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const payload = token.split(".")[1];

  if (payload === undefined || payload.length === 0) {
    return null;
  }

  try {
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Read the `sub` claim out of an access token's payload. This is NOT signature
 * verification — the API already owns that — it only compares the identity a
 * request was sent with against the identity a refresh handed back. Any
 * malformed input yields `null` (unknown identity).
 *
 * Shared with the event page's WebSocket identity guard, which reloads instead
 * of adopting a different user's token.
 */
export function jwtSubject(token: string): string | null {
  const payload = decodeJwtPayload(token);

  if (payload === null) {
    return null;
  }

  return typeof payload.sub === "string" ? payload.sub : null;
}

/**
 * The signed-in user for the nav and profile card, or `null` when there is no
 * usable token. Uses the JWT for `role`/`email` when present; this API's tokens
 * carry `sub` + `role` only, so the email comes from the login/signup cache
 * written by `setAccessToken`, matched on `sub`.
 */
export function getAuthUser(): AuthUser | null {
  const token = getAccessToken();

  if (token === null) {
    return null;
  }

  const payload = decodeJwtPayload(token);

  if (payload === null) {
    return null;
  }

  const role = payload.role;

  if (role !== "ORGANIZER" && role !== "ATTENDEE") {
    return null;
  }

  let email = typeof payload.email === "string" ? payload.email : null;

  if (email === null) {
    const cached = readCachedAuthUser();
    const subject = typeof payload.sub === "string" ? payload.sub : null;

    if (cached !== null && cached.sub === subject) {
      email = cached.email;
    }
  }

  return email === null || email.length === 0 ? null : { email, role };
}

interface ResponseParser<T> {
  parse: (input: unknown) => T;
}

interface RequestJsonOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  /** Extra headers merged over the defaults; the auth header still wins. */
  headers?: Record<string, string>;
  /** Attach the stored Bearer token and recover it once via refresh on 401. */
  auth?: boolean;
  /** Fetch credentials mode; logout needs the httpOnly refresh cookie. */
  credentials?: RequestCredentials;
}

function parseResponse<T>(schema: ResponseParser<T>, payload: unknown): T {
  try {
    return schema.parse(payload);
  } catch {
    throw new ApiClientError(502, "INVALID_RESPONSE", "The API returned an unexpected response.");
  }
}

async function toApiError(response: Response): Promise<ApiClientError> {
  let code = "REQUEST_FAILED";
  let message = `Request failed with status ${response.status}`;
  let body: ErrorResponse | undefined;

  try {
    const payload: unknown = await response.json();
    const parsed = ErrorResponseSchema.safeParse(payload);

    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
      body = parsed.data;
    }
  } catch {
    // A non-JSON error body keeps the generic message.
  }

  return new ApiClientError(response.status, code, message, body);
}

async function requestJson(
  path: string,
  options: RequestJsonOptions = {},
  /** Internal retry marker: the one transparent 401 recovery already ran. */
  retried = false,
): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.auth === true) {
    const token = getAccessToken();

    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }
  }

  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: "no-store",
    credentials: options.credentials ?? "same-origin",
  });

  if (!response.ok) {
    const error = await toApiError(response);

    if (response.status === 401 && options.auth === true) {
      if (retried) {
        // The retry with the freshly refreshed token was rejected too: the
        // session is definitively over, so keep the old logout semantics.
        clearAccessToken();
        throw error;
      }

      // One transparent recovery: the access token lives 15 minutes while the
      // refresh cookie lasts 14 days. Capture the identity before refreshing so
      // a cookie that now belongs to another tab's user is never adopted.
      const storedToken = getAccessToken();
      const previousSub = storedToken === null ? null : jwtSubject(storedToken);
      const fresh = await refreshAccessToken();

      if (fresh === null) {
        // 4xx from `/auth/refresh`: the cookie is missing, expired or revoked.
        clearAccessToken();
        throw error;
      }

      if (fresh === storedToken) {
        // `refreshAccessToken` returns the stored token when the refresh could
        // not be attempted (transport failure or 5xx). Nothing new to retry
        // with, and a failed refresh is not proof of logout.
        throw error;
      }

      const freshSub = jwtSubject(fresh);

      if (previousSub !== null && freshSub !== null && previousSub !== freshSub) {
        // The refresh cookie is shared by every tab and holds the LAST login's
        // token. Never adopt that identity silently: leave the stored token
        // untouched; the WebSocket guard's reload is the only identity switch.
        throw error;
      }

      setAccessToken(fresh);

      // Exactly one retry, with the token `setAccessToken` just stored.
      return requestJson(path, options, true);
    }

    throw error;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

/**
 * D29 reconnect flow: trade the httpOnly refresh cookie for a fresh access
 * token. `credentials: "include"` is explicit because the cookie, not a
 * request body, is the credential; the endpoint needs no body.
 *
 * Returns `null` instead of throwing. This runs inside the live-update socket
 * reconnect loop, where "no valid session" (a 4xx after the cookie expired or
 * the user logged out) is a normal stop condition rather than an error to
 * surface. A transport failure is *not* proof of logout, so it falls back to
 * the token already in memory: the caller's capped backoff then keeps retrying
 * instead of killing live updates because the API was briefly unreachable.
 */
export async function refreshAccessToken(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { Accept: "application/json" },
      credentials: "include",
      cache: "no-store",
    });

    if (!response.ok) {
      // 4xx = the refresh cookie is missing, expired or revoked. Anything else
      // (5xx, proxy error) is transient and cannot distinguish a live session.
      if (response.status >= 400 && response.status < 500) {
        return null;
      }

      return getAccessToken();
    }

    const payload: unknown = await response.json();
    const parsed = RefreshResponseSchema.safeParse(payload);

    return parsed.success ? parsed.data.accessToken : null;
  } catch {
    return getAccessToken();
  }
}

export async function signup(input: SignupRequest): Promise<AuthResponse> {
  const payload = await requestJson("/api/auth/signup", { method: "POST", body: input });

  return parseResponse(AuthResponseSchema, payload);
}

export async function login(input: LoginRequest): Promise<AuthResponse> {
  const payload = await requestJson("/api/auth/login", { method: "POST", body: input });

  return parseResponse(AuthResponseSchema, payload);
}

/**
 * Revoke the current refresh token and clear its cookie. The Bearer token
 * identifies the user so the API can revoke every refresh token they own;
 * `credentials: "include"` makes sure the httpOnly cookie rides along so the
 * exact token is revoked too. A 204 has no body.
 */
export async function logout(): Promise<void> {
  await requestJson("/api/auth/logout", {
    method: "POST",
    auth: true,
    credentials: "include",
  });
}

export async function listPublishedEvents(
  limit: number,
  cursor: string | null,
): Promise<PaginatedEventsResponse> {
  const params = new URLSearchParams({ limit: String(limit) });

  if (cursor !== null) {
    params.set("cursor", cursor);
  }

  const payload = await requestJson(`/api/events?${params.toString()}`);

  return parseResponse(PaginatedEventsResponseSchema, payload);
}

export async function getEvent(id: string): Promise<EventDetail> {
  const payload = await requestJson(`/api/events/${encodeURIComponent(id)}`, { auth: true });

  return parseResponse(EventDetailSchema, payload);
}

export async function createEvent(input: CreateEventRequest): Promise<EventDetail> {
  const payload = await requestJson("/api/events", {
    method: "POST",
    body: input,
    auth: true,
  });

  return parseResponse(EventDetailSchema, payload);
}

export async function publishEvent(id: string): Promise<EventSummary> {
  const payload = await requestJson(`/api/events/${encodeURIComponent(id)}/publish`, {
    method: "POST",
    auth: true,
  });

  return parseResponse(EventSummarySchema, payload);
}

/**
 * Both hold outcomes are returned as data: a 201 needs `heldUntil` for the
 * countdown and a 409 needs `details.seatIds` for the "seats taken" banner.
 * Every other non-2xx status still throws `ApiClientError`.
 */
export type CreateHoldResult =
  { status: 201; body: HoldResponse } | { status: 409; body: ErrorResponse };

/** D2: the caller generates a fresh Idempotency-Key per hold attempt. */
export async function createHold(
  eventId: string,
  seatIds: string[],
  idempotencyKey: string,
): Promise<CreateHoldResult> {
  try {
    const payload = await requestJson(`/api/events/${encodeURIComponent(eventId)}/holds`, {
      method: "POST",
      body: { seatIds },
      auth: true,
      headers: { "Idempotency-Key": idempotencyKey },
    });

    return { status: 201, body: parseResponse(HoldResponseSchema, payload) };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409 && error.body !== undefined) {
      return { status: 409, body: error.body };
    }

    throw error;
  }
}

export async function releaseHold(holdId: string): Promise<void> {
  await requestJson(`/api/holds/${encodeURIComponent(holdId)}`, { method: "DELETE", auth: true });
}

/**
 * Start (or replay) checkout for the caller's hold. `requestJson` throws
 * `ApiClientError` for every non-2xx response, so a 401/403/404 keeps its API
 * envelope while a successful 200/201 parses to `{ bookingId, checkoutUrl }`.
 */
export async function createCheckout(holdId: string): Promise<CheckoutResponse> {
  const payload = await requestJson(`/api/holds/${encodeURIComponent(holdId)}/checkout`, {
    method: "POST",
    auth: true,
  });

  return parseResponse(CheckoutResponseSchema, payload);
}

/** Owner-only booking detail; a foreign booking is a 403, a missing one a 404. */
export async function getBooking(id: string): Promise<BookingDetail> {
  const payload = await requestJson(`/api/bookings/${encodeURIComponent(id)}`, { auth: true });

  return parseResponse(BookingDetailSchema, payload);
}

/** The caller's bookings, newest first. */
export async function listMyBookings(): Promise<MeBookingsResponse> {
  const payload = await requestJson("/api/me/bookings", { auth: true });

  return parseResponse(MeBookingsResponseSchema, payload);
}
