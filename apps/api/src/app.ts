import express, { type Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { requestIdMiddleware } from "./middleware/requestId";
import { createHealthRouter } from "./routes/health";

export interface AppDependencies {
  pool: Pool;
  redis: Redis;
}

/**
 * Build the Express app from injected dependencies so tests can supply their
 * own Postgres pool and Redis client without importing the server entrypoint.
 */
export function createApp({ pool, redis }: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use("/health", createHealthRouter({ pool, redis }));

  return app;
}
