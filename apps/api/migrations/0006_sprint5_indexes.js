/**
 * Sprint 5 load-hardening indexes (Sprint 5).
 *
 * Raw DDL on purpose: every SQL statement in this project is hand-written.
 * node-pg-migrate loads this file as CommonJS, so `exports.up` / `exports.down`
 * are the contract.
 *
 * Every index below is justified by `EXPLAIN (ANALYZE, BUFFERS)` on the hot
 * queries (see the Sprint 5 completion report for the before/after plans).
 * Measured on a representative fixture (45,050 seats, 10,000 bookings):
 *
 * 1. `idx_seats_hold_id` — webhook/release seat lookups
 *    (`bookings.ts` pre-lock/confirm/shortfall UPDATE, `seats.ts` release
 *    pre-lock/UPDATE) filter `seats.hold_id` with no supporting index. The
 *    BOOKED-hold shortfall release was a 45,050-row sequential scan (879
 *    buffers, 7.5 ms); it becomes a 2-row bitmap index scan (2 heap blocks,
 *    0.2 ms). Held/booked seats are the only rows with a non-NULL `hold_id`
 *    (released seats are set back to NULL), so a partial index keeps the
 *    index to the active subset instead of one entry per seat.
 *
 * 2. `idx_seats_event_held_by` — the second-hold guard (`seats.ts:257-266`)
 *    filters `event_id + held_by + status`. `idx_seats_event_id_status`
 *    returns every HELD seat in the event (350 rows / 123 heap blocks on the
 *    fixture) and filters `held_by` afterwards; the composite index returns
 *    the user's 4 rows in 8 buffers. Only held/booked seats carry `held_by`,
 *    so the partial predicate matches every query that uses the index.
 *
 * 3. `idx_bookings_user_created` — `listUserBookings` (`bookings.ts:732-760`)
 *    filters `user_id` and orders by `created_at DESC, id DESC`. With no
 *    index it sequentially scans every booking (10,000 rows / 154 buffers)
 *    and sorts; the composite index reads only the user's 20 rows (20 heap
 *    blocks) and lets the planner use the index order for future `LIMIT`
 *    shapes while still sorting the small result today.
 *
 * Deliberately NOT added (EXPLAIN did not justify the cost):
 * - event-detail covering index: the existing `idx_seats_event_id_status`
 *   already drives a bitmap scan of the event's seats (5,000 rows in 8 ms);
 *   the load target is a 50-seat flash-sale event, so no win.
 * - `seats(held_until) WHERE status = 'HELD'` for the sweeper: only a modest
 *   sweep win (2.0 ms -> 1.5 ms) and the planner then picked it for the
 *   hold-release pre-lock and second-hold guard, *worsening* both (44 vs 4
 *   buffers; 43 vs 8 buffers).
 * - `idempotency_keys(created_at)` for the retention prune: the prune is a
 *   once-per-sweep background scan (3.7 ms over 20,000 keys) and the index
 *   would add a write on every hold's idempotency claim; deferred until a
 *   measured need, per D32's "at most 1-2 others" bound.
 *
 * `down` drops exactly what `up` adds, in reverse order; no table or column
 * changes are involved.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX idx_seats_hold_id
      ON seats (hold_id)
      WHERE hold_id IS NOT NULL;

    CREATE INDEX idx_seats_event_held_by
      ON seats (event_id, held_by)
      WHERE held_by IS NOT NULL;

    CREATE INDEX idx_bookings_user_created
      ON bookings (user_id, created_at DESC, id DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql("DROP INDEX IF EXISTS idx_bookings_user_created;");
  pgm.sql("DROP INDEX IF EXISTS idx_seats_event_held_by;");
  pgm.sql("DROP INDEX IF EXISTS idx_seats_hold_id;");
};
