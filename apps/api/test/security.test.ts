import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type { Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createFakeWebhook, type FakeWebhookPayload } from "../src/payments";
import {
  createHoldsRateLimiter,
  type HoldsRateLimiter,
} from "../src/middleware/rateLimit";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

/**
 * D34 / design §364 — helmet, the CORS allowlist and the JSON body limit.
 *
 * The suite runs the real Express app against the compose Postgres and Redis
 * with the fake payment provider forced (D19), exactly like the rest of the
 * battery. It also pins the two behaviours most likely to regress when the
 * middleware stack changes: `/webhooks` must still receive the exact raw bytes
 * after the JSON parser (D22), and body-parser overruns must keep the standard
 * `{ error: { code, message } }` shape instead of an HTML/500 response.
 */

const PASSWORD = "password123";
const JSON_LIMIT_BYTES = 100 * 1024;
const DISALLOWED_ORIGIN = "https://evil.example";
const REFRESH_COOKIE = "refresh_token";

/** Extract one cookie from a `Set-Cookie` header (string or array). */
function findSetCookie(header: unknown, name: string): string {
  const values = Array.isArray(header)
    ? header.filter((value): value is string => typeof value === "string")
    : typeof header === "string"
      ? [header]
      : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));

  if (cookie === undefined) {
    throw new Error(`Expected a ${name} Set-Cookie header`);
  }

  return cookie;
}

function cookiePair(setCookie: string): string {
  return setCookie.split(";")[0];
}

describe("security middleware", () => {
  let app: Express;
  let pool: Pool;
  let redis: Redis;
  let config: Config;
  let limiter: HoldsRateLimiter;
  let allowedOrigin: string;

  beforeAll(() => {
    config = loadConfig({ ...process.env, PAYMENT_PROVIDER: "fake" });
    pool = createPool(config);
    redis = createRedisClient(config);
    limiter = createHoldsRateLimiter({ config });
    app = createApp({ pool, redis, config, holdsRateLimiter: limiter });

    const firstOrigin = config.CORS_ORIGINS[0];

    if (firstOrigin === undefined) {
      throw new Error("CORS_ORIGINS must contain at least one origin");
    }

    allowedOrigin = firstOrigin;
  });

  beforeEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await limiter.close();
    redis.disconnect();
    await pool.end();
  });

  it("sets helmet's headers on API responses without losing X-Request-Id", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["strict-transport-security"]).toContain(
      "includeSubDomains",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    // D34 deviation: the only disabled CSP directive, so /docs assets work
    // over http in local development. Every other default stays enabled.
    expect(response.headers["content-security-policy"]).not.toContain(
      "upgrade-insecure-requests",
    );
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("keeps /docs and /docs.json working with helmet enabled", async () => {
    const docs = await request(app).get("/docs");

    expect(docs.status).toBe(200);
    expect(docs.headers["content-type"]).toMatch(/text\/html/);
    // Smoke check that the served HTML is the Swagger UI shell, not an error
    // page, and that its script bundle is referenced (helmet's CSP allows the
    // same-origin bundle because `script-src 'self'` is still on).
    expect(docs.text).toContain('id="swagger-ui"');
    expect(docs.text).toContain("swagger-ui-bundle.js");
    expect(docs.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );

    const spec = await request(app).get("/docs.json");

    expect(spec.status).toBe(200);
    expect(spec.body).toMatchObject({ openapi: expect.stringMatching(/^3\.0\./) });
  });

  it("echoes the allowed origin with credentials enabled", async () => {
    const response = await request(app)
      .get("/docs.json")
      .set("Origin", allowedOrigin);

    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["vary"]).toContain("Origin");
  });

  it("does not emit CORS headers for a disallowed origin", async () => {
    const response = await request(app)
      .get("/docs.json")
      .set("Origin", DISALLOWED_ORIGIN);

    // The request itself still succeeds; the browser is the enforcement point.
    // `cors` always emits Allow-Credentials when configured with
    // `credentials: true`, but without Allow-Origin the browser exposes no
    // response and sends no credentialed request, so no access is granted.
    expect(response.status).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers preflight OPTIONS for an allowed credentialed origin", async () => {
    const response = await request(app)
      .options("/auth/refresh")
      .set("Origin", allowedOrigin)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");

    expect(response.status).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe(allowedOrigin);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");
    expect(response.headers["access-control-allow-headers"]).toContain(
      "content-type",
    );
  });

  it("does not answer a preflight from a disallowed origin with CORS headers", async () => {
    const response = await request(app)
      .options("/auth/refresh")
      .set("Origin", DISALLOWED_ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    // Same rationale as the simple request above: no Allow-Origin means the
    // preflight grants nothing, whatever the Allow-Credentials value says.
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps the credentialed refresh flow working for same-origin calls", async () => {
    const signup = await request(app).post("/auth/signup").send({
      email: `security-refresh-${randomUUID()}@seatsync.local`,
      password: PASSWORD,
      role: "ATTENDEE",
    });

    expect(signup.status).toBe(201);

    const refreshCookie = cookiePair(
      findSetCookie(signup.headers["set-cookie"], REFRESH_COOKIE),
    );
    const refreshed = await request(app)
      .post("/auth/refresh")
      .set("Cookie", refreshCookie);

    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.body.accessToken).toBe("string");
  });

  it("maps an oversized JSON body to 413 PAYLOAD_TOO_LARGE", async () => {
    const response = await request(app)
      .post("/auth/signup")
      .send({
        email: `security-large-${randomUUID()}@seatsync.local`,
        password: PASSWORD,
        role: "ATTENDEE",
        // Push the serialized body well past the 100kb parser limit.
        padding: "x".repeat(JSON_LIMIT_BYTES + 20 * 1024),
      });

    expect(response.status).toBe(413);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body too large",
      },
    });
    expect(response.text).not.toContain("<html");
  });

  it("still accepts a normal-size JSON signup", async () => {
    const response = await request(app).post("/auth/signup").send({
      email: `security-normal-${randomUUID()}@seatsync.local`,
      password: PASSWORD,
      role: "ATTENDEE",
    });

    expect(response.status).toBe(201);
  });

  it("keeps malformed JSON mapped to 400 INVALID_JSON", async () => {
    const response = await request(app)
      .post("/auth/signup")
      .set("Content-Type", "application/json")
      .send('{"email":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: "INVALID_JSON", message: "Invalid JSON body" },
    });
  });

  it("preserves the exact raw webhook bytes for HMAC verification", async () => {
    const payload: FakeWebhookPayload = {
      eventId: randomUUID(),
      type: "payment_succeeded",
      bookingId: randomUUID(),
      holdId: randomUUID(),
      paymentRef: `pay_${randomUUID()}`,
    };
    const { rawBody, signature } = createFakeWebhook(
      payload,
      config.PAYMENT_WEBHOOK_SECRET,
    );

    const response = await request(app)
      .post(`/webhooks/${config.PAYMENT_PROVIDER}`)
      // octet-stream keeps the exact bytes supertest signed; a JSON parser
      // would have replaced req.body with an object and failed verification.
      .set("Content-Type", "application/octet-stream")
      .set("x-fake-signature", signature)
      .send(rawBody);

    // Unknown booking id: a verified delivery commits the dedupe row and
    // returns 200 without touching a booking.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true });
  });

  it("maps an oversized raw webhook body to the same 413 shape", async () => {
    const oversized = Buffer.alloc(JSON_LIMIT_BYTES + 20 * 1024, 0x61);

    const response = await request(app)
      .post(`/webhooks/${config.PAYMENT_PROVIDER}`)
      .set("Content-Type", "application/octet-stream")
      .set("x-fake-signature", "0".repeat(64))
      .send(oversized);

    // express.raw keeps body-parser's 100kb default, so the limit applies
    // before signature verification and is mapped exactly like JSON overruns.
    expect(response.status).toBe(413);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(response.body).toEqual({
      error: {
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body too large",
      },
    });
  });
});
