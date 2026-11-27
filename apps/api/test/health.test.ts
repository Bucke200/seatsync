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

/**
 * Integration tests: they run against the real compose Postgres (host port
 * 5434) and Redis (host port 6379). Nothing here mocks `pg`; the only degraded
 * dependency is a second Redis client pointed at an unused port.
 */
describe("GET /health", () => {
  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;

  beforeAll(() => {
    config = loadConfig(process.env);
    pool = createPool(config);
    redis = createRedisClient(config);
    app = createApp({ pool, redis });
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

  it("returns 200 with both dependencies healthy and sets X-Request-Id", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ db: "ok", redis: "ok" });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });

  it("echoes an incoming x-request-id header", async () => {
    const response = await request(app).get("/health").set("x-request-id", "test-123");

    expect(response.status).toBe(200);
    expect(response.headers["x-request-id"]).toBe("test-123");
  });

  it("returns 503 naming redis while Postgres stays healthy when redis is unreachable", async () => {
    const unreachableRedis = createRedisClient({
      ...config,
      REDIS_URL: "redis://127.0.0.1:6390",
    });
    // Do not let an intentionally dead client schedule background reconnects.
    // It is still a real ioredis client talking to a closed port; this only
    // keeps its retry timers from outliving the test.
    unreachableRedis.options.retryStrategy = () => null;

    try {
      const degradedApp = createApp({ pool, redis: unreachableRedis });
      const response = await request(degradedApp).get("/health");

      expect(response.status).toBe(503);
      expect(response.body).toEqual({ db: "ok", redis: "error" });
    } finally {
      // ioredis already closed the failed stream and reports "end". Calling
      // disconnect() now would arm its 2s connector-cleanup timer and keep Jest
      // alive, so only disconnect a client that still has a live/waiting socket.
      if (unreachableRedis.status !== "end") {
        unreachableRedis.disconnect();
      }
    }
  });

  it("truncateAll removes inserted users", async () => {
    await pool.query("INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)", [
      "truncate-test@seatsync.local",
      "not-a-real-hash",
      "ATTENDEE",
    ]);

    const countUsers = async (): Promise<number> => {
      const result = await pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM users",
      );
      return result.rows[0].count;
    };

    expect(await countUsers()).toBe(1);

    await truncateAll(pool);

    expect(await countUsers()).toBe(0);
  });
});
