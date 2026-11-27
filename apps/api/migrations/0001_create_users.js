/**
 * Create the `users` table (Sprint 0).
 *
 * Raw DDL on purpose: every SQL statement in this project is hand-written.
 * node-pg-migrate loads this file as CommonJS, so `exports.up` / `exports.down`
 * are the contract.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('ORGANIZER', 'ATTENDEE')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS users;");
};
