import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

interface EventsPageBody {
  events: Array<{ id: string; status: string }>;
  nextCursor: string | null;
}

describe("pagination", () => {
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

  async function signupOrganizer(): Promise<string> {
    const response = await request(app)
      .post("/auth/signup")
      .send({
        email: `pagination-${randomUUID()}@seatsync.local`,
        password: "password123",
        role: "ORGANIZER",
      });

    expect(response.status).toBe(201);

    return response.body.user.id;
  }

  it("walks every page of 55 published events with limit=10 and returns 55 unique ids", async () => {
    const organizerId = await signupOrganizer();

    // Seed directly: this suite exercises the GET /events cursor contract, not
    // seat creation. One DRAFT proves the published-only filter.
    await pool.query(
      `INSERT INTO events (organizer_id, title, venue, starts_at, status)
       SELECT $1,
              'Published ' || g,
              'Venue ' || g,
              '2027-01-01T00:00:00Z'::timestamptz + make_interval(mins => g),
              'PUBLISHED'
         FROM generate_series(1, 55) AS g`,
      [organizerId],
    );

    await pool.query(
      `INSERT INTO events (organizer_id, title, venue, starts_at, status)
       VALUES ($1, 'Draft event', 'Venue', '2027-01-01T00:00:00Z', 'DRAFT')`,
      [organizerId],
    );

    const ids: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
      const url = cursor === null ? "/events?limit=10" : `/events?limit=10&cursor=${cursor}`;
      const response = await request(app).get(url);

      expect(response.status).toBe(200);

      const body = response.body as EventsPageBody;
      expect(body.events.every((event) => event.status === "PUBLISHED")).toBe(true);
      ids.push(...body.events.map((event) => event.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThanOrEqual(10);
    } while (cursor !== null);

    expect(pages).toBe(6);
    expect(ids).toHaveLength(55);
    expect(new Set(ids).size).toBe(55);
  });

  it("rejects a malformed cursor with 400", async () => {
    const response = await request(app).get("/events?cursor=not-a-cursor");

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: { code: "INVALID_CURSOR" } });
  });
});
