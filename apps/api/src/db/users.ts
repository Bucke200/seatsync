import type { UserRole } from "@seatsync/shared";
import type { Pool, QueryResultRow } from "pg";
import { ApiError } from "../middleware/errors";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  role: UserRole;
}

interface UserRow extends QueryResultRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
}

const USER_COLUMNS = "id, email, password_hash, role, created_at";

function toUserRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at,
  };
}

function hasPgErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}

/** Insert a user, mapping the `users.email` unique violation to 409. */
export async function createUser(pool: Pool, input: CreateUserInput): Promise<UserRecord> {
  try {
    const result = await pool.query<UserRow>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING ${USER_COLUMNS}`,
      [input.email, input.passwordHash, input.role],
    );

    return toUserRecord(result.rows[0]);
  } catch (error) {
    if (hasPgErrorCode(error, "23505")) {
      throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists");
    }

    throw error;
  }
}

export async function findUserByEmail(pool: Pool, email: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM users WHERE email = $1`,
    [email],
  );
  const row = result.rows[0];

  return row === undefined ? null : toUserRecord(row);
}

export async function findUserById(pool: Pool, id: string): Promise<UserRecord | null> {
  const result = await pool.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
    id,
  ]);
  const row = result.rows[0];

  return row === undefined ? null : toUserRecord(row);
}
