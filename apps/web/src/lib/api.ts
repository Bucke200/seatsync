import {
  AuthResponseSchema,
  ErrorResponseSchema,
  EventDetailSchema,
  EventSummarySchema,
  PaginatedEventsResponseSchema,
} from "@seatsync/shared";
import type {
  AuthResponse,
  CreateEventRequest,
  EventDetail,
  EventSummary,
  LoginRequest,
  PaginatedEventsResponse,
  SignupRequest,
} from "@seatsync/shared";

const ACCESS_TOKEN_KEY = "seatsync.accessToken";

/** Errors surfaced by the API, carrying its machine-readable code. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
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

export function setAccessToken(token: string): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function clearAccessToken(): void {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
}

interface ResponseParser<T> {
  parse: (input: unknown) => T;
}

interface RequestJsonOptions {
  method?: "GET" | "POST";
  body?: unknown;
  /** Attach the stored Bearer token and clear it if the API answers 401. */
  auth?: boolean;
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

  try {
    const payload: unknown = await response.json();
    const parsed = ErrorResponseSchema.safeParse(payload);

    if (parsed.success) {
      code = parsed.data.error.code;
      message = parsed.data.error.message;
    }
  } catch {
    // A non-JSON error body keeps the generic message.
  }

  return new ApiClientError(response.status, code, message);
}

async function requestJson(path: string, options: RequestJsonOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };

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
  });

  if (!response.ok) {
    if (response.status === 401 && options.auth === true) {
      clearAccessToken();
    }

    throw await toApiError(response);
  }

  return response.json();
}

export async function signup(input: SignupRequest): Promise<AuthResponse> {
  const payload = await requestJson("/api/auth/signup", { method: "POST", body: input });

  return parseResponse(AuthResponseSchema, payload);
}

export async function login(input: LoginRequest): Promise<AuthResponse> {
  const payload = await requestJson("/api/auth/login", { method: "POST", body: input });

  return parseResponse(AuthResponseSchema, payload);
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
