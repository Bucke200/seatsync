import type { UserRole } from "@seatsync/shared";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import jwt from "jsonwebtoken";
import type { Config } from "../config";
import { ApiError } from "./errors";

declare module "express-serve-static-core" {
  interface Request {
    /** Authenticated principal, set by `requireAuth` or `optionalAuth`. */
    user?: { id: string; role: UserRole };
  }
}

function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;

  if (typeof header !== "string") {
    return null;
  }

  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

/**
 * Verify a JWT access token and return the principal it names.
 *
 * Shared by the HTTP middleware and the `/ws` handshake (D28): the validation
 * semantics are deliberately identical — a string `sub` and an
 * `ORGANIZER`/`ATTENDEE` `role` are required, and anything else throws an
 * `ApiError(401, "UNAUTHORIZED")`.
 */
export function verifyAccessToken(
  token: string,
  config: Config,
): { id: string; role: UserRole } {
  let payload: string | jwt.JwtPayload;

  try {
    payload = jwt.verify(token, config.JWT_SECRET);
  } catch {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid or expired access token");
  }

  if (typeof payload === "string") {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid access token");
  }

  const sub: unknown = payload.sub;
  const role: unknown = payload.role;

  if (typeof sub !== "string" || (role !== "ORGANIZER" && role !== "ATTENDEE")) {
    throw new ApiError(401, "UNAUTHORIZED", "Invalid access token");
  }

  return { id: sub, role };
}

/** Require a valid `Authorization: Bearer <jwt>` access token. */
export function requireAuth(config: Config): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);

    if (token === null) {
      next(new ApiError(401, "UNAUTHORIZED", "Authentication required"));
      return;
    }

    try {
      req.user = verifyAccessToken(token, config);
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Attach `req.user` when a valid Bearer token is present, but never reject:
 * public routes use this to unlock owner-only visibility.
 */
export function optionalAuth(config: Config): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = readBearerToken(req);

    if (token !== null) {
      try {
        req.user = verifyAccessToken(token, config);
      } catch {
        // An invalid or expired optional credential is treated as anonymous.
      }
    }

    next();
  };
}

/** Require the authenticated principal to have a specific role. */
export function requireRole(role: UserRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (req.user?.role !== role) {
      next(new ApiError(403, "FORBIDDEN", "Insufficient permissions"));
      return;
    }

    next();
  };
}
