/* global open, __ENV */
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import crypto from "k6/crypto";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";

/**
 * Mixed steady-state traffic (Sprint 5, design §357).
 *
 * 20 VUs for 90 s. Each iteration browses the public event list
 * (`GET /events`) and the seeded event (`GET /events/:id`), then — at most once
 * every 5 s per VU — holds one seat and immediately releases it with
 * `DELETE /holds/:id`.
 *
 * Pacing math (D33/HOLDS_RATE_LIMIT_PER_MINUTE=20, per user):
 *   - The limiter counts POST /events/:id/holds per user in a fixed 60 s window.
 *   - Each VU owns one distinct user and one distinct seat (VU 1 -> seat 0,
 *     ... VU 20 -> seat 19), so holds never contend with another VU's seat.
 *   - `lastHoldAt` enforces a hard 5 000 ms floor between one VU's hold
 *     attempts: 60 s / 5 s = 12 holds/min worst case. The 1.5 s iteration sleep
 *     plus request latency usually brings it to ~8-10/min. Both are < 20/min.
 *   - A 429 is therefore a pacing bug, not an expected outcome.
 *
 * Expected statuses: GETs 200, hold 201 (or 409 if a previous release failed),
 * release 204. Every other status — including 429 and 422 — is counted by
 * `mixed_unexpected_rate`, which must stay below 1 %. In addition
 * `rate_limit_hits` must be exactly 0, so even a single 429 fails the run
 * (the 1 % rate alone would hide a lone 429 among thousands of requests).
 *
 * P95 placeholder: conservative pre-baseline guess, pinned in Step 5.
 *
 * Run:
 *   docker run --rm -v "${PWD}/load:/load" -i \
 *     -e API_BASE_URL=http://host.docker.internal:4000 \
 *     grafana/k6 run /load/mixed.js
 *
 * Use a freshly seeded event (no leftover holds from flash-sale) and re-seed
 * within the 15-minute access-token TTL.
 */

const seed = JSON.parse(open("./users.json"));
const users = new SharedArray("load-users", () => seed.users);

const BASE_URL = (__ENV.API_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
const HOLD_INTERVAL_MS = 5_000;

// TODO(step 5): replace with the p95 measured in the first baseline run.
const P95_REQUEST_LATENCY_MS = 500;

const mixedUnexpected = new Rate("mixed_unexpected_rate");
const rateLimitHits = new Counter("rate_limit_hits");

// Per-VU module scope: each k6 VU has its own JS runtime, so this is not shared.
let lastHoldAt = 0;

const EXPECTED_BROWSE_STATUSES = [200];
const EXPECTED_HOLD_STATUSES = [201, 409];
const EXPECTED_RELEASE_STATUSES = [204];

export const options = {
  scenarios: {
    mixed: {
      executor: "constant-vus",
      vus: 20,
      duration: "90s",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    mixed_unexpected_rate: ["rate<0.01"],
    rate_limit_hits: ["count==0"],
    http_req_duration: [`p95<${P95_REQUEST_LATENCY_MS}`],
    checks: ["rate>0.99"],
  },
};

function authHeaders(user) {
  return { Authorization: `Bearer ${user.token}` };
}

function recordStatus(response, expectedStatuses, checkName) {
  const expected = expectedStatuses.indexOf(response.status) !== -1;
  mixedUnexpected.add(!expected);
  check(response, { [checkName]: () => expected });

  if (response.status === 429) {
    rateLimitHits.add(1);
  }

  return expected;
}

export default function () {
  const user = users[(exec.vu.idInTest - 1) % users.length];
  // One dedicated seat per VU; 20 VUs < 50 seats, so active holds never overlap.
  const seatId = seed.seats[(exec.vu.idInTest - 1) % seed.seats.length];

  const list = http.get(`${BASE_URL}/events?limit=10`, {
    tags: { name: "GET /events" },
  });
  recordStatus(list, EXPECTED_BROWSE_STATUSES, "GET /events is 200");

  const detail = http.get(`${BASE_URL}/events/${seed.eventId}`, {
    headers: authHeaders(user),
    tags: { name: "GET /events/:id" },
  });
  recordStatus(detail, EXPECTED_BROWSE_STATUSES, "GET /events/:id is 200");

  if (Date.now() - lastHoldAt >= HOLD_INTERVAL_MS) {
    // Stamp before the request so a failed/slow attempt still consumes the slot.
    lastHoldAt = Date.now();

    const hold = http.post(
      `${BASE_URL}/events/${seed.eventId}/holds`,
      JSON.stringify({ seatIds: [seatId] }),
      {
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": uuidv4(),
        },
        tags: { name: "POST /events/:id/holds" },
      },
    );

    if (recordStatus(hold, EXPECTED_HOLD_STATUSES, "hold is 201/409") && hold.status === 201) {
      const holdId = hold.json("holdId");

      if (typeof holdId === "string") {
        const release = http.del(`${BASE_URL}/holds/${holdId}`, null, {
          headers: authHeaders(user),
          tags: { name: "DELETE /holds/:id" },
        });
        recordStatus(release, EXPECTED_RELEASE_STATUSES, "release is 204");
      }
    }
  }

  sleep(1.5);
}

/** RFC 4122 v4 from k6 crypto bytes (no dependency on a version-specific UUID API). */
function uuidv4() {
  const bytes = new Uint8Array(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
