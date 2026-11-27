import { Router } from "express";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "../config";
import { requireAuth } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";
import { checkoutHold } from "../services/bookings";

const HoldIdSchema = z.string().uuid();

/** Non-UUID path ids follow the existing events/holds idiom: 400. */
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

/**
 * Booking routes. Step 3 only adds the holder-only checkout; the booking read
 * routes and OpenAPI path registration arrive with Steps 5.
 *
 * Mounted at the app root so the path stays `/holds/:id/checkout` next to the
 * existing hold routes.
 */
export function createBookingsRouter(pool: Pool, config: Config): Router {
  const router = Router();

  router.post(
    "/holds/:id/checkout",
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const outcome = await checkoutHold(pool, config, {
        holdId: readHoldId(req),
        userId: readUserId(req),
      });

      res.status(outcome.statusCode).json(outcome.body);
    }),
  );

  return router;
}
