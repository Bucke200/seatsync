import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import type { Pool, QueryResultRow } from "pg";
import { loadConfig, type Config } from "../config";
import { createEventWithSeats, setEventStatus } from "../db/events";
import { createPool } from "../db/pool";
import { signAccessToken } from "../services/auth";

/**
 * Sprint 5 load-test seed (`pnpm --filter api seed:load`, D36).
 *
 * Creates ONE published 50-seat event and a pool of 200 attendee accounts in
 * the database from the host `.env` (the dev compose Postgres on :5434), then
 * writes `load/users.json` for the k6 scripts. Tokens are signed directly with
 * `signAccessToken` (D11): the users are never logged in, so their password
 * hash is the constant placeholder below and argon2 never runs. That keeps the
 * seed to two INSERT statements plus the event/seat transaction.
 *
 * Re-running the script is idempotent-enough: every run creates a NEW event
 * and a NEW attendee pool (emails carry the millisecond timestamp), and
 * overwrites `load/users.json`. Old load events/users are left in place and
 * are harmless; truncate the dev database when they pile up.
 *
 * ACCESS TOKEN TTL: every token expires after `ACCESS_TOKEN_TTL_SECONDS`
 * (default 900 s = 15 min). All scenarios that consume the same users.json
 * must finish (or re-seed) inside that window.
 */

const ATTENDEE_COUNT = 200;
const SEAT_ROWS = 5;
const SEATS_PER_ROW = 10;
const SEAT_COUNT = SEAT_ROWS * SEATS_PER_ROW;
const PRICE_PAISE = 100_000;

/**
 * D11: users are never authenticated with a password, so any non-empty string
 * satisfies `password_hash NOT NULL` without paying for argon2 hashing.
 */
const PLACEHOLDER_PASSWORD_HASH = "load-test-placeholder";

interface InsertedUserRow extends QueryResultRow {
  id: string;
  email: string;
}

interface SeatIdRow extends QueryResultRow {
  id: string;
}

/** Walk up from the package directory (pnpm runs scripts there) to the repo root. */
function findRepoRoot(start: string): string {
  let current = resolve(start);

  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }

    const parent = dirname(current);

    if (parent === current) {
      return resolve(start);
    }

    current = parent;
  }
}

async function insertOrganizer(pool: Pool, timestamp: number): Promise<string> {
  const result = await pool.query<InsertedUserRow>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ($1, $2, 'ORGANIZER')
     RETURNING id`,
    [`load-organizer-${timestamp}@load.local`, PLACEHOLDER_PASSWORD_HASH],
  );
  const id = result.rows[0]?.id;

  if (id === undefined) {
    throw new Error("failed to insert the load organizer");
  }

  return id;
}

async function insertAttendees(
  pool: Pool,
  config: Config,
  timestamp: number,
): Promise<Array<{ email: string; userId: string; token: string }>> {
  const emails: string[] = [];
  const placeholders: string[] = [];
  const values: string[] = [];

  // D11: ONE INSERT for every attendee. Every value is bound (3 parameters per
  // tuple), including the constant placeholder hash and role: no SQL string
  // interpolation of data, constants or otherwise.
  for (let index = 0; index < ATTENDEE_COUNT; index += 1) {
    const email = `load-vu-${index}-${timestamp}@load.local`;
    const emailParam = index * 3 + 1;

    emails.push(email);
    placeholders.push(`($${emailParam}, $${emailParam + 1}, $${emailParam + 2})`);
    values.push(email, PLACEHOLDER_PASSWORD_HASH, "ATTENDEE");
  }

  const inserted = await pool.query<InsertedUserRow>(
    `INSERT INTO users (email, password_hash, role)
     VALUES ${placeholders.join(", ")}
     RETURNING id, email`,
    values,
  );

  if (inserted.rows.length !== ATTENDEE_COUNT) {
    throw new Error(
      `expected to insert ${ATTENDEE_COUNT} attendees, inserted ${inserted.rows.length}`,
    );
  }

  const idByEmail = new Map(inserted.rows.map((row) => [row.email, row.id] as const));

  return emails.map((email) => {
    const userId = idByEmail.get(email);

    if (userId === undefined) {
      throw new Error(`seeded attendee ${email} is missing its id`);
    }

    return {
      email,
      userId,
      token: signAccessToken(config, { id: userId, email, role: "ATTENDEE" }),
    };
  });
}

async function seed(pool: Pool, config: Config, repoRoot: string): Promise<void> {
  const timestamp = Date.now();
  const eventTitle = `Load Test ${timestamp}`;
  const organizerId = await insertOrganizer(pool, timestamp);

  // Same pattern as the events service: event + all 50 seats commit together
  // or not at all.
  const event = await createEventWithSeats(pool, {
    organizerId,
    title: eventTitle,
    venue: "Load Arena",
    startsAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    sections: [
      {
        name: "Floor",
        rows: SEAT_ROWS,
        seatsPerRow: SEATS_PER_ROW,
        pricePaise: PRICE_PAISE,
      },
    ],
  });
  await setEventStatus(pool, event.id, "PUBLISHED");

  const seatResult = await pool.query<SeatIdRow>(
    `SELECT id
       FROM seats
      WHERE event_id = $1
      ORDER BY section, row_label, number`,
    [event.id],
  );
  const seats = seatResult.rows.map((row) => row.id);

  if (seats.length !== SEAT_COUNT) {
    throw new Error(`expected ${SEAT_COUNT} seats, found ${seats.length}`);
  }

  const users = await insertAttendees(pool, config, timestamp);
  const outputPath = join(repoRoot, "load", "users.json");

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${JSON.stringify(
      {
        eventId: event.id,
        eventTitle,
        seats,
        users,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const ttlMinutes = Math.floor(config.ACCESS_TOKEN_TTL_SECONDS / 60);

  console.log("seed:load complete");
  console.log(`  event:    ${eventTitle} (${event.id})`);
  console.log(`  seats:    ${seats.length}`);
  console.log(`  users:    ${users.length} attendees (+1 organizer)`);
  console.log(`  output:   ${outputPath}`);
  console.log(
    `  tokens:   signed for ${ttlMinutes} min; run the scenarios (or re-seed) inside that window`,
  );
}

async function main(): Promise<void> {
  const repoRoot = findRepoRoot(process.cwd());
  // `tsx src/scripts/seedLoad.ts` does not load .env itself, and the file lives
  // at the repo root rather than in apps/api.
  loadDotenv({ path: join(repoRoot, ".env") });

  const config = loadConfig();
  const pool = createPool(config);

  try {
    await seed(pool, config, repoRoot);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("seed:load failed", error);
  process.exitCode = 1;
});
