import cookieParser from "cookie-parser";
import express, { type Express } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { loadConfig, type Config } from "./config";
import { errorHandler } from "./middleware/errors";
import { requestIdMiddleware } from "./middleware/requestId";
import { createAuthRouter } from "./routes/auth";
import { createHealthRouter } from "./routes/health";

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
  app.use(errorHandler);

  return app;
}
