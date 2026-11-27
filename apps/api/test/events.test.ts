import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { CreateEventRequest } from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

describe("events", () => {
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

  async function signupOrganizer(): Promise<{ id: string; accessToken: string }> {
    const response = await request(app)
      .post("/auth/signup")
      .send({
        email: `events-${randomUUID()}@seatsync.local`,
        password: "password123",
        role: "ORGANIZER",
      });

    expect(response.status).toBe(201);

    return { id: response.body.user.id, accessToken: response.body.accessToken };
  }

  function eventPayload(overrides: Partial<CreateEventRequest> = {}): CreateEventRequest {
    return {
      title: "Seatsync Live",
      venue: "Grand Hall",
      startsAt: "2027-06-01T18:00:00.000Z",
      sections: [{ name: "Floor", rows: 10, seatsPerRow: 20, pricePaise: 2500 }],
      ...overrides,
    };
  }

  async function countRows(): Promise<{ events: number; seats: number }> {
    const result = await pool.query<{ events: number; seats: number }>(
      `SELECT (SELECT count(*)::int FROM events) AS events,
              (SELECT count(*)::int FROM seats) AS seats`,
    );

    return result.rows[0];
  }

  it("creates a 10 x 20 layout as exactly 200 seat rows", async () => {
    const organizer = await signupOrganizer();

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send(eventPayload());

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      title: "Seatsync Live",
      venue: "Grand Hall",
      status: "DRAFT",
    });
    expect(created.body.id).toEqual(expect.any(String));
    expect(created.body.seats).toHaveLength(200);
    expect(created.body.seats[0]).toMatchObject({
      section: "Floor",
      pricePaise: 2500,
      status: "AVAILABLE",
    });

    expect(await countRows()).toEqual({ events: 1, seats: 200 });

    const detail = await request(app)
      .get(`/events/${created.body.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);

    expect(detail.status).toBe(200);
    expect(detail.body.seats).toHaveLength(200);
  });

  it("rolls back the event and every seat when a later section fails the price CHECK", async () => {
    const organizer = await signupOrganizer();

    const failed = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send(
        eventPayload({
          sections: [
            { name: "Valid", rows: 2, seatsPerRow: 2, pricePaise: 1000 },
            { name: "Invalid", rows: 2, seatsPerRow: 2, pricePaise: -100 },
          ],
        }),
      );

    expect(failed.status).toBe(422);
    expect(failed.body).toMatchObject({ error: { code: "INVALID_SEAT_LAYOUT" } });
    expect(await countRows()).toEqual({ events: 0, seats: 0 });
  });

  it("keeps drafts private and publishes/unpublishes an owned event", async () => {
    const organizer = await signupOrganizer();

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send(eventPayload());

    expect(created.status).toBe(201);

    const hidden = await request(app).get(`/events/${created.body.id}`);
    expect(hidden.status).toBe(404);
    expect(hidden.body.error.code).toBe("EVENT_NOT_FOUND");

    const patched = await request(app)
      .patch(`/events/${created.body.id}`)
      .set("Authorization", `Bearer ${organizer.accessToken}`)
      .send({ title: "Renamed night", venue: "New venue" });

    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      id: created.body.id,
      title: "Renamed night",
      venue: "New venue",
      status: "DRAFT",
    });

    const published = await request(app)
      .post(`/events/${created.body.id}/publish`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);

    expect(published.status).toBe(200);
    expect(published.body.status).toBe("PUBLISHED");

    const publicDetail = await request(app).get(`/events/${created.body.id}`);
    expect(publicDetail.status).toBe(200);
    expect(publicDetail.body.seats).toHaveLength(200);

    const unpublished = await request(app)
      .post(`/events/${created.body.id}/unpublish`)
      .set("Authorization", `Bearer ${organizer.accessToken}`);

    expect(unpublished.status).toBe(200);
    expect(unpublished.body.status).toBe("DRAFT");

    const hiddenAgain = await request(app).get(`/events/${created.body.id}`);
    expect(hiddenAgain.status).toBe(404);
  });
});
