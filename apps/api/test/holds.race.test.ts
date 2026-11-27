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
import { signAccessToken } from "../src/services/auth";
import { truncateAll } from "./helpers/db";

/**
 * `design.md:278` — the race acceptance check.
 *
 * 200 different users fire 200 concurrent `POST /events/:id/holds` requests for
 * the same seat. Rule 1's lock-then-update must produce exactly one 201 and 199
 * 409s. The database is the real compose Postgres (host 5434) and is never
 * mocked (`design.md:63`). Every request carries its own fresh idempotency key,
 * so all 200 outcomes must be stored (D2), including the 199 conflicts.
 *
 * Concurrency mechanism: one Supertest request per user, exactly like the
 * Sprint 0/1 suites (Supertest binds an ephemeral server per request). Pool
 * exhaustion is expected (`DB_POOL_SIZE` 20) and is deliberately not raised.
 */

const PASSWORD = "password123";
const ATTENDEE_COUNT = 200;
const SEAT_COUNT = 5;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SeededUserRow extends QueryResultRow {
  id: string;
  email: string;
}

interface SeatStateRow extends QueryResultRow {
  id: string;
  number: number;
  status: SeatStatus;
  hold_id: string | null;
  held_by: string | null;
  held_until: Date | null;
  version: number;
}

interface CountRow extends QueryResultRow {
  count: number;
}

interface StatusCountRow extends QueryResultRow {
  status_code: number;
  count: number;
}

function requireRow<T>(rows: T[]): T {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("Expected at least one database row");
  }

  return row;
}

describe("holds race", () => {
  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;

  beforeAll(() => {
    config = loadConfig(process.env);
    pool = createPool(config);
    redis = createRedisClient(config);
    app = createApp({ pool, redis, config });
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  async function signupUser(
    role: UserRole,
  ): Promise<{ id: string; email: string; accessToken: string }> {
    const email = `holds-race-${randomUUID()}@seatsync.local`;
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

  function eventPayload(seatsPerRow: number): CreateEventRequest {
    return {
      title: "Race night",
      venue: "Main hall",
      startsAt: "2027-09-01T18:00:00.000Z",
      sections: [{ name: "Floor", rows: 1, seatsPerRow, pricePaise: 2500 }],
    };
  }

  async function createPublishedEvent(
    accessToken: string,
    seatsPerRow: number,
  ): Promise<{ id: string; seats: Array<{ id: string; number: number; status: SeatStatus }> }> {
    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${accessToken}`)
      .send(eventPayload(seatsPerRow));

    expect(created.status).toBe(201);

    const published = await request(app)
      .post(`/events/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${accessToken}`);

    expect(published.status).toBe(200);
    expect(published.body.status).toBe("PUBLISHED");

    return {
      id: created.body.id,
      seats: created.body.seats as Array<{ id: string; number: number; status: SeatStatus }>,
    };
  }

  it(
    "gives exactly one 201 and 199 409s for 200 concurrent holds on one seat",
    async () => {
      const organizer = await signupUser("ORGANIZER");
      const event = await createPublishedEvent(organizer.accessToken, SEAT_COUNT);

      expect(event.seats).toHaveLength(SEAT_COUNT);
      expect(event.seats.map((seat) => seat.status)).toEqual(
        Array.from({ length: SEAT_COUNT }, () => "AVAILABLE"),
      );

      const targetSeat = event.seats[0];
      const otherSeats = event.seats.slice(1);

      if (targetSeat === undefined) {
        throw new Error("Event has no seats");
      }

      // D11: one bulk INSERT for 200 attendees with a placeholder hash (no
      // argon2) and JWTs signed directly with the exported service helper.
      const emails: string[] = [];
      const placeholders: string[] = [];

      for (let index = 0; index < ATTENDEE_COUNT; index += 1) {
        emails.push(`holds-race-attendee-${index}-${randomUUID()}@seatsync.local`);
        placeholders.push(`($${index + 1}, 'race-test-placeholder', 'ATTENDEE')`);
      }

      const inserted = await pool.query<SeededUserRow>(
        `INSERT INTO users (email, password_hash, role)
         VALUES ${placeholders.join(", ")}
         RETURNING id, email`,
        emails,
      );

      expect(inserted.rows).toHaveLength(ATTENDEE_COUNT);

      const userIdByEmail = new Map(inserted.rows.map((row) => [row.email, row.id]));

      expect(userIdByEmail.size).toBe(ATTENDEE_COUNT);

      const attendees = emails.map((email) => {
        const id = userIdByEmail.get(email);

        if (id === undefined) {
          throw new Error(`Seeded attendee ${email} is missing its id`);
        }

        return {
          id,
          token: signAccessToken(config, { id, email, role: "ATTENDEE" }),
        };
      });

      const idempotencyKeys = attendees.map(() => randomUUID());

      expect(new Set(idempotencyKeys).size).toBe(ATTENDEE_COUNT);

      const responses = await Promise.all(
        attendees.map((attendee, index) =>
          request(app)
            .post(`/events/${event.id}/holds`)
            .set("Authorization", `Bearer ${attendee.token}`)
            .set("Idempotency-Key", idempotencyKeys[index])
            .send({ seatIds: [targetSeat.id] }),
        ),
      );

      expect(responses).toHaveLength(ATTENDEE_COUNT);

      const successes = responses.filter((response) => response.status === 201);
      const conflicts = responses.filter((response) => response.status === 409);

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(ATTENDEE_COUNT - 1);
      expect(
        responses.filter((response) => response.status !== 201 && response.status !== 409),
      ).toHaveLength(0);

      for (const conflict of conflicts) {
        expect(conflict.body).toEqual({
          error: {
            code: "SEATS_UNAVAILABLE",
            message: "One or more seats are no longer available",
            details: { seatIds: [targetSeat.id] },
          },
        });
      }

      const winner = successes[0];
      const winnerIndex = responses.findIndex((response) => response.status === 201);
      const winnerUser = attendees[winnerIndex];

      if (winner === undefined || winnerUser === undefined) {
        throw new Error("Expected exactly one winning user");
      }

      expect(winner.body.seatIds).toEqual([targetSeat.id]);
      expect(winner.body.holdId).toMatch(UUID_PATTERN);

      const heldUntil = winner.body.heldUntil as string;
      const heldUntilMs = Date.parse(heldUntil);

      expect(Number.isNaN(heldUntilMs)).toBe(false);
      expect(new Date(heldUntilMs).toISOString()).toBe(heldUntil);
      expect(heldUntilMs).toBeGreaterThan(Date.now());
      // Allow a minute of slack for the known ~3.7s DB/Host clock skew.
      expect(heldUntilMs).toBeLessThanOrEqual(
        Date.now() + (config.HOLD_TTL_SECONDS + 60) * 1000,
      );

      const targetResult = await pool.query<SeatStateRow>(
        `SELECT id, number, status, hold_id, held_by, held_until, version
           FROM seats
          WHERE id = $1`,
        [targetSeat.id],
      );
      const targetRow = requireRow(targetResult.rows);

      expect(targetRow.status).toBe("HELD");
      expect(targetRow.hold_id).toBe(winner.body.holdId);
      expect(targetRow.held_by).toBe(winnerUser.id);
      expect(targetRow.held_until?.toISOString()).toBe(heldUntil);
      expect(targetRow.version).toBe(1);

      const otherResult = await pool.query<SeatStateRow>(
        `SELECT id, number, status, hold_id, held_by, held_until, version
           FROM seats
          WHERE event_id = $1 AND id <> $2
          ORDER BY number`,
        [event.id, targetSeat.id],
      );

      expect(otherResult.rows).toHaveLength(otherSeats.length);

      for (const row of otherResult.rows) {
        expect(row).toMatchObject({
          status: "AVAILABLE",
          hold_id: null,
          held_by: null,
          held_until: null,
          version: 0,
        });
      }

      const heldCount = await pool.query<CountRow>(
        `SELECT count(*)::int AS count
           FROM seats
          WHERE event_id = $1 AND status = 'HELD'`,
        [event.id],
      );

      expect(requireRow(heldCount.rows).count).toBe(1);

      // D2: every request stored its outcome, including the 199 conflicts.
      const totalKeys = await pool.query<CountRow>(
        `SELECT count(*)::int AS count FROM idempotency_keys`,
      );
      const storedKeys = await pool.query<CountRow>(
        `SELECT count(*)::int AS count
           FROM idempotency_keys
          WHERE key = ANY($1::text[])`,
        [idempotencyKeys],
      );

      expect(requireRow(totalKeys.rows).count).toBe(ATTENDEE_COUNT);
      expect(requireRow(storedKeys.rows).count).toBe(ATTENDEE_COUNT);

      const keysByStatus = await pool.query<StatusCountRow>(
        `SELECT status_code, count(*)::int AS count
           FROM idempotency_keys
          GROUP BY status_code
          ORDER BY status_code`,
      );

      expect(keysByStatus.rows).toEqual([
        { status_code: 201, count: 1 },
        { status_code: 409, count: ATTENDEE_COUNT - 1 },
      ]);
    },
    120_000,
  );
});
