/* global open, __ENV */
import { check } from "k6";
import { SharedArray } from "k6/data";
import crypto from "k6/crypto";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";

/**
 * Flash sale (Sprint 5, design §356).
 *
 * Every virtual user races to hold seats from the SAME 50-seat event, with a
 * unique `Idempotency-Key` per hold attempt.
 *
 * Pool interpretation (doc-unspecified, recorded in the completion report):
 * `MAX_SEATS_PER_HOLD` is 6, so "hold the same 50 seats" cannot mean one
 * request with all 50 ids (that is a guaranteed 422 for every VU). Instead each
 * VU attempts to hold a successive 6-seat chunk of the shared 50-seat pool.
 * Chunks 0-7 tile seats 0-47 disjointly and chunk 8 wraps onto seats 48-49 and
 * 0-3, so the first ~8-9 chunks to commit win and every later chunk collides
 * with at least one held seat and loses atomically with 409. The expected mix is
 * therefore ~8-9 x 201 and ~191 x 409, with no partial holds and no other
 * statuses.
 *
 * Expected statuses: 201 (winner), 409 (SEATS_UNAVAILABLE loser), plus 422/429
 * as contract-valid refusals. 422 would mean the request shape/count is wrong
 * and 429 would mean per-user pacing failed, but the task's threshold definition
 * treats both as expected; the custom `unexpected_status_rate` counts ONLY
 * responses that are none of 201/409/422/429. Threshold: < 1 %.
 *
 * P95 placeholder: the value below is a conservative pre-baseline guess and is
 * pinned to the measured p95 in Step 5.
 *
 * Run (users.json is gitignored and read relative to this script):
 *   docker run --rm -v "${PWD}/load:/load" -i \
 *     -e API_BASE_URL=http://host.docker.internal:4000 \
 *     grafana/k6 run /load/flash-sale.js
 *
 * The 200 JWTs in load/users.json expire after ACCESS_TOKEN_TTL_SECONDS
 * (default 15 min), so seed immediately before running and re-seed after.
 */

const seed = JSON.parse(open("./users.json"));
const users = new SharedArray("load-users", () => seed.users);

const BASE_URL = (__ENV.API_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
const MAX_SEATS_PER_HOLD = 6;
const EXPECTED_STATUSES = [201, 409, 422, 429];

// TODO(step 5): replace with the p95 measured in the first baseline run.
const P95_HOLD_LATENCY_MS = 1000;

const unexpectedStatus = new Rate("unexpected_status_rate");
const holdsWon = new Counter("holds_won");
const holdsConflict = new Counter("holds_conflict");

export const options = {
  scenarios: {
    flash_sale: {
      executor: "per-vu-iterations",
      vus: 200,
      iterations: 1,
      maxDuration: "2m",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    unexpected_status_rate: ["rate<0.01"],
    http_req_duration: [`p95<${P95_HOLD_LATENCY_MS}`],
    checks: ["rate>0.99"],
  },
};

/** RFC 4122 v4 from k6 crypto bytes (no dependency on a version-specific UUID API). */
function uuidv4() {
  const bytes = new Uint8Array(crypto.randomBytes(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export default function () {
  // per-vu-iterations gives every VU exactly one request and one distinct user.
  const user = users[(exec.vu.idInTest - 1) % users.length];
  const offset = ((exec.vu.idInTest - 1) * MAX_SEATS_PER_HOLD) % seed.seats.length;
  const seatIds = [];

  for (let index = 0; index < MAX_SEATS_PER_HOLD; index += 1) {
    seatIds.push(seed.seats[(offset + index) % seed.seats.length]);
  }

  const response = http.post(
    `${BASE_URL}/events/${seed.eventId}/holds`,
    JSON.stringify({ seatIds }),
    {
      headers: {
        Authorization: `Bearer ${user.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": uuidv4(),
      },
      tags: { name: "POST /events/:id/holds" },
    },
  );

  const expected = EXPECTED_STATUSES.indexOf(response.status) !== -1;
  unexpectedStatus.add(!expected);

  check(response, {
    "hold status is 201/409/422/429": (result) =>
      EXPECTED_STATUSES.indexOf(result.status) !== -1,
  });

  if (response.status === 201) {
    holdsWon.add(1);
  } else if (response.status === 409) {
    holdsConflict.add(1);
  }
}
