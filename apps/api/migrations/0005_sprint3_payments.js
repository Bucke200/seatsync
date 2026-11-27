/**
 * Payments: webhook dedupe and persisted checkout URLs (Sprint 3).
 *
 * Raw DDL on purpose: every SQL statement in this project is hand-written.
 * node-pg-migrate loads this file as CommonJS, so `exports.up` / `exports.down`
 * are the contract.
 *
 * `processed_webhooks` is the Rule 4 dedupe target: one row per provider event
 * id, inserted with `ON CONFLICT (event_id) DO NOTHING` inside the webhook
 * transaction. The column names are load-bearing: the holds sweeper prunes rows
 * with `DELETE FROM processed_webhooks WHERE received_at < now() - ...`
 * (src/jobs/expireHolds.ts), so `event_id` / `provider` / `received_at` must
 * stay exactly as named here.
 *
 * `bookings.checkout_url` stores the provider checkout URL returned on the
 * first `POST /holds/:id/checkout` so a replay of the same request can answer
 * with the existing `{ bookingId, checkoutUrl }` without calling the provider
 * again. No refund bookkeeping columns are added: `status = 'FAILED' AND
 * payment_ref IS NOT NULL` means a refund is still owed, `status = 'REFUNDED'`
 * means it completed.
 *
 * `down` drops only what `up` added: `processed_webhooks` has no foreign keys,
 * so dropping it is order-independent w.r.t. the existing schema.
 */

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE processed_webhooks (
      event_id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    ALTER TABLE bookings ADD COLUMN checkout_url TEXT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql("ALTER TABLE bookings DROP COLUMN IF EXISTS checkout_url;");
  pgm.sql("DROP TABLE IF EXISTS processed_webhooks;");
};
