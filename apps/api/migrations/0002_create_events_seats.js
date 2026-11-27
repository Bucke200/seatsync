/**
 * Create the `events` and `seats` tables (Sprint 1).
 *
 * Raw DDL on purpose: every SQL statement in this project is hand-written.
 * node-pg-migrate loads this file as CommonJS, so `exports.up` / `exports.down`
 * are the contract.
 *
 * Seat hold columns (`held_by`, `held_until`, ...) deliberately do not exist
 * yet: holds are Sprint 2.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organizer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      venue TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_events_published_cursor
      ON events (starts_at ASC, id ASC)
      WHERE status = 'PUBLISHED';

    CREATE TABLE seats (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      section TEXT NOT NULL,
      row_label TEXT NOT NULL,
      number INTEGER NOT NULL CHECK (number > 0),
      price_paise INTEGER NOT NULL CHECK (price_paise > 0),
      status TEXT NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'HELD', 'BOOKED')),
      UNIQUE (event_id, section, row_label, number)
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS seats;");
  pgm.sql("DROP TABLE IF EXISTS events;");
};
