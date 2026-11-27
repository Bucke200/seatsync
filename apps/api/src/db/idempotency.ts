import type { PoolClient, QueryResultRow } from "pg";

/**
 * Hand-written SQL for `idempotency_keys` (Sprint 2, D2/D13).
 *
 * Both helpers run inside the caller's open transaction. The same-key
 * `SELECT ... FOR UPDATE` lock must stay held until the hold result is stored
 * and committed, so every helper takes a `PoolClient` and manages no
 * transaction state of its own.
 */

export interface IdempotencyKeyInput {
  key: string;
  userId: string;
  bodyHash: string;
}

export interface IdempotencyKeyRecord {
  key: string;
  userId: string;
  bodyHash: string;
  /** 0 while the caller's transaction is still working; 201/409 once stored. */
  statusCode: number;
  /** Parsed JSONB response, or `null` when no response has been stored yet. */
  response: unknown;
  createdAt: Date;
}

export interface ClaimIdempotencyKeyResult {
  /** `claimed` when this transaction inserted the row; `existing` otherwise. */
  outcome: "claimed" | "existing";
  row: IdempotencyKeyRecord;
  /** The stored user id or body hash differs from the one presented now. */
  mismatch: boolean;
}

interface IdempotencyKeyRow extends QueryResultRow {
  key: string;
  user_id: string;
  body_hash: string;
  status_code: number;
  response: unknown;
  created_at: Date;
}

function toIdempotencyKeyRecord(row: IdempotencyKeyRow): IdempotencyKeyRecord {
  return {
    key: row.key,
    userId: row.user_id,
    bodyHash: row.body_hash,
    statusCode: row.status_code,
    response: row.response,
    createdAt: row.created_at,
  };
}

/**
 * Atomically claim a key, then read it back under a row lock (D2/D13).
 *
 * `INSERT ... ON CONFLICT (key) DO NOTHING` followed by `SELECT ... FOR UPDATE`
 * never uses check-then-insert: two concurrent requests with the same key
 * serialize on the unique index / row lock, so exactly one inserts and both
 * observe the same row. Callers must decide what to do with `mismatch` and
 * with an existing row that already has a stored `response`.
 */
export async function claimIdempotencyKey(
  client: PoolClient,
  input: IdempotencyKeyInput,
): Promise<ClaimIdempotencyKeyResult> {
  const inserted = await client.query(
    `INSERT INTO idempotency_keys (key, user_id, body_hash, status_code)
     VALUES ($1, $2, $3, 0)
     ON CONFLICT (key) DO NOTHING`,
    [input.key, input.userId, input.bodyHash],
  );

  // The read is part of the claim: it either returns the row this transaction
  // just inserted or waits on the row lock of the transaction that owns the
  // key, then returns that transaction's committed row.
  const result = await client.query<IdempotencyKeyRow>(
    `SELECT key, user_id, body_hash, status_code, response, created_at
       FROM idempotency_keys
      WHERE key = $1
      FOR UPDATE`,
    [input.key],
  );
  const row = result.rows[0];

  if (row === undefined) {
    throw new Error(`Idempotency key ${input.key} disappeared after claim`);
  }

  return {
    outcome: inserted.rowCount === 1 ? "claimed" : "existing",
    row: toIdempotencyKeyRecord(row),
    mismatch: row.user_id !== input.userId || row.body_hash !== input.bodyHash,
  };
}

export interface StoreIdempotencyResponseInput {
  key: string;
  statusCode: number;
  /** Serialized verbatim as JSONB, so a replay returns the exact body. */
  response: unknown;
}

/**
 * Persist the status code and response body for a claimed key. Runs in the
 * caller's transaction, before its `COMMIT`, so the stored response and the
 * seat change it describes become visible atomically.
 */
export async function storeIdempotencyResponse(
  client: PoolClient,
  input: StoreIdempotencyResponseInput,
): Promise<void> {
  const result = await client.query(
    `UPDATE idempotency_keys
        SET status_code = $2, response = $3::jsonb
      WHERE key = $1`,
    [input.key, input.statusCode, JSON.stringify(input.response)],
  );

  if (result.rowCount !== 1) {
    throw new Error(`Idempotency key ${input.key} is missing while storing its response`);
  }
}
