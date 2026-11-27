import { randomUUID } from "node:crypto";
import { expect } from "@jest/globals";
import type { CreateEventRequest, UserRole } from "@seatsync/shared";
import type { Express } from "express";
import type { Pool, QueryResultRow } from "pg";
import request from "supertest";
import type { Config } from "../../src/config";
import {
  createFakeWebhook,
  FAKE_SIGNATURE_HEADER,
  type FakeWebhookPayload,
} from "../../src/payments";
import type { SeatChange } from "../../src/services/seatEvents";

/**
 * Shared harness pieces for the seven Sprint 3 acceptance suites in
 * `test/payments/` (design.md:307-315).
 *
 * Every suite still owns its Jest lifecycle and its assertions; this module only
 * removes the repeated request/SQL plumbing so each file stays focused on the
 * behaviour named by its spec bullet. As in the rest of the API tests, the
 * config is loaded with `PAYMENT_PROVIDER: "fake"` (D19), Postgres is real and
 * expiry is simulated with an absolute past timestamp (D9).
 */

export const PASSWORD = "password123";
export const PRICE_PAISE = 2_500;
/** D9: expiry is a past instant written by SQL, never a real-time wait. */
export const PAST = "2000-01-01T00:00:00Z";

export type BookingStatus = "PENDING" | "CONFIRMED" | "FAILED" | "REFUNDED";

export interface TestUser {
  id: string;
  email: string;
  accessToken: string;
}

export interface EventSeat {
  id: string;
  number: number;
}

export interface SeatRow extends QueryResultRow {
  id: string;
  number: number;
  status: string;
  hold_id: string | null;
  held_by: string | null;
  held_until: Date | null;
  version: number;
}

export interface BookingRow extends QueryResultRow {
  id: string;
  user_id: string;
  event_id: string;
  hold_id: string;
  status: BookingStatus;
  amount_paise: number;
  payment_ref: string | null;
}

export interface BookingSeatRow extends QueryResultRow {
  seat_id: string;
  status: BookingStatus;
}

export interface CountRow extends QueryResultRow {
  count: number;
}

export function requireRow<T>(rows: T[]): T {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Expected at least one database row");
  }

  return row;
}

export function sortEvents(events: SeatChange[]): SeatChange[] {
  return [...events].sort((left, right) =>
    left.seatIds[0]?.localeCompare(right.seatIds[0] ?? "") ?? 0,
  );
}

export function seatById(seats: SeatRow[], seatId: string): SeatRow {
  const seat = seats.find((candidate) => candidate.id === seatId);

  if (seat === undefined) {
    throw new Error(`Seat ${seatId} is missing from the event`);
  }

  return seat;
}

export async function signupUser(
  app: Express,
  role: UserRole,
  prefix: string,
): Promise<TestUser> {
  const email = `${prefix}-${randomUUID()}@seatsync.local`;
  const response = await request(app)
    .post("/auth/signup")
    .send({ email, password: PASSWORD, role });

  expect(response.status).toBe(201);

  return {
    id: response.body.user.id as string,
    email,
    accessToken: response.body.accessToken as string,
  };
}

function eventPayload(
  seatCount: number,
  title: string,
  pricePaise: number = PRICE_PAISE,
): CreateEventRequest {
  return {
    title,
    venue: "Main hall",
    startsAt: "2027-09-12T18:00:00.000Z",
    sections: [
      { name: "Floor", rows: 1, seatsPerRow: seatCount, pricePaise },
    ],
  };
}

export async function createPublishedEvent(
  app: Express,
  accessToken: string,
  seatCount: number,
  options: { title?: string; pricePaise?: number } = {},
): Promise<{ id: string; seats: EventSeat[] }> {
  const created = await request(app)
    .post("/events")
    .set("Authorization", `Bearer ${accessToken}`)
    .send(
      eventPayload(
        seatCount,
        options.title ?? "Payments acceptance night",
        options.pricePaise,
      ),
    );

  expect(created.status).toBe(201);

  const eventId = created.body.id as string;
  const published = await request(app)
    .post(`/events/${eventId}/publish`)
    .set("Authorization", `Bearer ${accessToken}`);

  expect(published.status).toBe(200);

  return {
    id: eventId,
    seats: created.body.seats as EventSeat[],
  };
}

export function hold(
  app: Express,
  accessToken: string,
  eventId: string,
  seatIds: string[],
) {
  return request(app)
    .post(`/events/${eventId}/holds`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("Idempotency-Key", randomUUID())
    .send({ seatIds });
}

export function checkout(app: Express, accessToken: string, holdId: string) {
  return request(app)
    .post(`/holds/${holdId}/checkout`)
    .set("Authorization", `Bearer ${accessToken}`);
}

export interface CheckoutSetup {
  organizer: TestUser;
  holder: TestUser;
  event: { id: string; seats: EventSeat[] };
  heldSeats: EventSeat[];
  holdId: string;
  bookingId: string;
}

/** Organizer + published event + holder with an active hold and a PENDING booking. */
export async function setupCheckout(
  app: Express,
  options: {
    seatCount?: number;
    holdCount?: number;
    prefix?: string;
    title?: string;
  } = {},
): Promise<CheckoutSetup> {
  const seatCount = options.seatCount ?? 3;
  const holdCount = options.holdCount ?? 2;
  const prefix = options.prefix ?? "payments";
  const organizer = await signupUser(app, "ORGANIZER", `${prefix}-organizer`);
  const holder = await signupUser(app, "ATTENDEE", `${prefix}-holder`);
  const event = await createPublishedEvent(
    app,
    organizer.accessToken,
    seatCount,
    options.title === undefined ? {} : { title: options.title },
  );
  const heldSeats = event.seats.slice(0, holdCount);

  expect(heldSeats).toHaveLength(holdCount);

  const held = await hold(
    app,
    holder.accessToken,
    event.id,
    heldSeats.map((seat) => seat.id),
  );

  expect(held.status).toBe(201);

  const holdId = held.body.holdId as string;
  const created = await checkout(app, holder.accessToken, holdId);

  expect(created.status).toBe(201);

  return {
    organizer,
    holder,
    event,
    heldSeats,
    holdId,
    bookingId: created.body.bookingId as string,
  };
}

export function paymentSucceeded(
  bookingId: string,
  holdId: string,
  options: { eventId?: string; paymentRef?: string } = {},
): FakeWebhookPayload {
  return {
    eventId: options.eventId ?? randomUUID(),
    type: "payment_succeeded",
    bookingId,
    holdId,
    paymentRef: options.paymentRef ?? `pay_${randomUUID()}`,
  };
}

export function checkoutExpired(
  bookingId: string,
  holdId: string,
  eventId: string = randomUUID(),
): FakeWebhookPayload {
  return {
    eventId,
    type: "checkout_expired",
    bookingId,
    holdId,
    paymentRef: null,
  };
}

/** POST a provider-signed fake webhook; `secret` enables the bad-signature case. */
export function postWebhook(
  app: Express,
  config: Config,
  payload: FakeWebhookPayload,
  secret: string = config.PAYMENT_WEBHOOK_SECRET,
) {
  const { rawBody, signature } = createFakeWebhook(payload, secret);

  return request(app)
    .post(`/webhooks/${config.PAYMENT_PROVIDER}`)
    // supertest would serialize a Buffer to JSON under application/json;
    // octet-stream keeps the exact raw bytes the provider signed.
    .set("Content-Type", "application/octet-stream")
    .set(FAKE_SIGNATURE_HEADER, signature)
    .send(rawBody);
}

/** POST unsigned raw bytes (the missing-signature case). */
export function postUnsignedWebhook(
  app: Express,
  config: Config,
  payload: FakeWebhookPayload,
) {
  const { rawBody } = createFakeWebhook(payload, config.PAYMENT_WEBHOOK_SECRET);

  return request(app)
    .post(`/webhooks/${config.PAYMENT_PROVIDER}`)
    .set("Content-Type", "application/octet-stream")
    .send(rawBody);
}

export async function readSeats(pool: Pool, eventId: string): Promise<SeatRow[]> {
  const result = await pool.query<SeatRow>(
    `SELECT id, number, status, hold_id, held_by, held_until, version
       FROM seats
      WHERE event_id = $1
      ORDER BY number`,
    [eventId],
  );

  return result.rows;
}

export async function readBooking(
  pool: Pool,
  bookingId: string,
): Promise<BookingRow> {
  const result = await pool.query<BookingRow>(
    `SELECT id, user_id, event_id, hold_id, status, amount_paise, payment_ref
       FROM bookings
      WHERE id = $1`,
    [bookingId],
  );

  return requireRow(result.rows);
}

export async function readBookingSeats(
  pool: Pool,
  bookingId: string,
): Promise<BookingSeatRow[]> {
  const result = await pool.query<BookingSeatRow>(
    `SELECT seat_id, status
       FROM booking_seats
      WHERE booking_id = $1
      ORDER BY seat_id`,
    [bookingId],
  );

  return result.rows;
}

export async function countProcessedWebhooks(pool: Pool): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT count(*)::int AS count FROM processed_webhooks`,
  );

  return requireRow(result.rows).count;
}

export async function countBookings(pool: Pool): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT count(*)::int AS count FROM bookings`,
  );

  return requireRow(result.rows).count;
}

export async function countBookingSeats(pool: Pool): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT count(*)::int AS count FROM booking_seats`,
  );

  return requireRow(result.rows).count;
}

export async function countConfirmedBookings(
  pool: Pool,
  eventId: string,
): Promise<number> {
  const result = await pool.query<CountRow>(
    `SELECT count(*)::int AS count
       FROM bookings
      WHERE event_id = $1
        AND status = 'CONFIRMED'`,
    [eventId],
  );

  return requireRow(result.rows).count;
}

/** D9 expiry simulation: one SQL write, no real-time wait and no JS date. */
export async function expireSeats(
  pool: Pool,
  seatIds: string[],
  past: string = PAST,
): Promise<void> {
  await pool.query(
    `UPDATE seats SET held_until = $2::timestamptz WHERE id = ANY($1::uuid[])`,
    [seatIds, past],
  );
}
