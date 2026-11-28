import { HoldRequestSchema, type HoldRequest } from "@seatsync/shared";
import { Router } from "express";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "../config";
import { requireAuth } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";
import {
  createHoldsRateLimiter,
  type HoldsRateLimiter,
} from "../middleware/rateLimit";
import { createHold, releaseHold } from "../services/holds";

const EventIdSchema = z.string().uuid();
const HoldIdSchema = z.string().uuid();
const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

function readEventId(req: Request): string {
  return EventIdSchema.parse(req.params.id);
}

function readHoldId(req: Request): string {
  return HoldIdSchema.parse(req.params.id);
}

function readUserId(req: Request): string {
  const user = req.user;

  if (user === undefined) {
    throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
  }

  return user.id;
}

/** D2: the header is required and must not be blank. */
function readIdempotencyKey(req: Request): string {
  const key = req.get(IDEMPOTENCY_KEY_HEADER)?.trim();

  if (key === undefined || key.length === 0) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      `${IDEMPOTENCY_KEY_HEADER} header is required`,
    );
  }

  return key;
}

/**
 * D7: the seat-id array is validated here. The seat-count maximum and
 * duplicate rules live in `services/holds.ts` so they also apply to direct
 * service callers; a zod failure (non-UUID, wrong shape) is reported as 422 to
 * match the plan's seat-validation status.
 */
function parseHoldRequest(req: Request): HoldRequest {
  const parsed = HoldRequestSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
  }

  return parsed.data;
}

export interface HoldsRouter {
  router: Router;
  /** Exposed so the app/server can own the limiter's connection lifecycle. */
  rateLimiter: HoldsRateLimiter;
}

/**
 * Hold routes. Both require a Bearer token; the holder-only check for release
 * lives in the db layer (403) and an unknown or expired hold is 404.
 *
 * The router is mounted at the app root because its two paths live under
 * different prefixes (`/events/...` and `/holds/...`).
 *
 * D33: the per-user limiter is created here (once per app) and applied only to
 * `POST /events/:id/holds`, after authentication and before any idempotency or
 * database work. `DELETE /holds/:id` is deliberately unlimited.
 */
export function createHoldsRouter(
  pool: Pool,
  config: Config,
  rateLimiter: HoldsRateLimiter = createHoldsRateLimiter({ config }),
): HoldsRouter {
  const router = Router();

  router.post(
    "/events/:id/holds",
    requireAuth(config),
    rateLimiter,
    asyncHandler(async (req, res) => {
      const eventId = readEventId(req);
      const idempotencyKey = readIdempotencyKey(req);
      const input = parseHoldRequest(req);
      const outcome = await createHold(pool, config, {
        userId: readUserId(req),
        eventId,
        seatIds: input.seatIds,
        idempotencyKey,
      });

      res.status(outcome.statusCode).json(outcome.body);
    }),
  );

  router.delete(
    "/holds/:id",
    requireAuth(config),
    asyncHandler(async (req, res) => {
      await releaseHold(pool, {
        userId: readUserId(req),
        holdId: readHoldId(req),
      });

      res.status(204).send();
    }),
  );

  return { router, rateLimiter };
}
