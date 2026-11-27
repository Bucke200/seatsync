import type { Logger } from "pino";
import { Pool } from "pg";
import type { Config } from "../config";
import { logger } from "../logger";

/**
 * Create the PostgreSQL connection pool. SeatSync talks to Postgres with raw
 * SQL only (no ORM); pool sizing comes from the validated configuration.
 */
export function createPool(config: Config, log: Logger = logger): Pool {
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    max: config.DB_POOL_SIZE,
    // Bound health-check and first-query latency when Postgres is black-holed.
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (error) => {
    log.error({ err: error }, "unexpected PostgreSQL pool error");
  });

  return pool;
}
