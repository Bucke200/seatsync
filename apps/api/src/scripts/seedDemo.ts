import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { UserRole } from "@seatsync/shared";
import { hash as hashPassword } from "argon2";
import { config as loadDotenv } from "dotenv";
import type { Pool, QueryResultRow } from "pg";
import { loadConfig } from "../config";
import { createEventWithSeats, setEventStatus } from "../db/events";
import { createPool } from "../db/pool";
import { createUser, findUserByEmail, type UserRecord } from "../db/users";
import { ApiError } from "../middleware/errors";

/**
 * Sprint 6 public-demo seed (`pnpm --filter api seed:demo`, D42).
 *
 * Unlike `seedLoad.ts` (placeholder hashes, pre-signed tokens), the two demo
 * accounts below must be able to `POST /auth/login`, so their passwords are
 * hashed with argon2 for real. They are throwaway demo-only credentials,
 * intentionally published in this script and the README; never reuse a real
 * password here.
 *
 * Safe to re-run against any DATABASE_URL:
 * - `createUser` answers 409 EMAIL_TAKEN for an existing account; the script
 *   then reuses that row instead of failing.
 * - the demo event is looked up by (organizer, exact title) and reused; it is
 *   forced back to PUBLISHED so the public demo stays visible.
 *
 * Re-run choice (documented per the plan): existing seats are NEVER reset.
 * A non-AVAILABLE seat may belong to a live hold or a confirmed booking, and
 * overwriting it would corrupt real state; expired holds are already released
 * by the sweeper (and `GET /events/:id` reports expired holds as AVAILABLE).
 * The summary prints the current counts by status instead.
 */

interface DemoAccount {
  email: string;
  password: string;
  role: UserRole;
}

/** Public by design: shown in this script, the README and the demo page. */
const DEMO_ORGANIZER: DemoAccount = {
  email: "demo-organizer@seatsync.demo",
  password: "DemoOrganizer!2026",
  role: "ORGANIZER",
};

const DEMO_ATTENDEE: DemoAccount = {
  email: "demo-attendee@seatsync.demo",
  password: "DemoAttendee!2026",
  role: "ATTENDEE",
};

const DEMO_EVENT_TITLE = "SeatSync Live Demo";
const DEMO_EVENT_VENUE = "Demo Arena Online";
const DEMO_EVENT_STARTS_IN_DAYS = 14;
const DEMO_SECTION_NAMES = ["Orchestra", "Mezzanine", "Balcony", "Gallery"];
const DEMO_SECTION_ROWS = 4;
const DEMO_SEATS_PER_ROW = 10;
const DEMO_PRICE_PAISE = 50_000;
const DEMO_SEAT_COUNT =
  DEMO_SECTION_NAMES.length * DEMO_SECTION_ROWS * DEMO_SEATS_PER_ROW;

interface DemoEventRow extends QueryResultRow {
  id: string;
}

interface SeatStatusCountRow extends QueryResultRow {
  status: string;
  count: number;
}

interface EnsuredUser {
  user: UserRecord;
  created: boolean;
}

interface EnsuredEvent {
  eventId: string;
  created: boolean;
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

function isEmailTaken(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.statusCode === 409 &&
    error.code === "EMAIL_TAKEN"
  );
}

/**
 * Reuse the account when it already exists. The password is still hashed on
 * every run (two argon2 hashes are negligible) because the same code path must
 * also seed a fresh database; only the INSERT is skipped on 409.
 */
async function ensureUser(pool: Pool, account: DemoAccount): Promise<EnsuredUser> {
  const passwordHash = await hashPassword(account.password);

  try {
    const user = await createUser(pool, {
      email: account.email,
      passwordHash,
      role: account.role,
    });

    return { user, created: true };
  } catch (error) {
    if (!isEmailTaken(error)) {
      throw error;
    }

    const existing = await findUserByEmail(pool, account.email);

    if (existing === null) {
      throw new Error(
        `user ${account.email} reported EMAIL_TAKEN but could not be read back`,
      );
    }

    return { user: existing, created: false };
  }
}

/**
 * One demo event per organizer. `events.title` is not unique, so the oldest
 * exact-title row wins if an older seed/run ever produced duplicates.
 */
async function findDemoEvent(pool: Pool, organizerId: string): Promise<string | null> {
  const result = await pool.query<DemoEventRow>(
    `SELECT id
       FROM events
      WHERE organizer_id = $1 AND title = $2
      ORDER BY created_at ASC
      LIMIT 1`,
    [organizerId, DEMO_EVENT_TITLE],
  );

  return result.rows[0]?.id ?? null;
}

async function ensureDemoEvent(pool: Pool, organizerId: string): Promise<EnsuredEvent> {
  const existingId = await findDemoEvent(pool, organizerId);

  if (existingId !== null) {
    // Keep the public demo reachable even if a previous run (or an organizer)
    // unpublish/edited it. Seats are deliberately left untouched.
    const republished = await setEventStatus(pool, existingId, "PUBLISHED");

    if (republished === null) {
      throw new Error(`demo event ${existingId} disappeared while publishing`);
    }

    return { eventId: existingId, created: false };
  }

  // Same atomic event+seats insert the events service uses: either all 160
  // seats exist or no event row does.
  const event = await createEventWithSeats(pool, {
    organizerId,
    title: DEMO_EVENT_TITLE,
    venue: DEMO_EVENT_VENUE,
    startsAt: new Date(
      Date.now() + DEMO_EVENT_STARTS_IN_DAYS * 24 * 60 * 60 * 1000,
    ),
    sections: DEMO_SECTION_NAMES.map((name) => ({
      name,
      rows: DEMO_SECTION_ROWS,
      seatsPerRow: DEMO_SEATS_PER_ROW,
      pricePaise: DEMO_PRICE_PAISE,
    })),
  });
  await setEventStatus(pool, event.id, "PUBLISHED");

  const seatCount = await countSeats(pool, event.id);

  if (seatCount.total !== DEMO_SEAT_COUNT) {
    throw new Error(
      `expected ${DEMO_SEAT_COUNT} demo seats, found ${seatCount.total}`,
    );
  }

  return { eventId: event.id, created: true };
}

async function countSeats(
  pool: Pool,
  eventId: string,
): Promise<{ total: number; byStatus: Map<string, number> }> {
  const result = await pool.query<SeatStatusCountRow>(
    `SELECT status, count(*)::int AS count
       FROM seats
      WHERE event_id = $1
      GROUP BY status
      ORDER BY status ASC`,
    [eventId],
  );
  const byStatus = new Map(
    result.rows.map((row) => [row.status, row.count] as const),
  );
  const total = result.rows.reduce((sum, row) => sum + row.count, 0);

  return { total, byStatus };
}

function formatStatusCounts(byStatus: Map<string, number>): string {
  const statuses = ["AVAILABLE", "HELD", "BOOKED"];
  const known = statuses.map(
    (status) => `${status} ${byStatus.get(status) ?? 0}`,
  );
  const extra = [...byStatus.keys()]
    .filter((status) => !statuses.includes(status))
    .sort()
    .map((status) => `${status} ${byStatus.get(status) ?? 0}`);

  return [...known, ...extra].join(", ");
}

async function seed(pool: Pool): Promise<void> {
  const organizer = await ensureUser(pool, DEMO_ORGANIZER);
  const attendee = await ensureUser(pool, DEMO_ATTENDEE);
  const event = await ensureDemoEvent(pool, organizer.user.id);
  const seats = await countSeats(pool, event.eventId);
  const accountState = (ensured: EnsuredUser): string =>
    ensured.created ? "created" : "reused";

  console.log("seed:demo complete");
  console.log(
    `  organizer: ${DEMO_ORGANIZER.email} / ${DEMO_ORGANIZER.password} (${accountState(organizer)})`,
  );
  console.log(
    `  attendee:  ${DEMO_ATTENDEE.email} / ${DEMO_ATTENDEE.password} (${accountState(attendee)})`,
  );
  console.log(
    `  event:     ${DEMO_EVENT_TITLE} (${event.eventId}) [${event.created ? "created" : "reused"}, PUBLISHED]`,
  );
  console.log(`  venue:     ${DEMO_EVENT_VENUE}, starts in ${DEMO_EVENT_STARTS_IN_DAYS} days (new events only)`);
  console.log(
    `  seats:     ${seats.total} total - ${formatStatusCounts(seats.byStatus)}`,
  );
  console.log(
    "  note:      existing seats are never reset (live holds/bookings stay intact)",
  );
}

async function main(): Promise<void> {
  const repoRoot = findRepoRoot(process.cwd());
  // `tsx src/scripts/seedDemo.ts` does not load .env itself, and the file lives
  // at the repo root rather than in apps/api.
  loadDotenv({ path: join(repoRoot, ".env") });

  const config = loadConfig();
  const pool = createPool(config);

  try {
    await seed(pool);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("seed:demo failed", error);
  process.exitCode = 1;
});
