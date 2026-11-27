import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createRedisClient } from "../src/realtime/redis";

interface OpenApiDocumentBody {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

describe("openapi docs", () => {
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

  afterAll(async () => {
    redis.disconnect();
    await pool.end();
  });

  it("serves Swagger UI at GET /docs without a redirect", async () => {
    const response = await request(app).get("/docs");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.text).toContain('id="swagger-ui"');
  });

  it("serves the generated spec at GET /docs.json", async () => {
    const response = await request(app).get("/docs.json");

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);

    const document = response.body as OpenApiDocumentBody;

    expect(document.openapi).toMatch(/^3\.0\./);
    expect(document.info.title).toBe("SeatSync API");
    expect(document.paths["/health"]).toBeDefined();
    expect(document.paths["/auth/signup"]).toBeDefined();
    expect(document.paths["/events"]).toBeDefined();
    expect(document.paths["/events/{id}"]).toBeDefined();
    expect(document.paths["/events/{id}/publish"]).toBeDefined();
    expect(document.paths["/events/{id}/unpublish"]).toBeDefined();
    expect(document.components.schemas["SignupRequest"]).toBeDefined();
    expect(document.components.schemas["CreateEventRequest"]).toBeDefined();
    expect(document.components.schemas["EventDetail"]).toBeDefined();
    expect(document.components.schemas["ErrorResponse"]).toBeDefined();
    expect(document.components.securitySchemes["bearerAuth"]).toBeDefined();
    expect(document.components.securitySchemes["cookieAuth"]).toBeDefined();
  });
});
