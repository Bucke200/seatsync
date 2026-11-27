/**
 * Seat holds, bookings and idempotency keys (Sprint 2).
 *
 * Raw DDL on purpose: every SQL statement in this project is hand-written.
 * node-pg-migrate loads this file as CommonJS, so `exports.up` / `exports.down`
 * are the contract.
 *
 * `seats` gains the hold columns and an optimistic `version` counter.
 * `bookings` / `booking_seats` exist for the Sprint 3 checkout flow, with the
 * partial unique index from Rule 3 as the database-level backstop against a
 * second CONFIRMED booking for the same seat. `idempotency_keys` stores the
 * response replayed for a repeated `Idempotency-Key` on the hold endpoint.
 *
 * Unlike the earlier migrations, `down` drops only what `up` added: a previous
 * table drop here would destroy Sprint 1 tables on `migrate down`.
 */

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE seats
      ADD COLUMN hold_id UUID NULL,
      ADD COLUMN held_by UUID NULL REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN held_until TIMESTAMPTZ NULL,
      ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX idx_seats_event_id_status ON seats (event_id, status);

    CREATE TABLE bookings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      hold_id UUID NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED')),
      amount_paise INTEGER NOT NULL CHECK (amount_paise >= 0),
      payment_ref TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE booking_seats (
      booking_id UUID NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
      seat_id UUID NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'REFUNDED')),
      PRIMARY KEY (booking_id, seat_id)
    );

    CREATE UNIQUE INDEX one_confirmed_booking_per_seat
      ON booking_seats (seat_id)
      WHERE status = 'CONFIRMED';

    CREATE TABLE idempotency_keys (
      key TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response JSONB NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP TABLE IF EXISTS idempotency_keys;");
  pgm.sql("DROP INDEX IF EXISTS one_confirmed_booking_per_seat;");
  pgm.sql("DROP TABLE IF EXISTS booking_seats;");
  pgm.sql("DROP TABLE IF EXISTS bookings;");
  pgm.sql("DROP INDEX IF EXISTS idx_seats_event_id_status;");
  pgm.sql(`
    ALTER TABLE seats
      DROP COLUMN IF EXISTS version,
      DROP COLUMN IF EXISTS held_until,
      DROP COLUMN IF EXISTS held_by,
      DROP COLUMN IF EXISTS hold_id;
  `);
};
