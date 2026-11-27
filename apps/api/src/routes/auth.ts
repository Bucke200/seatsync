import { LoginRequestSchema, SignupRequestSchema } from "@seatsync/shared";
import type { AuthResponse, RefreshResponse } from "@seatsync/shared";
import { Router } from "express";
import type { CookieOptions, Request, Response } from "express";
import type { Pool } from "pg";
import type { Config } from "../config";
import { requireAuth } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";
import { createAuthService } from "../services/auth";

const REFRESH_TOKEN_COOKIE = "refresh_token";

function refreshCookieOptions(config: Config): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: config.REFRESH_TOKEN_TTL_SECONDS * 1000,
  };
}

function clearedRefreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
  };
}

function readRefreshToken(req: Request): string | undefined {
  const cookies: unknown = req.cookies;

  if (typeof cookies !== "object" || cookies === null) {
    return undefined;
  }

  const token = (cookies as Record<string, unknown>)[REFRESH_TOKEN_COOKIE];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function setRefreshCookie(res: Response, config: Config, token: string): void {
  res.cookie(REFRESH_TOKEN_COOKIE, token, refreshCookieOptions(config));
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_TOKEN_COOKIE, clearedRefreshCookieOptions());
}

/**
 * `POST /auth/signup`, `/auth/login`, `/auth/refresh` and `/auth/logout`.
 * Bodies are validated here; hashing, storage and token signing live in
 * `services/auth.ts`, SQL lives in `db/*`.
 */
export function createAuthRouter(pool: Pool, config: Config): Router {
  const router = Router();
  const auth = createAuthService(pool, config);

  router.post(
    "/signup",
    asyncHandler(async (req, res) => {
      const input = SignupRequestSchema.parse(req.body);
      const session = await auth.signup(input);

      setRefreshCookie(res, config, session.refreshToken);
      const body: AuthResponse = {
        user: session.user,
        accessToken: session.accessToken,
      };
      res.status(201).json(body);
    }),
  );

  router.post(
    "/login",
    asyncHandler(async (req, res) => {
      const input = LoginRequestSchema.parse(req.body);
      const session = await auth.login(input);

      setRefreshCookie(res, config, session.refreshToken);
      const body: AuthResponse = {
        user: session.user,
        accessToken: session.accessToken,
      };
      res.status(200).json(body);
    }),
  );

  router.post(
    "/refresh",
    asyncHandler(async (req, res) => {
      const session = await auth.refresh(readRefreshToken(req));

      setRefreshCookie(res, config, session.refreshToken);
      const body: RefreshResponse = { accessToken: session.accessToken };
      res.status(200).json(body);
    }),
  );

  router.post(
    "/logout",
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const user = req.user;

      if (user === undefined) {
        throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
      }

      await auth.logout(readRefreshToken(req), user.id);
      clearRefreshCookie(res);
      res.status(204).send();
    }),
  );

  return router;
}
