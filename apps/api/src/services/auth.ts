import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LoginRequest, SignupRequest, UserRole } from "@seatsync/shared";
import { hash as hashPassword, verify as verifyPassword } from "argon2";
import jwt from "jsonwebtoken";
import type { Pool } from "pg";
import type { Config } from "../config";
import {
  findRefreshTokenByHash,
  insertRefreshToken,
  revokeAllUserRefreshTokens,
  revokeRefreshTokenByHash,
} from "../db/refreshTokens";
import { createUser, findUserByEmail, type UserRecord } from "../db/users";
import { ApiError } from "../middleware/errors";

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
}

export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  /** Raw token for the cookie; only its SHA-256 hash is stored in Postgres. */
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}

export interface AuthService {
  signup(input: SignupRequest): Promise<AuthSession>;
  login(input: LoginRequest): Promise<AuthSession>;
  refresh(refreshToken: string | undefined): Promise<AuthSession>;
  logout(refreshToken: string | undefined, userId: string): Promise<void>;
}

const REFRESH_TOKEN_BYTES = 32;

function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString("hex");
}

/** The database only ever sees the hash, never the cookie value itself. */
function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function refreshTokenExpiry(config: Config): Date {
  return new Date(Date.now() + config.REFRESH_TOKEN_TTL_SECONDS * 1000);
}

function toAuthUser(user: UserRecord): AuthUser {
  return { id: user.id, email: user.email, role: user.role };
}

function signAccessToken(config: Config, user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, role: user.role, jti: randomUUID() },
    config.JWT_SECRET,
    { expiresIn: config.ACCESS_TOKEN_TTL_SECONDS },
  );
}

async function issueSession(pool: Pool, config: Config, user: UserRecord): Promise<AuthSession> {
  const authUser = toAuthUser(user);
  const refreshToken = generateRefreshToken();
  const refreshTokenExpiresAt = refreshTokenExpiry(config);

  await insertRefreshToken(pool, {
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: refreshTokenExpiresAt,
  });

  return {
    user: authUser,
    accessToken: signAccessToken(config, authUser),
    refreshToken,
    refreshTokenExpiresAt,
  };
}

export function createAuthService(pool: Pool, config: Config): AuthService {
  return {
    async signup(input: SignupRequest): Promise<AuthSession> {
      const passwordHash = await hashPassword(input.password);
      const user = await createUser(pool, {
        email: input.email,
        passwordHash,
        role: input.role,
      });

      return issueSession(pool, config, user);
    },

    async login(input: LoginRequest): Promise<AuthSession> {
      const user = await findUserByEmail(pool, input.email);
      const passwordMatches =
        user !== null && (await verifyPassword(user.passwordHash, input.password));

      if (user === null || !passwordMatches) {
        throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password");
      }

      return issueSession(pool, config, user);
    },

    async refresh(refreshToken: string | undefined): Promise<AuthSession> {
      if (refreshToken === undefined) {
        throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is missing or invalid");
      }

      const currentHash = hashRefreshToken(refreshToken);
      const nextToken = generateRefreshToken();
      const nextExpiry = refreshTokenExpiry(config);

      const client = await pool.connect();
      let user: AuthUser | null = null;
      let transactionOpen = false;

      try {
        await client.query("BEGIN");
        transactionOpen = true;

        const stored = await findRefreshTokenByHash(client, currentHash);

        if (
          stored === null ||
          stored.revokedAt !== null ||
          stored.expiresAt.getTime() <= Date.now()
        ) {
          throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
        }

        await revokeRefreshTokenByHash(client, currentHash);
        await insertRefreshToken(client, {
          userId: stored.userId,
          tokenHash: hashRefreshToken(nextToken),
          expiresAt: nextExpiry,
        });
        await client.query("COMMIT");
        transactionOpen = false;

        user = { id: stored.userId, email: stored.userEmail, role: stored.userRole };
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK");
        }

        throw error;
      } finally {
        client.release();
      }

      if (user === null) {
        throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired");
      }

      return {
        user,
        accessToken: signAccessToken(config, user),
        refreshToken: nextToken,
        refreshTokenExpiresAt: nextExpiry,
      };
    },

    async logout(refreshToken: string | undefined, userId: string): Promise<void> {
      const client = await pool.connect();
      let transactionOpen = false;

      try {
        await client.query("BEGIN");
        transactionOpen = true;

        if (refreshToken !== undefined) {
          await revokeRefreshTokenByHash(client, hashRefreshToken(refreshToken));
        }

        await revokeAllUserRefreshTokens(client, userId);
        await client.query("COMMIT");
        transactionOpen = false;
      } catch (error) {
        if (transactionOpen) {
          await client.query("ROLLBACK");
        }

        throw error;
      } finally {
        client.release();
      }
    },
  };
}
