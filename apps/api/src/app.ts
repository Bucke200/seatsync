import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import swaggerUi from "swagger-ui-express";
import { loadConfig, type Config } from "./config";
import { errorHandler } from "./middleware/errors";
import { requestIdMiddleware } from "./middleware/requestId";
import { generateOpenApiDocument } from "./openapi";
import { createAuthRouter } from "./routes/auth";
import { createBookingsRouter } from "./routes/bookings";
import { createEventsRouter } from "./routes/events";
import { createHealthRouter } from "./routes/health";
import { createHoldsRouter } from "./routes/holds";

export interface AppDependencies {
  pool: Pool;
  redis: Redis;
  /** Defaults to `loadConfig(process.env)` so existing call sites keep working. */
  config?: Config;
}

/**
 * Build the Express app from injected dependencies so tests can supply their
 * own Postgres pool and Redis client without importing the server entrypoint.
 */
export function createApp({
  pool,
  redis,
  config = loadConfig(process.env),
}: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(express.json());
  app.use(cookieParser());
  app.use("/health", createHealthRouter({ pool, redis }));
  app.use("/auth", createAuthRouter(pool, config));
  app.use("/events", createEventsRouter(pool, config));
  // Two prefixes under one router (`/events/{id}/holds`, `/holds/{id}`).
  app.use(createHoldsRouter(pool, config));
  // `/holds/{id}/checkout` (Step 3); booking reads join this router in Step 5.
  app.use(createBookingsRouter(pool, config));

  const openApiDocument = generateOpenApiDocument();
  const swaggerHtml = swaggerUi.generateHTML(openApiDocument);

  app.get("/docs.json", (_req, res) => {
    res.json(openApiDocument);
  });
  // Serve /docs (no trailing slash) directly so Swagger UI answers 200 instead
  // of swaggerUi.serve redirecting to /docs/ with a 301.
  app.get("/docs", (_req, res) => {
    res.type("html").send(swaggerHtml);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(errorHandler);

  return app;
}
