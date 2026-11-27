import type { Pool } from "pg";

/**
 * Application tables cleared between integration tests.
 *
 * This is deliberately an explicit, ordered array instead of discovering every
 * table in `public`: the blast radius stays predictable, `pgmigrations` and any
 * future non-test infrastructure tables can never be truncated, and the order
 * documents dependencies (though `CASCADE` also follows foreign keys). When a
 * migration adds an application table, append it here.
 */
export const APPLICATION_TABLES = ["users"] as const;

/**
 * Empty every application table while keeping the schema intact.
 *
 * `RESTART IDENTITY` resets sequences so tests cannot depend on leftovers, and
 * `CASCADE` clears dependent rows. Postgres runs this as a single statement, so
 * it is atomic with respect to concurrent sessions (tests still run serially).
 */
export async function truncateAll(pool: Pool): Promise<void> {
  const tableList = APPLICATION_TABLES.map((table) => `"${table}"`).join(", ");

  await pool.query(`TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`);
}
