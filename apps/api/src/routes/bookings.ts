import { Router } from "express";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "../config";
import { requireAuth } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";
import {
  checkoutHold,
  getBookingDetail,
  listMyBookings,
} from "../services/bookings";

const HoldIdSchema = z.string().uuid();
const BookingIdSchema = z.string().uuid();

/** Non-UUID path ids follow the existing events/holds idiom: 400. */
function readHoldId(req: Request): string {
  return HoldIdSchema.parse(req.params.id);
}

function readBookingId(req: Request): string {
  return BookingIdSchema.parse(req.params.id);
}

function readUserId(req: Request): string {
  const user = req.user;

  if (user === undefined) {
    throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
  }

  return user.id;
}

/**
 * Booking routes. The router is mounted at the app root so the checkout path
 * stays `/holds/:id/checkout` next to the existing hold routes, while the read
 * routes are `/bookings/:id` and `/me/bookings` (D25).
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

  router.get(
    "/bookings/:id",
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const booking = await getBookingDetail(
        pool,
        readBookingId(req),
        readUserId(req),
      );

      res.status(200).json(booking);
    }),
  );

  router.get(
    "/me/bookings",
    requireAuth(config),
    asyncHandler(async (req, res) => {
      const bookings = await listMyBookings(pool, readUserId(req));

      res.status(200).json(bookings);
    }),
  );

  return router;
}
