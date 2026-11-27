import {
  CreateEventRequestSchema,
  PaginationQuerySchema,
  UpdateEventRequestSchema,
} from "@seatsync/shared";
import { Router } from "express";
import type { Request } from "express";
import type { Pool } from "pg";
import { z } from "zod";
import type { Config } from "../config";
import { optionalAuth, requireAuth, requireRole } from "../middleware/auth";
import { ApiError, asyncHandler } from "../middleware/errors";
import {
  createEvent,
  getEventDetail,
  listEvents,
  publishEvent,
  unpublishEvent,
  updateEvent,
} from "../services/events";

const EventIdSchema = z.string().uuid();

function readEventId(req: Request): string {
  return EventIdSchema.parse(req.params.id);
}

function readUserId(req: Request): string {
  const user = req.user;

  if (user === undefined) {
    throw new ApiError(401, "UNAUTHORIZED", "Authentication required");
  }

  return user.id;
}

/**
 * `/events` routes. Organizer writes are guarded by `requireAuth` +
 * `requireRole("ORGANIZER")`; ownership is checked in `services/events.ts`.
 * `GET /events/:id` uses `optionalAuth` so a draft is visible to its owner.
 */
export function createEventsRouter(pool: Pool, config: Config): Router {
  const router = Router();

  router.post(
    "/",
    requireAuth(config),
    requireRole("ORGANIZER"),
    asyncHandler(async (req, res) => {
      const input = CreateEventRequestSchema.parse(req.body);
      const event = await createEvent(pool, readUserId(req), input);

      res.status(201).json(event);
    }),
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const query = PaginationQuerySchema.parse(req.query);
      const page = await listEvents(pool, query);

      res.status(200).json(page);
    }),
  );

  router.get(
    "/:id",
    optionalAuth(config),
    asyncHandler(async (req, res) => {
      const event = await getEventDetail(pool, readEventId(req), req.user);

      res.status(200).json(event);
    }),
  );

  router.patch(
    "/:id",
    requireAuth(config),
    requireRole("ORGANIZER"),
    asyncHandler(async (req, res) => {
      const input = UpdateEventRequestSchema.parse(req.body);
      const event = await updateEvent(pool, readEventId(req), readUserId(req), input);

      res.status(200).json(event);
    }),
  );

  router.post(
    "/:id/publish",
    requireAuth(config),
    requireRole("ORGANIZER"),
    asyncHandler(async (req, res) => {
      const event = await publishEvent(pool, readEventId(req), readUserId(req));

      res.status(200).json(event);
    }),
  );

  router.post(
    "/:id/unpublish",
    requireAuth(config),
    requireRole("ORGANIZER"),
    asyncHandler(async (req, res) => {
      const event = await unpublishEvent(pool, readEventId(req), readUserId(req));

      res.status(200).json(event);
    }),
  );

  return router;
}
