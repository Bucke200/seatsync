# SeatSync

SeatSync is a full-stack event booking platform whose core guarantee is that no seat is ever sold twice, even under concurrent checkout load. This repository is a pnpm monorepo with an Express + TypeScript API (`apps/api`), a Next.js + TypeScript web app (`apps/web`) and shared zod schemas (`packages/shared`), backed by PostgreSQL 16 and Redis 7 via Docker Compose. Sprint 0 lays the full CI/CD foundation: a strict-TypeScript workspace, a fail-fast typed config loader, a `users` migration, a health endpoint with request-ID logging, integration tests against a real Postgres, and a GitHub Actions workflow that installs, lints, typechecks, migrates and tests every push and pull request.

## Prerequisites

- **Node.js 22** (`node --version`)
- **pnpm 10.8.1** via Corepack — run `corepack enable` once; the root `package.json` pins `packageManager: pnpm@10.8.1`, so the pnpm shim installs and uses that exact version.
- **Docker Desktop** with Compose v2 (`docker compose version`)

## Setup

From the repository root, in PowerShell:

```powershell
Copy-Item .env.example .env
pnpm install
docker compose up -d db redis
pnpm --filter api migrate up
```

## Standard commands

From the repository root:

```bash
pnpm install
docker compose up -d db redis
pnpm --filter api migrate up
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter api test -- <file-pattern>
```

Lines joined with `&&` (including the quality gate below) need PowerShell 7+, `cmd`, or Git Bash; on Windows PowerShell 5.1, run each command on its own line.

For example, `pnpm --filter api test -- health` runs only `apps/api/test/health.test.ts`.

## Full stack

```bash
docker compose up -d
```

This builds and starts `db`, `redis`, `api` (http://localhost:4000) and `web` (http://localhost:3000). The API container waits for healthy dependencies, runs migrations on boot, then starts the server. Stop everything with `docker compose down`.

## Acceptance checks

Health endpoint (database and Redis both up):

```bash
curl.exe -s localhost:4000/health
# {"db":"ok","redis":"ok"}
```

Degraded health endpoint (Redis stopped, Postgres still up):

```bash
docker compose stop redis
curl.exe -i localhost:4000/health
# HTTP/1.1 503 Service Unavailable
# {"db":"ok","redis":"error"}
# X-Request-Id: <uuid>
docker compose start redis
```

Migrations in both directions:

```bash
pnpm --filter api migrate up
pnpm --filter api migrate down
pnpm --filter api migrate up
```

Quality gate (lint, strict typecheck and the Jest + Supertest integration suite, which runs against the compose Postgres):

```bash
pnpm lint && pnpm typecheck && pnpm test
```

## Sprint 1 — Auth, roles and events

Sprint 1 adds accounts and event management on top of the Sprint 0 foundation:

- **Auth:** `POST /auth/signup`, `/auth/login`, `/auth/refresh` and `/auth/logout`. Passwords are hashed with argon2; access tokens are JWTs valid for `ACCESS_TOKEN_TTL_SECONDS`; the refresh token is an httpOnly, Secure, SameSite=Strict `refresh_token` cookie, stored in `refresh_tokens` only as a SHA-256 hash so logout can revoke it.
- **Authorisation:** `requireAuth` and `requireRole` middleware, plus organizer ownership checks on every event write. An attendee on an organizer route gets `403`, and organizer A cannot edit organizer B's event.
- **Events:** `POST /events` inserts the event and all of its seats in one Postgres transaction; `PATCH /events/:id`, `POST /events/:id/publish` and `POST /events/:id/unpublish` are organizer-only; `GET /events` is cursor-paginated on `(starts_at, id)` and returns published events only; `GET /events/:id` returns the event plus every seat with its status.
- **API docs:** an OpenAPI 3 document generated from the shared zod schemas is served as JSON at `/docs.json`, with Swagger UI at http://localhost:4000/docs.
- **Web:** `/signup`, `/login`, `/events`, `/events/[id]` (static seat grid with AVAILABLE/HELD/BOOKED badges) and `/organizer/events/new`, calling the API through the Next.js `/api/*` proxy at http://localhost:3000.

Try the full flow:

```bash
docker compose up -d
```

Open http://localhost:3000/signup, register as an **Organizer**, create an event with a seat layout, publish it, then browse http://localhost:3000/events. Registering as an **Attendee** and opening an event shows its seat grid. The same endpoints are available from `curl.exe` against `http://localhost:4000`.

## Sprint 2 — Seat holds

Sprint 2 adds seat holds on top of the Sprint 1 event flow:

- **Lock-then-update:** `POST /events/:id/holds` runs Rule 1 in one Postgres transaction: it locks the requested seats in deterministic ID order (`ORDER BY id FOR UPDATE`), then conditionally updates only rows that are `AVAILABLE` or whose hold has expired. If fewer rows come back than requested, the transaction rolls back and returns `409 SEATS_UNAVAILABLE` with `details.seatIds`; any number of concurrent requests for the same seat therefore produce exactly one hold.
- **Endpoints:** `POST /events/:id/holds` requires a Bearer token, a published event and an `Idempotency-Key` header; its body is `{ seatIds }` (1 to `MAX_SEATS_PER_HOLD`, default 6) and it returns `201 { holdId, seatIds, heldUntil }`, where the hold lasts `HOLD_TTL_SECONDS` (default 600). `DELETE /holds/:id` is holder-only and returns `204` after setting the seats back to `AVAILABLE`.
- **Validation:** `seatIds` must be unique UUIDs; empty, duplicate or malformed arrays return `422 VALIDATION_ERROR`, more than the maximum returns `422 TOO_MANY_SEATS`, and unknown or foreign seats return `409 SEATS_UNAVAILABLE`. A second active hold by the same user for the same event returns `409 SEATS_UNAVAILABLE` with the seats already held, and a missing or draft event returns `404 EVENT_NOT_FOUND`.
- **Idempotency:** the same key with the same body and user replays the stored `201` or `409` verbatim and creates one hold; the same key with a different body or from a different user returns `422`, and a missing or blank header returns `400`. Keys are claimed with `INSERT ... ON CONFLICT DO NOTHING` and then read under `FOR UPDATE`, never check-then-insert.
- **Sweeper:** `expireHolds` runs every `SWEEPER_INTERVAL_SECONDS` (default 30), selects expired holds with `ORDER BY id FOR UPDATE SKIP LOCKED` so it never blocks or deadlocks against the hold or confirm paths, clears the hold columns with `version = version + 1`, and prunes `idempotency_keys` (and `processed_webhooks` once Sprint 3 creates it) older than `RETENTION_DAYS` (default 30).
- **Expired-hold reads:** seat reads, including `GET /events/:id`, treat a `HELD` seat whose `held_until` has passed as `AVAILABLE` using the database clock, so an expired hold never looks taken before the sweeper clears it.
- **Tests:** six acceptance suites cover the race (200 concurrent holds on one seat → one `201`, 199×`409`, exactly one `HELD` row), overlapping holds, expiry including one sweeper run, idempotency, the Rule 3 `23505` backstop for confirmed bookings and `seatEvents` emission (nothing on rollback, once after `COMMIT`, per-seat versions).
- **Web:** `/events/[id]` lets a signed-in attendee select seats, hold them and count down to `heldUntil`; Release returns them immediately, and a `409` lists the seats that were taken.

Try it: open http://localhost:3000/events as an attendee, choose a published event and select up to six seats — **Hold seats** starts the countdown and **Release** returns them immediately.

## Sprint 3 — Payments and bookings

Sprint 3 turns a paid hold into a booking exactly once and gives every failure a defined state:

- **Checkout:** `POST /holds/:id/checkout` (holder only) creates a `PENDING` booking bound to the hold (unique `bookings.hold_id`) plus its `PENDING` `booking_seats`, sets `amount_paise` to the sum of the held seats' `price_paise`, passes `{ bookingId, holdId }` to the provider as checkout metadata, stores `checkout_url` and returns `{ bookingId, checkoutUrl }`. A second checkout for the same hold replays the stored response instead of hitting the unique constraint.
- **Providers:** `PAYMENT_PROVIDER` selects the implementation. `fake` is the default and the provider every automated test uses: deterministic, offline, HMAC-signed webhooks, with inspectable refund calls and one-shot refund/post-dedupe failure seams. `razorpay` uses Payment Links and verifies `X-Razorpay-Signature` with a timing-safe HMAC; `stripe` is not implemented. Each provider normalizes its events to `{ eventId, type: payment_succeeded | checkout_expired, bookingId, paymentRef }`.
- **Webhook dedupe (Rule 4):** `POST /webhooks/:provider` reads the exact raw body and verifies the signature before any database work, so a bad signature is `400` with zero writes. The transaction inserts the provider `event_id` into `processed_webhooks` with `ON CONFLICT DO NOTHING`; a replay commits and returns `200` without touching dedupe rows, bookings or seats again.
- **Confirm or release (Rule 2):** `payment_succeeded` locks the booking `FOR UPDATE`, then pre-locks the hold's seats in ID order. When every seat is still `HELD` under that hold, they all become `BOOKED` (clearing `held_until`, bumping `version`) and the booking plus its `booking_seats` become `CONFIRMED`. On a shortfall, only seats still bound to that hold are released and the booking becomes `FAILED`, so a seat another user has since re-held and paid for is never touched. `checkout_expired` releases the hold's still-`HELD` seats and fails a still-`PENDING` booking. Per-seat `seatEvents` emit only after `COMMIT`.
- **Refunds:** a `FAILED` booking with a `payment_ref` is refundable. The first attempt runs after `COMMIT`, never inside the webhook transaction; the `retryRefunds` job repeats it every `SWEEPER_INTERVAL_SECONDS`, claiming rows with `FOR UPDATE SKIP LOCKED`, until the booking and its `booking_seats` reach `REFUNDED`. A failing provider call leaves the booking `FAILED` for the next run and never changes the webhook's `200`.
- **Reads:** `GET /bookings/:id` is owner-only (`404 BOOKING_NOT_FOUND` for a missing booking, `403 FORBIDDEN` for someone else's) and `GET /me/bookings` lists the caller's bookings newest first with the event and seat count.
- **Tests:** seven acceptance suites under `apps/api/test/payments/` run against real Postgres with the fake provider: webhook replay (five deliveries, one confirmation), two events for one payment, late payment (A is refunded while B keeps the seat), bad signature, post-dedupe rollback followed by redelivery, refund retry, and partial loss with the Rule 3 invariant queries.
- **Web:** the hold banner on `/events/[id]` gains a **Pay** button that starts checkout and redirects to the provider URL (the fake provider returns the same-origin `/bookings/{bookingId}?fakeCheckout=1`). `/bookings/[id]` polls `GET /bookings/:id` every two seconds until the status is `CONFIRMED`, `FAILED` or `REFUNDED`, and `/me/bookings` lists the caller's bookings.

To use Razorpay, set `PAYMENT_PROVIDER=razorpay` together with `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` (the config fails fast if either is missing) and keep `PAYMENT_WEBHOOK_SECRET` set to the secret configured in the Razorpay dashboard. The automated suites always force `PAYMENT_PROVIDER=fake`, so CI needs no sandbox keys.

**Blocked — Human:** in the Razorpay sandbox, pay with a test card and then resend the same webhook event from the Razorpay CLI or dashboard; the booking must not change. This live card + resend check is still pending real sandbox keys.

## CI

`.github/workflows/ci.yml` runs on every push (all branches) and on pull requests. A single Ubuntu job uses Node.js 22 and pnpm 10.8.1, with `postgres:16` and `redis:7` service containers, then runs `pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm --filter api migrate up`, `pnpm --filter api migrate down`, `pnpm --filter api migrate up` and `pnpm test`. CI uses the standard Postgres port 5432 because the hosted runner is clean; local development uses 5434 (see below).

## Windows notes

- Create the local env file with `Copy-Item .env.example .env`.
- Use `curl.exe`, not `curl`: in Windows PowerShell, `curl` is an alias for `Invoke-WebRequest` and does not accept these flags.
- The compose `db` service is published on host port **5434**, not 5432, so it cannot clash with a local PostgreSQL already on 5432 (or 5433). The `POSTGRES_*` values and `DATABASE_URL` in `.env.example` and `.env` must stay in sync with that port; the API container itself talks to `db:5432` internally.
- Windows PowerShell 5.1 does not support `&&`; run the commands separately or use PowerShell 7+.
