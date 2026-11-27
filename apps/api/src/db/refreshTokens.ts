import type { UserRole } from "@seatsync/shared";
import type { Pool, PoolClient, QueryResultRow } from "pg";

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  userEmail: string;
  userRole: UserRole;
}

export interface InsertRefreshTokenInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
}

interface RefreshTokenRow extends QueryResultRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  user_email: string;
  user_role: UserRole;
}

/** Both `Pool` and `PoolClient` satisfy the query surface these helpers need. */
type QueryExecutor = Pool | PoolClient;

export async function insertRefreshToken(
  client: QueryExecutor,
  input: InsertRefreshTokenInput,
): Promise<void> {
  await client.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [input.userId, input.tokenHash, input.expiresAt],
  );
}

/**
 * Look up a refresh token by its SHA-256 hash and join the owning user so the
 * refresh flow can mint an access token without a second round trip.
 */
export async function findRefreshTokenByHash(
  client: QueryExecutor,
  tokenHash: string,
): Promise<RefreshTokenRecord | null> {
  const result = await client.query<RefreshTokenRow>(
    `SELECT rt.id,
            rt.user_id,
            rt.token_hash,
            rt.expires_at,
            rt.revoked_at,
            u.email AS user_email,
            u.role AS user_role
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
      WHERE rt.token_hash = $1`,
    [tokenHash],
  );
  const row = result.rows[0];

  if (row === undefined) {
    return null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    userEmail: row.user_email,
    userRole: row.user_role,
  };
}

export async function revokeRefreshTokenByHash(
  client: QueryExecutor,
  tokenHash: string,
): Promise<void> {
  await client.query(
    `UPDATE refresh_tokens
        SET revoked_at = now()
      WHERE token_hash = $1
        AND revoked_at IS NULL`,
    [tokenHash],
  );
}

export async function revokeAllUserRefreshTokens(
  client: QueryExecutor,
  userId: string,
): Promise<void> {
  await client.query(
    `UPDATE refresh_tokens
        SET revoked_at = now()
      WHERE user_id = $1
        AND revoked_at IS NULL`,
    [userId],
  );
}
