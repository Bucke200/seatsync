/**
 * Create the `refresh_tokens` table (Sprint 1).
 *
 * Raw DDL on purpose: every SQL statement in this project is hand-written.
 * node-pg-migrate loads this file as CommonJS, so `exports.up` / `exports.down`
 * are the contract.
 *
 * The cookie holds a random token; this table stores only its SHA-256 hash so
 * a database leak cannot be replayed against the API. Logout sets `revoked_at`
 * instead of deleting the row.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE refresh_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ NULL
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS refresh_tokens;");
};
