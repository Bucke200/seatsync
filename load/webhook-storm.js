/* global open, __ENV */
import { check } from "k6";
import { SharedArray } from "k6/data";
import crypto from "k6/crypto";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Rate } from "k6/metrics";

/**
 * Webhook storm (Sprint 5, design §358).
 *
 * REQUIRES an API booted with `PAYMENT_PROVIDER=fake` and the same
 * `PAYMENT_WEBHOOK_SECRET` passed here (see D37/Step 5: temporary API container;
 * the default dev container uses razorpay and answers 400 UNKNOWN_PROVIDER).
 *
 * Phase (a), `setup()` — runs ONCE: five users each hold one seat and check out,
 * producing five PENDING bookings. Their ids/hold ids are returned to the
 * storm.
 *
 * Phase (b), default — 20 VUs / 200 iterations (`shared-iterations`). Every
 * iteration sends one provider-signed delivery for one of five recipes:
 *
 *   1. pay-same-event:        payment_succeeded with ONE fixed eventId x ~40
 *                             deliveries -> dedupe: exactly one confirm, every
 *                             duplicate 200.
 *   2. expire-same-event:     checkout_expired with ONE fixed eventId x ~40
 *                             -> dedupe: exactly one FAILED, duplicates 200.
 *   3. late-payment:          checkout_expired and payment_succeeded have
 *                             DIFFERENT eventIds and race each other; whichever
 *                             lands first wins, the other is still processed on
 *                             its own (late payment after expiry -> refund).
 *   4. expiry-after-payment:  same two events as 3, so both orderings occur.
 *   5. pay-replays:           payment_succeeded with a UNIQUE eventId per
 *                             delivery x ~40 -> first confirms, the rest hit the
 *                             terminal CONFIRMED booking and commit as 200
 *                             no-ops (terminal idempotency, not dedupe).
 *
 * Every body is signed over its exact UTF-8 bytes with
 * `crypto.hmac("sha256", PAYMENT_WEBHOOK_SECRET, rawBody, "hex")` and sent in
 * `x-fake-signature` with `Content-Type: application/octet-stream`, matching
 * `apps/api/src/payments/fake.ts`.
 *
 * Thresholds: any status other than 200 (400 = bad signature/provider, 5xx =
 * transaction failure) counts towards `webhook_unexpected_rate` (< 1 %). The
 * teardown reads every booking back and asserts its terminal state, so a storm
 * that returns 200 but leaves a booking PENDING fails
 * `webhook_booking_state_ok` (rate == 1).
 *
 * P95 placeholder: conservative pre-baseline guess, pinned in Step 5.
 *
 * Run (needs a freshly seeded event; seats 0-4 must be AVAILABLE):
 *   docker run --rm -v "${PWD}/load:/load" -i \
 *     -e API_BASE_URL=http://host.docker.internal:4000 \
 *     -e PAYMENT_WEBHOOK_SECRET=<same secret as the API> \
 *     grafana/k6 run /load/webhook-storm.js
 *
 * The seeded JWTs expire after ACCESS_TOKEN_TTL_SECONDS (15 min default).
 */

const seed = JSON.parse(open("./users.json"));
const users = new SharedArray("load-users", () => seed.users);

const BASE_URL = (__ENV.API_BASE_URL || "http://localhost:4000").replace(/\/+$/, "");
const PROVIDER = __ENV.PAYMENT_PROVIDER || "fake";
const WEBHOOK_SECRET = __ENV.PAYMENT_WEBHOOK_SECRET || "";

// TODO(step 5): replace with the p95 measured in the first baseline run.
const P95_WEBHOOK_LATENCY_MS = 1000;

const BOOKING_RECIPES = [
  "pay-same-event",
  "expire-same-event",
  "late-payment",
  "expiry-after-payment",
  "pay-replays",
];

const EXPECTED_FINAL_STATES = {
  "pay-same-event": ["CONFIRMED"],
  "expire-same-event": ["FAILED"],
  // The two events race; either ordering is legal and terminal.
  "late-payment": ["CONFIRMED", "FAILED", "REFUNDED"],
  "expiry-after-payment": ["CONFIRMED", "FAILED", "REFUNDED"],
  "pay-replays": ["CONFIRMED"],
};

const webhookUnexpected = new Rate("webhook_unexpected_rate");
const bookingStateOk = new Rate("webhook_booking_state_ok");
const webhookRequests = new Counter("webhook_requests");

export const options = {
  scenarios: {
    storm: {
      executor: "shared-iterations",
      vus: 20,
      iterations: 200,
      maxDuration: "60s",
      gracefulStop: "10s",
    },
  },
  thresholds: {
    webhook_unexpected_rate: ["rate<0.01"],
    webhook_booking_state_ok: ["rate==1"],
    http_req_duration: [`p95<${P95_WEBHOOK_LATENCY_MS}`],
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

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is missing from the API response`);
  }

  return value;
}

export function setup() {
  if (WEBHOOK_SECRET.length === 0) {
    throw new Error(
      "PAYMENT_WEBHOOK_SECRET is required: pass the same secret the load API uses with -e PAYMENT_WEBHOOK_SECRET=...",
    );
  }

  // One run id shared by every VU so "fixed" eventIds are actually duplicates
  // within this run and cannot collide with a previous storm's dedupe rows.
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const bookings = BOOKING_RECIPES.map((recipe, index) => {
    const user = users[index];
    const seatId = seed.seats[index];

    const hold = http.post(
      `${BASE_URL}/events/${seed.eventId}/holds`,
      JSON.stringify({ seatIds: [seatId] }),
      {
        headers: {
          Authorization: `Bearer ${user.token}`,
          "Content-Type": "application/json",
          "Idempotency-Key": uuidv4(),
        },
        tags: { name: "setup POST /events/:id/holds" },
      },
    );

    if (hold.status !== 201) {
      throw new Error(
        `setup hold for ${recipe} failed with ${hold.status}: ${hold.body}`,
      );
    }

    const holdId = requireString(hold.json("holdId"), "setup holdId");

    const checkout = http.post(`${BASE_URL}/holds/${holdId}/checkout`, null, {
      headers: { Authorization: `Bearer ${user.token}` },
      tags: { name: "setup POST /holds/:id/checkout" },
    });

    if (checkout.status !== 201) {
      throw new Error(
        `setup checkout for ${recipe} failed with ${checkout.status}: ${checkout.body}`,
      );
    }

    return {
      recipe,
      bookingId: requireString(checkout.json("bookingId"), "setup bookingId"),
      holdId,
      token: user.token,
    };
  });

  return { runId, bookings };
}

function buildPayload(data, booking, iteration) {
  const base = {
    bookingId: booking.bookingId,
    holdId: booking.holdId,
  };

  switch (booking.recipe) {
    case "pay-same-event":
      return {
        ...base,
        eventId: `${data.runId}-pay-same`,
        type: "payment_succeeded",
        paymentRef: "pay_load_same",
      };
    case "expire-same-event":
      return {
        ...base,
        eventId: `${data.runId}-expire-same`,
        type: "checkout_expired",
        paymentRef: null,
      };
    case "late-payment":
      return iteration % 2 === 0
        ? {
            ...base,
            eventId: `${data.runId}-late-expire`,
            type: "checkout_expired",
            paymentRef: null,
          }
        : {
            ...base,
            eventId: `${data.runId}-late-pay`,
            type: "payment_succeeded",
            paymentRef: "pay_load_late",
          };
    case "expiry-after-payment":
      return iteration % 2 === 0
        ? {
            ...base,
            eventId: `${data.runId}-after-pay`,
            type: "payment_succeeded",
            paymentRef: "pay_load_after",
          }
        : {
            ...base,
            eventId: `${data.runId}-after-expire`,
            type: "checkout_expired",
            paymentRef: null,
          };
    default:
      // pay-replays: unique eventId per delivery, so dedupe cannot absorb them;
      // the booking's terminal state is what makes every later payment a no-op.
      return {
        ...base,
        eventId: `${data.runId}-replay-${iteration}`,
        type: "payment_succeeded",
        paymentRef: `pay_load_replay_${iteration}`,
      };
  }
}

export default function (data) {
  const iteration = exec.scenario.iterationInTest;
  const booking = data.bookings[iteration % data.bookings.length];
  const rawBody = JSON.stringify(buildPayload(data, booking, iteration));
  const signature = crypto.hmac("sha256", WEBHOOK_SECRET, rawBody, "hex");

  const response = http.post(`${BASE_URL}/webhooks/${PROVIDER}`, rawBody, {
    headers: {
      "Content-Type": "application/octet-stream",
      "x-fake-signature": signature,
    },
    tags: { name: "POST /webhooks/:provider", recipe: booking.recipe },
  });

  const expected = response.status === 200;
  webhookUnexpected.add(!expected);
  webhookRequests.add(1);
  check(response, { "webhook is 200": () => expected });
}

export function teardown(data) {
  for (const booking of data.bookings) {
    const response = http.get(`${BASE_URL}/bookings/${booking.bookingId}`, {
      headers: { Authorization: `Bearer ${booking.token}` },
      tags: { name: "teardown GET /bookings/:id" },
    });
    const status =
      response.status === 200 ? String(response.json("status")) : `HTTP_${response.status}`;
    const allowed = EXPECTED_FINAL_STATES[booking.recipe];
    const ok = allowed.indexOf(status) !== -1;

    bookingStateOk.add(ok);
    check(response, { [`final state ${booking.recipe}`]: () => ok });
  }
}
