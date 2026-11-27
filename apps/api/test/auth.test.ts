import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "@jest/globals";
import type { UserRole } from "@seatsync/shared";
import type { Express } from "express";
import type { Redis } from "ioredis";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import request from "supertest";
import { createApp } from "../src/app";
import { loadConfig, type Config } from "../src/config";
import { createPool } from "../src/db/pool";
import { createRedisClient } from "../src/realtime/redis";
import { truncateAll } from "./helpers/db";

const PASSWORD = "correct-horse-battery";
const REFRESH_COOKIE = "refresh_token";

/**
 * Extract one cookie from a `Set-Cookie` header. Supertest exposes the header
 * as an array for multiple cookies; a single string is handled too.
 */
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

describe("auth", () => {
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

  async function signupUser(role: UserRole = "ATTENDEE") {
    const email = `auth-${randomUUID()}@seatsync.local`;
    const response = await request(app)
      .post("/auth/signup")
      .send({ email, password: PASSWORD, role });

    return { email, response };
  }

  it("rejects a protected route without an access token", async () => {
    const response = await request(app).post("/auth/logout");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: { code: "UNAUTHORIZED", message: "Authentication required" },
    });
  });

  it("rejects an expired access token without waiting on real time", async () => {
    const token = jwt.sign({ sub: randomUUID(), role: "ATTENDEE" }, config.JWT_SECRET, {
      expiresIn: -10,
    });

    const response = await request(app)
      .post("/auth/logout")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("signs up a user and sets a hardened refresh cookie", async () => {
    const { email, response } = await signupUser("ORGANIZER");

    expect(response.status).toBe(201);
    expect(response.body.user).toMatchObject({ email, role: "ORGANIZER" });
    expect(response.body.user.id).toEqual(expect.any(String));
    expect(response.body.user.passwordHash).toBeUndefined();
    expect(typeof response.body.accessToken).toBe("string");

    const setCookie = findSetCookie(response.headers["set-cookie"], REFRESH_COOKIE);

    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).toContain(`Max-Age=${config.REFRESH_TOKEN_TTL_SECONDS}`);
  });

  it("logs in with the right password and rejects a wrong one", async () => {
    const { email } = await signupUser();

    const login = await request(app).post("/auth/login").send({ email, password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ email, role: "ATTENDEE" });
    expect(typeof login.body.accessToken).toBe("string");

    const denied = await request(app)
      .post("/auth/login")
      .send({ email, password: "definitely-not-the-password" });

    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns a new access token and rotates the refresh token", async () => {
    const { response } = await signupUser();
    const oldCookie = findSetCookie(response.headers["set-cookie"], REFRESH_COOKIE);
    const oldPair = cookiePair(oldCookie);

    const refreshed = await request(app).post("/auth/refresh").set("Cookie", oldPair);

    expect(refreshed.status).toBe(200);
    expect(typeof refreshed.body.accessToken).toBe("string");
    expect(refreshed.body.accessToken).not.toBe(response.body.accessToken);

    const newCookie = findSetCookie(refreshed.headers["set-cookie"], REFRESH_COOKIE);
    expect(cookiePair(newCookie)).not.toBe(oldPair);

    // The rotated-out token is revoked, so it cannot be replayed.
    const replay = await request(app).post("/auth/refresh").set("Cookie", oldPair);
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejects refresh after logout", async () => {
    const { response } = await signupUser();
    const pair = cookiePair(findSetCookie(response.headers["set-cookie"], REFRESH_COOKIE));

    const logout = await request(app)
      .post("/auth/logout")
      .set("Authorization", `Bearer ${response.body.accessToken}`)
      .set("Cookie", pair);

    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]).toBeDefined();

    const refreshed = await request(app).post("/auth/refresh").set("Cookie", pair);

    expect(refreshed.status).toBe(401);
    expect(refreshed.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejects a refresh token expired in the database without waiting", async () => {
    const { response } = await signupUser();
    const pair = cookiePair(findSetCookie(response.headers["set-cookie"], REFRESH_COOKIE));

    await pool.query("UPDATE refresh_tokens SET expires_at = '2000-01-01T00:00:00Z'");

    const refreshed = await request(app).post("/auth/refresh").set("Cookie", pair);

    expect(refreshed.status).toBe(401);
    expect(refreshed.body.error.code).toBe("INVALID_REFRESH_TOKEN");
  });

  it("rejects a duplicate email with 409 and an invalid body with 400", async () => {
    const { email } = await signupUser();

    const duplicate = await request(app)
      .post("/auth/signup")
      .send({ email, password: PASSWORD, role: "ATTENDEE" });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("EMAIL_TAKEN");

    const invalid = await request(app)
      .post("/auth/signup")
      .send({ email: "not-an-email", password: "short", role: "ADMIN" });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(invalid.body.error.details)).toBe(true);
  });

  it("returns 400 INVALID_JSON for a malformed JSON body", async () => {
    const response = await request(app)
      .post("/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: "INVALID_JSON", message: "Invalid JSON body" },
    });
  });
});
