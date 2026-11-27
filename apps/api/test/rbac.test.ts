import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { CreateEventRequest, UserRole } from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

describe("rbac", () => {
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

  async function signupUser(role: UserRole): Promise<string> {
    const response = await request(app)
      .post("/auth/signup")
      .send({
        email: `rbac-${randomUUID()}@seatsync.local`,
        password: "password123",
        role,
      });

    expect(response.status).toBe(201);

    return response.body.accessToken;
  }

  function eventPayload(): CreateEventRequest {
    return {
      title: "Ownership test",
      venue: "Main stage",
      startsAt: "2027-07-01T18:00:00.000Z",
      sections: [{ name: "Floor", rows: 2, seatsPerRow: 5, pricePaise: 1500 }],
    };
  }

  it("rejects an attendee on an organizer route with 403", async () => {
    const attendeeToken = await signupUser("ATTENDEE");

    const response = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${attendeeToken}`)
      .send(eventPayload());

    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("rejects organizer B editing or publishing organizer A's event with 403", async () => {
    const organizerAToken = await signupUser("ORGANIZER");
    const organizerBToken = await signupUser("ORGANIZER");

    const created = await request(app)
      .post("/events")
      .set("Authorization", `Bearer ${organizerAToken}`)
      .send(eventPayload());

    expect(created.status).toBe(201);
    const eventId = created.body.id;

    const patched = await request(app)
      .patch(`/events/${eventId}`)
      .set("Authorization", `Bearer ${organizerBToken}`)
      .send({ title: "Hijacked" });

    expect(patched.status).toBe(403);
    expect(patched.body).toMatchObject({ error: { code: "FORBIDDEN" } });

    const published = await request(app)
      .post(`/events/${eventId}/publish`)
      .set("Authorization", `Bearer ${organizerBToken}`);

    expect(published.status).toBe(403);
    expect(published.body).toMatchObject({ error: { code: "FORBIDDEN" } });

    const unpublished = await request(app)
      .post(`/events/${eventId}/unpublish`)
      .set("Authorization", `Bearer ${organizerBToken}`);

    expect(unpublished.status).toBe(403);
    expect(unpublished.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});
