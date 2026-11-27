# Discovery — SeatSync repo state (2026-11-27, Sprint 0 pre-start)

Source of truth: `docs/SeatSync_design.md` (429 lines). Workdir `C:\projects\seatsync`, win32, not a git repo.

## 1. Complete file/directory listing (hidden:true, `**/*`)

```text
C:\projects\seatsync\
├── .opencode/
│   ├── agents/
│   │   ├── coder.md
│   │   ├── discovery.md (lines 1-17, self-spec for this task)
│   │   ├── fallback.md
│   │   ├── overseer.md
│   │   ├── planner.md
│   │   └── reviewer.md
│   └── context/
│       ├── discovery.md (lines 1-60, prior run 2026-11-27, will be overwritten by this run)
│       └── plan.md (lines 1-42, Sprint 0 implementation plan, see §4)
└── docs/
    └── SeatSync_design.md (lines 1-429, full project plan)
```

Total on disk: 9 files (6 agents + 2 context + 1 design doc) + 4 dirs. Verified via `read` dir + `glob **/*` with `hidden:true` — same set both times.
Missing: `.git/`, `.gitignore`, `.gitattributes`, `.env`, `.env.example`, `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `tsconfig*.json`, `eslint.config.*`, `.prettierrc`, `README.md`, `docker-compose.yml`, `docker-compose.scale.yml`, `Dockerfile`, `apps/`, `packages/`, `load/`, `scripts/`, `.github/`, `node_modules/`.

## 2. Sprint 0 build-on / conflict check

| # | Path (expected, Sprint 0 creates) | Line range in design doc | Note |
|---|-----------------------------------|--------------------------|------|
| 1 | `package.json` (root, scripts `lint/typecheck/test`) | `docs/SeatSync_design.md:206,210` | NOT FOUND — no conflict, greenfield |
| 2 | `pnpm-workspace.yaml` (`apps/*`, `packages/*`) | `docs/SeatSync_design.md:206` | NOT FOUND — no conflict |
| 3 | `apps/api/package.json` + `src/{config,app,server,routes,db,realtime,jobs}` | `docs/SeatSync_design.md:34-42,206,208-209` | NOT FOUND (`apps/` absent) — no conflict |
| 4 | `apps/web/` (Next.js + TS + Tailwind) | `docs/SeatSync_design.md:43,99,206` | NOT FOUND — no conflict |
| 5 | `packages/shared/` (zod schemas/types) | `docs/SeatSync_design.md:44,206` | NOT FOUND — no conflict |
| 6 | `docker-compose.yml` (db postgres:16, redis redis:7, api:4000, web:3000) | `docs/SeatSync_design.md:207` | NOT FOUND — `grep package.json\|pnpm-workspace\|docker-compose\|ci.yml\|Dockerfile` hits only doc/plan mentions, zero implementation files |
| 7 | `.github/workflows/ci.yml` | `docs/SeatSync_design.md:214` | NOT FOUND (`.github/` absent) — no conflict |
| 8 | `apps/api/migrations/` (node-pg-migrate, first: `users`) | `docs/SeatSync_design.md:41,209` | NOT FOUND — no conflict |
| 9 | `apps/api/test/` (Jest+Supertest, truncate helper) | `docs/SeatSync_design.md:42,211` | NOT FOUND — no conflict |
| 10 | `.env.example` + `apps/api/src/config.ts` | `docs/SeatSync_design.md:71-89,208` | NOT FOUND — no secrets on disk, nothing to leak/migrate |

Verdict: nothing to build on, nothing to conflict with. Sprint 0 starts from empty.

## 3. Git repo?

- `C:\projects\seatsync\.git` — NOT FOUND (hidden glob returns no `.git` entry; confirms env `Is directory a git repo: no`).
- No `sprint-0-foundation` branch can exist yet; Sprint 0 task "create branch" requires `git init -b main` + initial commit first.
- No remote; CI-on-PR acceptance check will need human to create GitHub repo/remote.

## 4. Existing `.opencode/context/` files

| # | Path | Lines | Note |
|---|------|-------|------|
| 1 | `.opencode/context/plan.md` | 1-42 | Sprint 0 implementation plan (6 steps: bootstrap workspace/tooling; compose+config; migration `users`; Express+health+pino; Jest tests; CI+README); already maps AC1-AC5 and win32 notes (`curl.exe`, `Copy-Item`, LF via `.gitattributes`). Planner output, not yet executed. |
| 2 | `.opencode/context/discovery.md` | 1-60 | Prior discovery run same date: same greenfield conclusion (only `.opencode/`+`docs/` at that time); now stale (says context/ empty, misses `plan.md`) — this file overwrites it. |
| 3 | `.opencode/agents/discovery.md` | 1-17 | This task's permission spec: deny `edit *` except allow `edit .opencode/context/*`, deny `shell *` — discovery must stay read-only outside context/. |

Risk: `plan.md` assumes `git init`, Docker Desktop running, service-vs-localhost hostnames (`db:5432` in compose vs `localhost:5432` on host) — planner flags this at `plan.md:42`.

## 5. Design doc — exact Sprint 0 requirements (verbatim summary)

Source ranges: Instructions `19-30`, Layout `32-47`, Commands `49-58`, Rules `60-69`, Config `71-89`, Sprint 0 `198-225`.

- **Instructions for agents (`19-30`):** doc overrides judgement; say in report when you choose uncovered option. Pick-up: (1) check `Depends on` merged, (2) create named branch, (3) do all tasks, no extras, respect Out of scope, (4) pass acceptance locally+CI, (5) PR + completion report (per-check command+result, unspecified decisions, Metrics log), (6) **Human** items reported blocked, no workarounds.
- **Repository layout (`34-47`):** `apps/api/src/routes` thin handlers; `services` logic; `db` all SQL; `payments` interface+stripe/razorpay/fake; `realtime` WS+Redis pub/sub; `jobs` sweeper/refund-retry; `migrations` node-pg-migrate; `test` Jest+Supertest; `apps/web` Next.js; `packages/shared` zod; `load` k6+invariants.sql; `scripts` smoke+seed.
- **Standard commands (`49-58`):** `pnpm install`; `docker compose up -d db redis`; `pnpm --filter api migrate up`; `pnpm lint && pnpm typecheck && pnpm test`; `pnpm --filter api test -- <file-pattern>`; `k6 run load/<scenario>.js`.
- **Rules MUST/MUST NOT (`60-69`):** hand-write all seat/booking SQL in `db`, no ORM; seat/booking/webhook tests vs real Postgres, no DB mocks; Redis never required for correctness; money integer paise; all tunables from Config table via env, no hard-code; no microservices/K8s/extra brokers/DBs; never wait real time in tests (set `held_until` past); strict TS, no `any` in `db`/`services`.
- **Config table (`71-89`, 15 vars):** `DATABASE_URL` (—), `REDIS_URL` (—), `DB_POOL_SIZE`=20, `JWT_SECRET` (—), `ACCESS_TOKEN_TTL_SECONDS`=900, `REFRESH_TOKEN_TTL_SECONDS`=1209600, `HOLD_TTL_SECONDS`=600, `SWEEPER_INTERVAL_SECONDS`=30, `MAX_SEATS_PER_HOLD`=6, `PAYMENT_PROVIDER`=fake, `PAYMENT_WEBHOOK_SECRET` (—), `HOLDS_RATE_LIMIT_PER_MINUTE`=20, `CORS_ORIGINS`=http://localhost:3000, `LIVE_UPDATE_MAX_MS`=1000, `RETENTION_DAYS`=30.
- **Sprint 0 Goal (`198-202`):** one command boots full stack, CI passes. Depends on nothing. Branch `sprint-0-foundation`.
- **Sprint 0 Tasks (`206-215`, 10 items):** (1) pnpm workspace `apps/api` Express+TS + `apps/web` Next.js+TS + `packages/shared` zod; (2) `docker-compose.yml` db postgres:16 + redis redis:7 + api:4000 + web:3000; (3) `.env.example` all Config vars + typed `apps/api/src/config.ts` fail-fast; (4) node-pg-migrate, first migration `users(id, email unique, password_hash, role, created_at)`; (5) strict TS + ESLint + Prettier, root `lint/typecheck/test`; (6) Jest+Supertest vs compose Postgres + truncate helper; (7) `GET /health` 200 `{"db":"ok","redis":"ok"}` or 503 naming failure; (8) pino + request ID every line + `X-Request-Id` header; (9) `.github/workflows/ci.yml` install/lint/typecheck/migrate/test with PG+Redis services; (10) README prereqs + standard commands.
- **Acceptance checks (`219-223`, 5 items):** (a) `docker compose up -d && curl -s localhost:4000/health` → `{"db":"ok","redis":"ok"}`; (b) `docker compose stop redis && curl -i localhost:4000/health` → 503 naming redis; (c) `migrate up` + `migrate down` exit 0; (d) `pnpm lint && pnpm typecheck && pnpm test` exit 0; (e) CI passes on PR.
- **Out of scope (`225`):** auth, any table other than `users`.

## Risks

- Greenfield: all 10 Sprint 0 tasks unstarted; no baseline/regression surface — follow doc literally per `SeatSync_design.md:21`.
- No git/remote: branch creation + CI-on-PR blocked until human runs `git init` / creates GitHub repo (also noted `plan.md:41`).
- Windows host: PowerShell `curl` alias, `&&` chaining, CRLF vs container LF need `curl.exe` / `.gitattributes eol=lf` handling (`plan.md:6,42`).
