# SeatSync — Project Plan & Sprint Breakdown

Nov 27, 2026 · @srinjay

## Overview

SeatSync is a full-stack event booking platform built around one guarantee: no seat is ever sold twice, even under heavy concurrent load. The work is split into 7 sprints. Each sprint is a self-contained task an agent can pick up: its dependencies, branch, files, tasks, acceptance checks and out-of-scope items are all spelled out.

Why it's on the resume: it backs up the TypeScript, Node.js, PostgreSQL and WebSocket skills that the dev resume lists but nothing currently shows. It also gives you concrete stories for SDE interviews: locking, isolation levels, idempotency, real-time fan-out and caching.

**The project is done when:**

- A k6 load test with hundreds of concurrent requests on the same seats produces zero double-bookings
- A payment that arrives after its hold expired is refunded automatically, and a test proves it
- The live seat map updates across browser tabs and across 2 API instances
- CI is green on every push, and the app is deployed with a public demo link and a README
- Every number in the resume bullets has been measured, not estimated

## Instructions for agents

Read this section and the Data model rules before starting any sprint. When this doc and your own judgement disagree, follow the doc. If something isn't covered, choose the simplest option that keeps every Data model rule true, and say so in your completion report.

**How to pick up a sprint**

1. Check that every sprint listed under "Depends on" is merged to `main`. If not, stop and report it.
2. Create the branch named in the sprint.
3. Do every task in the list. Don't add features that aren't listed, and don't touch anything under "Out of scope".
4. Make every acceptance check pass, locally and in CI.
5. Open a PR to `main` and write a completion report: each acceptance check with its command and result, any decision you made that the doc didn't specify, and any metrics measured (fill in the Metrics log).
6. Items marked **Human** need accounts, keys or judgement. List them in the report as blocked; don't work around them.

**Repository layout**

```text
apps/api/src/routes        HTTP handlers (thin: validate, call a service, respond)
apps/api/src/services      business logic
apps/api/src/db            all SQL, including every seat and booking query
apps/api/src/payments      PaymentProvider interface + stripe, razorpay, fake
apps/api/src/realtime      WebSocket server + Redis pub/sub
apps/api/src/jobs          background jobs (hold sweeper, refund retry)
apps/api/migrations        node-pg-migrate files
apps/api/test              Jest + Supertest integration tests
apps/web                   Next.js app
packages/shared            zod schemas and shared types
load                       k6 scripts and invariants.sql
scripts                    smoke test and seed scripts
```

**Standard commands**

```bash
pnpm install
docker compose up -d db redis
pnpm --filter api migrate up
pnpm lint && pnpm typecheck && pnpm test
pnpm --filter api test -- <file-pattern>
k6 run load/<scenario>.js
```

**Rules (MUST / MUST NOT)**

- MUST write every seat and booking query by hand in `apps/api/src/db`. MUST NOT use an ORM for them.
- MUST run seat, booking and webhook tests against the real Postgres. MUST NOT mock the database in those tests.
- MUST NOT make Redis required for correctness. If Redis is down, bookings still work.
- MUST store money as integer paise.
- MUST read every tunable value from the Config table below via environment variables. MUST NOT hard-code them.
- MUST NOT add microservices, Kubernetes, extra message brokers or extra databases.
- MUST NOT make tests wait on real time passing. To simulate an expired hold, set `held_until` in the past in the database.
- MUST keep TypeScript in `strict` mode with no `any` in `apps/api/src/db` or `apps/api/src/services`.

**Config**

| Variable | Default | Used for |
| --- | --- | --- |
| DATABASE\_URL | — | Postgres connection |
| REDIS\_URL | — | Pub/sub, rate limits, cache |
| DB\_POOL\_SIZE | 20 | Postgres pool size |
| JWT\_SECRET | — | Signing access tokens |
| ACCESS\_TOKEN\_TTL\_SECONDS | 900 | Access token lifetime |
| REFRESH\_TOKEN\_TTL\_SECONDS | 1209600 | Refresh token lifetime |
| HOLD\_TTL\_SECONDS | 600 | How long a seat hold lasts |
| SWEEPER\_INTERVAL\_SECONDS | 30 | How often expired holds are released |
| MAX\_SEATS\_PER\_HOLD | 6 | Seat limit per hold |
| PAYMENT\_PROVIDER | fake | `stripe`, `razorpay` or `fake` |
| PAYMENT\_WEBHOOK\_SECRET | — | Webhook signature verification |
| HOLDS\_RATE\_LIMIT\_PER\_MINUTE | 20 | Max POST /events/:id/holds per user per minute |
| CORS\_ORIGINS | http://localhost:3000 | Allowed web origins |
| LIVE\_UPDATE\_MAX\_MS | 1000 | Test threshold for live seat updates |
| RETENTION\_DAYS | 30 | Prune idempotency\_keys and processed\_webhooks rows older than this |

## Architecture and tech stack

&#91;embedded content: SeatSync architecture · 5 parts\]

Every booking decision is a conditional UPDATE in PostgreSQL. Redis only relays changes, so losing it pauses live updates without any risk of a double-booking.

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js + TypeScript, Tailwind | Shows React; seat map and dashboards |
| API | Node.js + Express (or NestJS), TypeScript, zod | Backs up the stack the resume lists |
| Database | PostgreSQL 16, raw SQL via `pg` + migrations | Locking and transactions written by hand |
| Real-time | `ws` or Socket.IO + Redis pub/sub | Fan-out across API replicas |
| Payments | Stripe or Razorpay, test mode | Webhooks, idempotency, refunds |
| Testing | Jest, Supertest, k6 | Integration, race and load tests |
| DevOps | Docker Compose, GitHub Actions, Render or Railway + Neon + Upstash | CI/CD and a live demo |

## Data model and correctness rules

PostgreSQL is the only place a booking is decided. Redis never decides anything, so if Redis fails, live updates stop but bookings stay correct.

| Table | Key columns | Purpose |
| --- | --- | --- |
| users | id, email (unique), password\_hash, role (ORGANIZER / ATTENDEE) | Accounts and roles |
| events | id, organizer\_id, title, venue, starts\_at, status (DRAFT / PUBLISHED) | What's on sale |
| seats | id, event\_id, section, row\_label, number, price\_paise, status (AVAILABLE / HELD / BOOKED), hold\_id, held\_by, held\_until, version | Source of truth for each seat |
| bookings | id, user\_id, event\_id, hold\_id (unique), status (PENDING / CONFIRMED / FAILED / REFUNDED), amount\_paise, payment\_ref | One checkout attempt |
| booking\_seats | booking\_id, seat\_id, status | Seats in a booking; carries the backstop index |
| processed\_webhooks | event\_id (PK), provider, received\_at | Webhook de-duplication and audit |
| idempotency\_keys | key (PK), user\_id, response, created\_at | Safe client retries on POST /events/:id/holds |

**Rule 1. A hold is a lock-then-update, all or nothing.** Inside one transaction, lock the target seats in deterministic ID order to avoid deadlocks on overlapping requests, then run the conditional UPDATE. Under READ COMMITTED, a concurrent request waits on the row lock, re-checks the WHERE clause, and gets 0 rows. If fewer rows come back than seats requested, roll back and return 409. (Map any residual 40P01 deadlock to a bounded retry of the whole transaction, then 409.)

```sql
-- 1. Lock in deterministic order
SELECT id FROM seats
WHERE event_id = $3 AND id = ANY($4)
ORDER BY id
FOR UPDATE;

-- 2. Conditional UPDATE
UPDATE seats
SET status = 'HELD', hold_id = $1, held_by = $2,
    held_until = now() + make_interval(secs => $5),  -- $5 = HOLD_TTL_SECONDS
    version = version + 1
WHERE event_id = $3 AND id = ANY($4)
  AND (status = 'AVAILABLE'
       OR (status = 'HELD' AND held_until < now()))
RETURNING id;
```

**Rule 2. Confirming a booking is an all-or-nothing state transition that can only succeed once.** Inside the webhook transaction (after the processed\_webhooks dedupe), lock the booking row and guard on it still being PENDING and bound to the hold:

```sql
SELECT status FROM bookings
WHERE id = $x AND hold_id = $1
FOR UPDATE;
```

If 0 rows come back, or `status <> 'PENDING'`, the booking is already CONFIRMED or FAILED (or the payload is mismatched): commit the transaction (persisting the processed\_webhooks row) and return 200. Do not roll back — that would discard the dedupe row and put the provider into a retry loop. One exception: if the booking is FAILED but the event carries a payment\_ref, store it on the booking in the same commit so the retryRefunds job refunds it (a payment that lands after `checkout_expired` must never be kept).

Otherwise, pre-lock all HELD seats for $1 in deterministic order (ORDER BY id FOR UPDATE). An expired hold that hasn't been claimed by another user or cleared by the expireHolds sweeper can still confirm; once either happens, fewer than $2 (the expected seat count, from booking\_seats) rows are locked.

If locked count === $2: run the confirm UPDATE (leaving hold\_id intact), then set the booking and its booking\_seats to CONFIRMED. If locked count < $2 (or the confirm returns < $2 rows): a seat was lost before or mid-flight. Release every seat still carrying hold\_id = $1 (HELD or BOOKED) back to AVAILABLE, clear hold\_id, held\_by and held\_until, increment version, and mark the booking and its booking\_seats FAILED in the same transaction. After COMMIT, trigger the refund and emit seatEvents for every released seat.

```sql
-- 1. Pre-lock in deterministic order
SELECT id FROM seats
WHERE hold_id = $1 AND status = 'HELD'
ORDER BY id
FOR UPDATE;

-- 2a. Happy path (only if step 1 returned $2 rows)
UPDATE seats
SET status = 'BOOKED', held_until = NULL, version = version + 1
WHERE hold_id = $1 AND status = 'HELD'
RETURNING id;

-- 2b. Shortfall path (if step 1 or 2a returned fewer than $2 rows)
UPDATE seats
SET status = 'AVAILABLE', hold_id = NULL, held_by = NULL, held_until = NULL,
    version = version + 1
WHERE hold_id = $1 AND status IN ('HELD', 'BOOKED')
RETURNING id;
```

**Rule 3. A unique index is the backstop.** Even if the application logic has a bug, the database refuses a second confirmed booking for the same seat. It is scoped to `CONFIRMED` so an abandoned PENDING checkout never blocks a new user's checkout on the same seat: during the hold phase the seats table already enforces single-holder exclusivity (one hold_id per seat), and Rule 2 only confirms seats that still carry the booking's hold.

```sql
CREATE UNIQUE INDEX one_confirmed_booking_per_seat
ON booking_seats (seat_id)
WHERE status = 'CONFIRMED';
```

**Rule 4. Webhooks are processed once, in the same transaction as the booking.** Verify the signature, then `INSERT INTO processed_webhooks … ON CONFLICT DO NOTHING`, then confirm. If anything fails, everything rolls back and the provider's retry is processed properly.

**Rule 5. Publish live updates only after COMMIT.** That way clients never see a seat change that was later rolled back.

**Rule 6. Store money as integer paise.** Never use floats for amounts.

**Rule 7. Every seat change increments `seats.version`.** It's done in the same UPDATE, so there's no extra lock. Live updates carry it, so clients can ignore stale messages. Don't keep a per-event counter: one shared row would serialize every hold for that event.

## Sprint dependencies

&#91;embedded content: Sprint dependencies · 7 sprints\]

A sprint can start only when every sprint it depends on is merged to `main`. Sprints 3 and 4 can go to two agents at the same time. Sprint 4 wires in booking events once Sprint 3 is merged. Sprint 2 is the core; review its PR most carefully.

## Sprint 0 — Foundation

**Goal:** a monorepo where one command boots the full stack and CI passes.

**Depends on:** nothing. **Branch:** `sprint-0-foundation`

**Tasks**

- [ ] pnpm workspace with `apps/api` (Express + TypeScript), `apps/web` (Next.js + TypeScript) and `packages/shared` (zod schemas and shared types)
- [ ] `docker-compose.yml` with services `db` (postgres:16), `redis` (redis:7), `api` (port 4000) and `web` (port 3000)
- [ ] `.env.example` listing every variable in the Config table, plus a typed config loader in `apps/api/src/config.ts` that fails fast on a missing variable
- [ ] node-pg-migrate set up in `apps/api/migrations`; the first migration creates `users` (id, email unique, password\_hash, role, created\_at)
- [ ] TypeScript `strict: true`, ESLint and Prettier; root scripts `lint`, `typecheck` and `test`
- [ ] Jest + Supertest in `apps/api/test`, running against the compose Postgres with a truncate-between-tests helper
- [ ] `GET /health`: 200 with `{"db":"ok","redis":"ok"}`, or 503 naming the failing dependency
- [ ] pino logging with a request ID on every log line, also returned in the `X-Request-Id` header
- [ ] `.github/workflows/ci.yml`: install, lint, typecheck, migrate, test, with Postgres and Redis service containers
- [ ] README: prerequisites and the standard commands

**Acceptance checks**

- `docker compose up -d && curl -s localhost:4000/health` returns `{"db":"ok","redis":"ok"}`
- `docker compose stop redis && curl -i localhost:4000/health` returns 503 and names redis
- `pnpm --filter api migrate up` then `pnpm --filter api migrate down` both exit 0
- `pnpm lint && pnpm typecheck && pnpm test` exits 0
- The CI workflow passes on the PR

**Out of scope:** auth, and any table other than `users`.

## Sprint 1 — Auth, roles and events

**Goal:** organizers create events with seat layouts; attendees browse published events.

**Depends on:** Sprint 0. **Branch:** `sprint-1-auth-events`

**Tasks**

- [ ] Routes `POST /auth/signup`, `POST /auth/login`, `POST /auth/refresh` and `POST /auth/logout`, with role `ORGANIZER` or `ATTENDEE` chosen at signup
- [ ] Passwords hashed with argon2. Access token: a JWT lasting `ACCESS_TOKEN_TTL_SECONDS`. Refresh token: an httpOnly, Secure, SameSite=Strict cookie, stored hashed in a `refresh_tokens` table so logout can revoke it.
- [ ] Middleware `requireAuth` and `requireRole(role)`, and an ownership check on every organizer write
- [ ] zod validation on every route; every error uses the shape `{ error: { code, message, details? } }`
- [ ] Migrations for `events` and `seats` (base columns plus `status` defaulting to `AVAILABLE`, and a unique constraint on `(event_id, section, row_label, number)`; the hold columns come in Sprint 2)
- [ ] `POST /events` with body `{ title, venue, startsAt, sections: [{ name, rows, seatsPerRow, pricePaise }] }`; insert the event and all its seats in one transaction
- [ ] `PATCH /events/:id`, `POST /events/:id/publish` and `POST /events/:id/unpublish` (organizer, owner only)
- [ ] `GET /events?cursor=&limit=`: published events only, cursor-paginated on `(starts_at, id)`
- [ ] `GET /events/:id`: the event plus every seat with its status
- [ ] OpenAPI spec generated from the zod schemas, with Swagger UI at `/docs`
- [ ] Web pages: `/login`, `/signup`, `/events`, `/events/[id]` (a static seat grid) and `/organizer/events/new`

**Acceptance checks**

- `apps/api/test/auth.test.ts`: no token gives 401; an expired access token gives 401; refresh returns a new token; after logout, refresh fails
- `apps/api/test/rbac.test.ts`: an attendee on an organizer route gets 403; organizer A editing organizer B's event gets 403
- `apps/api/test/events.test.ts`: a layout of 10 rows × 20 seats creates exactly 200 seat rows; a failure injected partway through leaves 0 event and 0 seat rows
- `apps/api/test/pagination.test.ts`: walking every page of 55 published events with `limit=10` returns 55 unique IDs
- `curl -s -o /dev/null -w '%{http_code}' localhost:4000/docs` prints 200

**Out of scope:** holds, payments, real-time updates, email verification, password reset, refresh-token rotation and reuse detection.

## Sprint 2 — Seat holds (core)

**Goal:** any number of concurrent requests for the same seat produce exactly one hold. Data model Rules 1, 3 and 7 are implemented here.

**Depends on:** Sprint 1. **Branch:** `sprint-2-seat-holds`

**Tasks**

- [ ] Migration: add `hold_id`, `held_by`, `held_until` and `version` to `seats`; create `bookings`, `booking_seats` and `idempotency_keys`; create the partial unique index from Rule 3 and an index on `seats(event_id, status)`
- [ ] `apps/api/src/db/seats.ts`: `holdSeats(eventId, seatIds, userId)` runs the Rule 1 lock-then-update in one transaction (lock in ID order, then the conditional UPDATE) and rolls back if fewer rows come back than seats requested
- [ ] `POST /events/:id/holds` with body `{ seatIds }`: 201 returns `{ holdId, seatIds, heldUntil }`; on conflict, 409 returns `{ error: { code: "SEATS_UNAVAILABLE", details: { seatIds } } }`
- [ ] `DELETE /holds/:id`: only the holder can release; the seats go back to `AVAILABLE`
- [ ] More than `MAX_SEATS_PER_HOLD` seats returns 422; a second active hold by the same user for the same event returns 409
- [ ] `Idempotency-Key` header required on `POST /events/:id/holds`. Store (key, user) with the response in `idempotency_keys`. The same key with the same body and user returns the stored response; the same key with a different body returns 422; the same key from a different user returns 422. Insert with ON CONFLICT DO NOTHING and then read — never check-then-insert — so two concurrent requests with the same key produce one hold and one stored response
- [ ] Job `apps/api/src/jobs/expireHolds.ts`, run every `SWEEPER_INTERVAL_SECONDS`: select expired holds with `ORDER BY id FOR UPDATE SKIP LOCKED` so the sweeper never blocks or deadlocks against the hold or confirm paths, then set seats with `status = 'HELD' AND held_until < now()` back to `AVAILABLE`, clear the hold columns, and increment `version`. The same run prunes `idempotency_keys` and `processed_webhooks` rows older than `RETENTION_DAYS`
- [ ] `apps/api/src/services/seatEvents.ts`: an in-process emitter. Every seat change emits `{ eventId, seatIds, status, version }` after COMMIT. Nothing listens yet; Sprint 4 subscribes to it.
- [ ] Seat reads (including `GET /events/:id`) treat `status = 'HELD' AND held_until < now()` as AVAILABLE, so a not-yet-swept expired hold never looks taken
- [ ] Web: select seats, a Hold button, and a countdown to `heldUntil`; a 409 shows which seats were taken

**Acceptance checks**

- `holds.race.test.ts`: 200 concurrent `POST /events/:id/holds` for one seat from 200 different users give exactly one 201 and 199 409s, and the database has exactly 1 `HELD` row for that seat
- `holds.overlap.test.ts`: concurrent holds on seats \[1, 2\] and \[2, 3\]: exactly one succeeds, and the loser leaves no seat `HELD`
- `holds.expiry.test.ts`: with `held_until` set in the past directly in the database, another user can hold the seat, and one sweeper run releases expired holds
- `holds.idempotency.test.ts`: the same key twice gives identical responses and one hold; the same key with a different body gives 422
- `backstop.test.ts`: a raw INSERT of a second `CONFIRMED` `booking_seats` row for the same seat fails with SQLSTATE 23505, while a second `PENDING` `booking_seats` row for the same seat succeeds (that pair is the late-payment scenario working)
- `seatEvents.test.ts`: a rolled-back hold emits nothing; a committed hold emits once with the new version

**Out of scope:** payments, WebSockets, seat recommendations.

## Sprint 3 — Payments and bookings

**Goal:** paying for a hold confirms the booking exactly once, and every failure ends in a defined state. Data model Rules 2 and 4 are implemented here.

**Depends on:** Sprint 2. **Branch:** `sprint-3-payments`

**Tasks**

- [ ] Select the provider with `PAYMENT_PROVIDER` (`stripe`, `razorpay` or `fake`). Implement a `PaymentProvider` interface in `apps/api/src/payments` with `createCheckout`, `verifyWebhook` and `refund`, plus a `fake` provider that every automated test uses.
- [ ] Each provider maps its own webhook events to `{ eventId, type: 'payment_succeeded' | 'checkout_expired', bookingId, paymentRef }`
- [ ] `POST /holds/:id/checkout` (holder only): create a `PENDING` booking bound to that hold (enforced via the unique `bookings.hold_id` constraint) and its `PENDING` booking\_seats rows, set `amount_paise` to the sum of the held seats' `price_paise`, call `createCheckout` with `{ bookingId, holdId }` as metadata, and return `{ checkoutUrl }`. A second checkout for a hold that already has a booking returns the existing `{ bookingId, checkoutUrl }` instead of erroring on the unique constraint
- [ ] `POST /webhooks/:provider`: read the raw body, call `verifyWebhook` (400 on failure), and return 200 once processed
- [ ] Webhook transaction (Rule 4): insert into `processed_webhooks` with ON CONFLICT DO NOTHING; if that inserts 0 rows, commit and return 200. For `payment_succeeded`, follow Rule 2 end to end: lock the booking row (`WHERE id = $x AND hold_id = $1 FOR UPDATE`); if 0 rows or `status <> 'PENDING'`, commit and return 200 — but store the event's `payment_ref` on a FAILED booking in the same commit, so a payment that landed after `checkout_expired` is refunded by the retry job. Otherwise pre-lock the hold's seats in ID order and either confirm all-or-nothing, or release every remaining HELD or BOOKED seat for that hold (clearing hold columns and bumping `version`) and mark the booking and its booking\_seats `FAILED` in the same transaction, triggering the refund and emitting seatEvents after COMMIT
- [ ] Refunds run after COMMIT, never inside the transaction. Job `apps/api/src/jobs/retryRefunds.ts` retries `FAILED` bookings that have a `payment_ref` and no refund yet, until they reach `REFUNDED`.
- [ ] `checkout_expired`: lock the booking row (`WHERE id = $x AND hold_id = $1 FOR UPDATE`); if it is no longer `PENDING`, commit and return 200. Otherwise set that hold's seats still `HELD` back to `AVAILABLE` (clearing hold columns and bumping `version`), and set the booking and its booking\_seats to `FAILED`
- [ ] Emit `seatEvents` after COMMIT for every seat change
- [ ] `GET /bookings/:id` (owner only) and `GET /me/bookings`
- [ ] Web: redirect to checkout; `/bookings/[id]` polls until the status is `CONFIRMED`, `FAILED` or `REFUNDED`; `/me/bookings`
- [ ] **Human:** choose the real provider, create sandbox keys, and add them to `.env`

**Acceptance checks** (in `apps/api/test/payments/`, all using the fake provider)

- `webhook.replay.test.ts`: the same webhook delivered 5 times gives 1 confirmation and 1 `processed_webhooks` row, and all 5 responses are 200
- `webhook.multi-event.test.ts`: two different events for the same payment still give exactly 1 confirmation
- `late-payment.test.ts`: user A holds a seat; A's `held_until` is set in the past; user B holds and pays for the seat; then A's `payment_succeeded` arrives. A's booking ends `REFUNDED` with exactly one refund call, and the seat is `BOOKED` for B.
- `webhook.signature.test.ts`: a bad signature returns 400 and writes no rows
- `webhook.rollback.test.ts`: an error injected after the `processed_webhooks` insert commits nothing, and redelivering the webhook then confirms the booking
- `refund.retry.test.ts`: a failing refund call leaves the booking `FAILED`, and the next job run moves it to `REFUNDED`
- `partial-loss.test.ts`: user A holds 3 seats and starts checkout; A's `held_until` expires and user B claims 1 of the 3 seats; then A's `payment_succeeded` arrives. A's booking ends `REFUNDED` with exactly one refund call, B's seat stays held or booked by B, the other 2 seats return to `AVAILABLE` with an incremented `version`, and the invariants queries return 0 rows
- **Human:** in the real provider's sandbox, pay with a test card, then resend the same event from the provider's CLI or dashboard; the booking doesn't change

**Out of scope:** partial refunds, coupons, invoices, multiple currencies.

## Sprint 4 — Real-time seat map

**Goal:** every open browser sees seat changes within `LIVE_UPDATE_MAX_MS`, across multiple API instances. Data model Rule 5 is implemented here.

**Depends on:** Sprint 2. Runs in parallel with Sprint 3; once Sprint 3 is merged, booking changes flow through the same `seatEvents` emitter with no extra work. **Branch:** `sprint-4-realtime`

**Tasks**

- [ ] WebSocket server at `/ws` using `ws`. The client's first message is `{ type: "auth", token }`; then `{ type: "subscribe", eventId }` joins that event's room.
- [ ] `apps/api/src/realtime/publisher.ts`: listen to `seatEvents` and publish each change to the Redis channel `seats:{eventId}` as `{ eventId, seats: [{ id, status, version }] }`
- [ ] `apps/api/src/realtime/subscriber.ts`: each API instance subscribes to `seats:*` and forwards messages to the sockets in that room
- [ ] Client logic: keep a version per seat and ignore any message whose version is not newer. On reconnect, re-authenticate with the stored access token (a socket can outlive `ACCESS_TOKEN_TTL_SECONDS`); only a server rejection (`UNAUTHORIZED` before close 1008) fetches a fresh token via the refresh cookie, and a refreshed identity that differs from the page's triggers an explicit reload rather than a silent user switch. Then refetch `GET /events/:id` as a snapshot
- [ ] Ping/pong heartbeat; terminate sockets that don't answer
- [ ] If Redis is unavailable, log it, keep serving REST, and reconnect with backoff. The WebSocket layer must never block or fail a hold or booking.
- [ ] `docker-compose.scale.yml`: 2 `api` replicas behind nginx, with WebSocket upgrade headers configured
- [ ] Web: seats change colour live; if a seat the user has selected becomes `HELD` or `BOOKED` by someone else, show a "seat just taken" toast and deselect it

**Acceptance checks** (in `apps/api/test/realtime/`)

- `live.test.ts`: a subscribed client receives the change from a REST hold within `LIVE_UPDATE_MAX_MS`, with the correct version
- `multi-instance.test.ts`: with 2 API processes sharing Redis, a client on instance 1 receives a change made through instance 2
- `redis-down.test.ts`: with Redis stopped, `POST /events/:id/holds` still returns 201 and the Sprint 2 race test still passes; after Redis restarts, messages resume
- `stale.test.ts`: a message older than the client's seat version is ignored
- `reconnect.test.ts`: disconnect a client, make 3 changes, reconnect; the client's seat state matches the database

**Out of scope:** presence indicators, chat, push notifications.

## Sprint 5 — Load testing and hardening

**Goal:** measure the resume numbers under load, and fix whatever the load tests break.

**Depends on:** Sprints 3 and 4. **Branch:** `sprint-5-load-hardening`

**Tasks**

- [ ] Seed script `pnpm --filter api seed:load`: one published event with 50 seats and a pool of attendee accounts whose tokens are written to `load/users.json`
- [ ] `load/flash-sale.js`: every virtual user tries to hold the same 50 seats, each request with a unique `Idempotency-Key`
- [ ] `load/mixed.js`: steady browsing (`GET /events`, `GET /events/:id`) mixed with holds and releases
- [ ] `load/webhook-storm.js`: bursts of duplicate and out-of-order fake-provider webhooks for the same bookings
- [ ] `load/invariants.sql`: queries that return 0 rows when the data is correct: no seat with more than one `CONFIRMED` booking\_seats row (two PENDING rows are legal — see Rule 3), every `BOOKED` seat matching a `CONFIRMED` booking, and every seat of a `CONFIRMED` booking is `BOOKED`
- [ ] k6 thresholds in each script: non-409 error rate below 1%, plus a p95 threshold recorded after the first baseline run
- [ ] EXPLAIN ANALYZE every query on the hold, confirm and event-detail paths; add any missing indexes in a migration
- [ ] Pool size from `DB_POOL_SIZE`; Redis-backed rate limit on `POST /events/:id/holds` using `HOLDS_RATE_LIMIT_PER_MINUTE` (429 when exceeded)
- [ ] helmet, a CORS allowlist from `CORS_ORIGINS`, and a JSON body size limit
- [ ] Optional: cache `GET /events` and `GET /events/:id` in Redis, invalidated on every `seatEvents` change for that event
- [ ] Jest coverage report uploaded as a CI artifact

**Acceptance checks**

- `k6 run load/flash-sale.js` passes its thresholds, then `psql "$DATABASE_URL" -f load/invariants.sql` returns 0 rows
- `k6 run load/webhook-storm.js` passes, and the invariants still return 0 rows
- Every bug found under load has a regression test in `apps/api/test`
- The Metrics log has every row filled in, with the k6 options used (virtual users, iterations) and the machine spec

**Out of scope:** horizontal autoscaling, distributed tracing.

## Sprint 6 — Deploy and ship

**Goal:** a public demo link, automatic deploys from `main`, and a README that explains the engineering.

**Depends on:** Sprint 5. **Branch:** `sprint-6-deploy`

**Tasks**

- [ ] **Human:** create accounts and projects on the hosting platforms below, and add their secrets to the GitHub repository settings
- [ ] Deploy the API to a host that keeps WebSocket connections open (Render, Railway, Fly.io or Cloud Run). Deploy `apps/web` to Vercel. Never put the API on serverless functions; they can't hold sockets.
- [ ] Managed Postgres (Neon or Supabase) and managed Redis (Upstash), configured only through the Config variables
- [ ] `.github/workflows/deploy.yml`: runs on push to `main`, `needs: ci`, runs migrations as a release step, then deploys the API and web app
- [ ] Seed script `pnpm --filter api seed:demo`: one published demo event, plus one demo organizer and one demo attendee account
- [ ] `scripts/smoke.sh <base-url>`: checks `/health`, logs in as the demo attendee, places a hold, requests a checkout URL, then releases the hold
- [ ] README sections: overview, architecture diagram, "How double-booking is prevented" (Rules 1–7), running locally, running the tests and load tests, results (copied from the Metrics log), live demo link and demo logins
- [ ] **Human:** record a GIF of the live seat map for the README, and update the resume bullets with the measured numbers. Word the hold bullet to match the architecture: Postgres conditional-UPDATE holds with a TTL sweeper; Redis only for pub/sub fan-out, caching and rate limiting — never "Redis seat holds"

**Acceptance checks**

- `scripts/smoke.sh https://<api-host>` exits 0 against the deployed API
- A PR with a failing test cannot deploy: the deploy job is skipped because it `needs: ci`
- Opening the live web URL, logging in with the demo attendee account and holding a seat works end to end

**Out of scope:** custom domains, multi-region deployment, monitoring dashboards.

## Definition of done, metrics and interview prep

**Every sprint is done only when:**

- Its acceptance tests are automated and pass in CI
- The work is merged to main through a PR (good commit history is part of what reviewers see)
- The README section for that sprint is updated
- A completion report is posted on the PR, as described in Instructions for agents

**Metrics log.** Agents fill this in when they measure. These cells become the resume numbers.

| Metric | Value | How it was measured | Sprint |
| --- | --- | --- | --- |
| Oversells in the flash-sale test |  | k6 scenario A + invariant query | 5 |
| Concurrent requests on the same seats |  | k6 virtual users | 5 |
| p95 latency for POST /events/:id/holds |  | k6 summary | 5 |
| Throughput |  | k6 summary, req/s | 5 |
| Live update latency | ~37–80 ms (in-suite 78–80 ms; browser cross-replica ≤37 ms, tab B flip before originating tab's own recolor) | Both measured post-merge: (1) in-process cross-instance `multi-instance.test.ts` — REST hold via API instance 2 → WS frame on instance 1 through Redis pub/sub, arrival − send over 2 runs (80, 78 ms); (2) real browser tabs across 2 containerized api replicas through nginx — tab B on api-2 recolored 37 ms before tab A (api-1)'s own flip, i.e. cross-replica fan-out ≤37 ms observed; earlier same-replica browser samples were −69/−51 ms | 4 |
| Test coverage of the API |  | Jest coverage report | 5 |

**Questions to be ready for, and the sprint that answers each**

1. Why not use Redis locks to stop double-booking? (Sprint 2: Postgres decides, and Redis is optional for correctness)
2. Why is READ COMMITTED enough here? How does a conditional UPDATE behave under contention? (Sprint 2)
3. What happens if a payment arrives after its hold expired? (Sprint 3: automatic refund)
4. How do you make webhook retries and client retries safe? (Sprints 2 and 3: idempotency keys and state transitions)
5. Why publish updates only after COMMIT? (Sprint 4)
6. How do WebSockets scale across several servers? (Sprint 4: Redis pub/sub and version numbers)
7. What broke under load, and how did you find it? (Sprint 5: keep notes as you go)
