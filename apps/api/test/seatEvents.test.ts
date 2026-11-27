import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { CreateEventRequest, SeatStatus, UserRole } from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool, QueryResultRow } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createRedisClient } from "../src/realtime/redis";
import { seatEvents, type SeatChange } from "../src/services/seatEvents";
import { truncateAll } from "./helpers/db";

/**
 * `design.md:283` and Rule 5 — the in-process seat emitter.
 *
 * A committed change emits exactly one event per seat, after COMMIT, carrying
 * that seat's own `version` (D14). A request that rolls back (a 409), or an
 * idempotent replay that changes nothing, must emit no event at all. Releases
 * emit AVAILABLE per seat with the bumped version.
 */

const PASSWORD = "password123";
const SEAT_COUNT = 3;

interface SeatStateRow extends QueryResultRow {
  id: string;
  number: number;
  status: SeatStatus;
  hold_id: string | null;
  held_by: string | null;
  held_until: Date | null;
  version: number;
}

interface Waiter {
  count: number;
  resolve: () => void;
}

function requireSeat(rows: SeatStateRow[], number: number): SeatStateRow {
  const row = rows.find((candidate) => candidate.number === number);

  if (row === undefined) {
    throw new Error(`Seat number ${number} is missing`);
  }

  return row;
}

function sortEvents(events: SeatChange[]): SeatChange[] {
  return [...events].sort((left, right) =>
    left.seatIds[0].localeCompare(right.seatIds[0]),
  );
}

describe("seatEvents", () => {
  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;
  let received: SeatChange[] = [];
  let waiters: Waiter[] = [];

  function onSeatChange(change: SeatChange): void {
    received.push(change);

    if (waiters.length === 0) {
      return;
    }

    const ready = waiters.filter((waiter) => received.length >= waiter.count);
    waiters = waiters.filter((waiter) => received.length < waiter.count);

    for (const waiter of ready) {
      waiter.resolve();
    }
  }

  /**
   * Resolve when at least `count` events have been recorded. Emission is
   * synchronous after COMMIT and before the HTTP response, so this normally
   * resolves immediately; it exists so the assertions never depend on timing.
   */
  function waitForEvents(count: number): Promise<void> {
    if (received.length >= count) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      waiters.push({ count, resolve });
    });
  }

  beforeAll(() => {
    config = loadConfig(process.env);
    pool = createPool(config);
    redis = createRedisClient(config);
    app = createApp({ pool, redis, config });
    seatEvents.on("seatChange", onSeatChange);
  });

  beforeEach(async () => {
    await truncateAll(pool);
    received = [];
    waiters = [];
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    seatEvents.off("seatChange", onSeatChange);
    redis.disconnect();
    await pool.end();
  });

  async function signupUser(
    role: UserRole,
  ): Promise<{ id: string; email: string; accessToken: string }> {
    const email = `seat-events-${randomUUID()}@seatsync.local`;
    const response = await request(app)
      .post("/auth/signup")
      .send({ email, password: PASSWORD, role });

    expect(response.status).toBe(201);

    return {
      id: response.body.user.id,
      email,
      accessToken: response.body.accessToken,
    };
  }

  function eventPayload(): CreateEventRequest {
    return {
      title: "Seat events night",
      venue: "Main hall",
      startsAt: "2027-09-06T18:00:00.000Z",
      sections: [{ name: "Floor", rows: 1, seatsPerRow: SEAT_COUNT, pricePaise: 2500 }],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
  ): Promise<{ id: string; seats: Array<{ id: string; number: number; status: SeatStatus }> }> {
    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(eventPayload());

    expect(created.status).toBe(201);

    const published = await request(app)
      .post(`/events/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(published.status).toBe(200);

    return {
      id: created.body.id,
      seats: created.body.seats as Array<{ id: string; number: number; status: SeatStatus }>,
    };
  }

  function hold(
    accessToken: string,
    eventId: string,
    seatIds: string[],
    idempotencyKey: string = randomUUID(),
  ) {
    return request(app)
      .post(`/events/${eventId}/holds`)
      .set("Authorization", `Bearer ${accessToken}`)
      .set("Idempotency-Key", idempotencyKey)
      .send({ seatIds });
  }

  async function readSeats(eventId: string): Promise<SeatStateRow[]> {
    const result = await pool.query<SeatStateRow>(
      `SELECT id, number, status, hold_id, held_by, held_until, version
         FROM seats
        WHERE event_id = $1
        ORDER BY number`,
      [eventId],
    );

    return result.rows;
  }

  it("emits exactly one HELD event with version 1 for a committed one-seat hold", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1] = event.seats;

    if (s1 === undefined) {
      throw new Error("Expected a seat");
    }

    const response = await hold(attendee.accessToken, event.id, [s1.id]);

    expect(response.status).toBe(201);

    await waitForEvents(1);

    expect(received).toEqual([
      {
        eventId: event.id,
        seatIds: [s1.id],
        status: "HELD",
        version: 1,
      },
    ]);
  });

  it("emits one event per seat for a multi-seat hold, each with its own version", async () => {
    const organizer = await signupUser("ORGANIZER");
    const userA = await signupUser("ATTENDEE");
    const userB = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1, s2] = event.seats;

    if (s1 === undefined || s2 === undefined) {
      throw new Error("Expected at least two seats");
    }

    // Bump s1 independently: hold by A (v1), release (v2), then B holds both.
    const first = await hold(userA.accessToken, event.id, [s1.id]);

    expect(first.status).toBe(201);

    await waitForEvents(1);

    const release = await request(app)
      .delete(`/holds/${first.body.holdId}`)
      .set("Authorization", `Bearer ${userA.accessToken}`);

    expect(release.status).toBe(204);

    received = [];

    const multi = await hold(userB.accessToken, event.id, [s1.id, s2.id]);

    expect(multi.status).toBe(201);
    expect(multi.body.seatIds).toHaveLength(2);

    await waitForEvents(2);

    // UUID order is arbitrary, so compare both lists through the same sort.
    const expected: SeatChange[] = [
      { eventId: event.id, seatIds: [s1.id], status: "HELD", version: 3 },
      { eventId: event.id, seatIds: [s2.id], status: "HELD", version: 1 },
    ];

    expect(received).toHaveLength(2);
    expect(sortEvents(received)).toEqual(sortEvents(expected));

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "HELD",
      hold_id: multi.body.holdId,
      held_by: userB.id,
      version: 3,
    });
    expect(requireSeat(seats, 2)).toMatchObject({
      status: "HELD",
      hold_id: multi.body.holdId,
      held_by: userB.id,
      version: 1,
    });
  });

  it("emits nothing for rolled-back hold attempts", async () => {
    const organizer = await signupUser("ORGANIZER");
    const userA = await signupUser("ATTENDEE");
    const userB = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1, s2, s3] = event.seats;

    if (s1 === undefined || s2 === undefined || s3 === undefined) {
      throw new Error("Expected three seats");
    }

    const first = await hold(userA.accessToken, event.id, [s1.id]);

    expect(first.status).toBe(201);

    await waitForEvents(1);
    received = [];

    // Overlap attempt: the conditional UPDATE matches no row and rolls back.
    const overlap = await hold(userB.accessToken, event.id, [s1.id]);

    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe("SEATS_UNAVAILABLE");
    expect(received).toEqual([]);

    // Second active hold by the same user: rejected before any seat change.
    const secondActive = await hold(userA.accessToken, event.id, [s2.id]);

    expect(secondActive.status).toBe(409);
    expect(secondActive.body.error.code).toBe("SEATS_UNAVAILABLE");
    expect(secondActive.body.error.details).toEqual({ seatIds: [s1.id] });
    expect(received).toEqual([]);

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "HELD",
      hold_id: first.body.holdId,
      held_by: userA.id,
      version: 1,
    });
    expect(requireSeat(seats, 2)).toMatchObject({
      status: "AVAILABLE",
      hold_id: null,
      held_by: null,
      held_until: null,
      version: 0,
    });
    expect(requireSeat(seats, 3)).toMatchObject({
      status: "AVAILABLE",
      hold_id: null,
      held_by: null,
      held_until: null,
      version: 0,
    });
  });

  it("emits nothing when an idempotent key replays a stored response", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1] = event.seats;

    if (s1 === undefined) {
      throw new Error("Expected a seat");
    }

    const key = randomUUID();
    const first = await hold(attendee.accessToken, event.id, [s1.id], key);

    expect(first.status).toBe(201);

    await waitForEvents(1);
    received = [];

    const replay = await hold(attendee.accessToken, event.id, [s1.id], key);

    expect(replay.status).toBe(201);
    expect(replay.text).toBe(first.text);
    expect(received).toEqual([]);

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "HELD",
      hold_id: first.body.holdId,
      held_by: attendee.id,
      version: 1,
    });
  });

  it("emits an AVAILABLE event per seat with the bumped version on release", async () => {
    const organizer = await signupUser("ORGANIZER");
    const attendee = await signupUser("ATTENDEE");
    const event = await createPublishedEvent(organizer.accessToken);

    const [s1, s2] = event.seats;

    if (s1 === undefined || s2 === undefined) {
      throw new Error("Expected at least two seats");
    }

    const held = await hold(attendee.accessToken, event.id, [s1.id, s2.id]);

    expect(held.status).toBe(201);

    await waitForEvents(2);

    expect(received).toHaveLength(2);
    received = [];

    const released = await request(app)
      .delete(`/holds/${held.body.holdId}`)
      .set("Authorization", `Bearer ${attendee.accessToken}`);

    expect(released.status).toBe(204);

    await waitForEvents(2);

    const expected: SeatChange[] = [
      { eventId: event.id, seatIds: [s1.id], status: "AVAILABLE", version: 2 },
      { eventId: event.id, seatIds: [s2.id], status: "AVAILABLE", version: 2 },
    ];

    expect(received).toHaveLength(2);
    expect(sortEvents(received)).toEqual(sortEvents(expected));

    const seats = await readSeats(event.id);

    expect(requireSeat(seats, 1)).toMatchObject({
      status: "AVAILABLE",
      hold_id: null,
      held_by: null,
      held_until: null,
      version: 2,
    });
    expect(requireSeat(seats, 2)).toMatchObject({
      status: "AVAILABLE",
      hold_id: null,
      held_by: null,
      held_until: null,
      version: 2,
    });
    expect(requireSeat(seats, 3)).toMatchObject({
      status: "AVAILABLE",
      hold_id: null,
      held_by: null,
      held_until: null,
      version: 0,
    });
  });
});
