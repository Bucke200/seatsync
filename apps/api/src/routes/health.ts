import { HealthResponseSchema } from "@seatsync/shared";
import { Router } from "express";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { pingRedis } from "../realtime/redis";

export interface HealthRouteDependencies {
  pool: Pool;
  redis: Redis;
}

async function isDatabaseHealthy(pool: Pool): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/**
 * `GET /health`: 200 only when both Postgres and Redis answer, otherwise 503
 * naming every dependency that failed.
 */
export function createHealthRouter({ pool, redis }: HealthRouteDependencies): Router {
  const router = Router();

  router.get("/", async (_req, res) => {
    const [databaseOk, redisOk] = await Promise.all([isDatabaseHealthy(pool), pingRedis(redis)]);

    const body = HealthResponseSchema.parse({
      db: databaseOk ? "ok" : "error",
      redis: redisOk ? "ok" : "error",
    });

    res.status(databaseOk && redisOk ? 200 : 503).json(body);
  });

  return router;
}
