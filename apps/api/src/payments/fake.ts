import { z } from "zod";
import type {
  CreateCheckoutInput,
  PaymentProvider,
  VerifiedWebhookEvent,
} from "./index";
import { WebhookVerificationError } from "./errors";
import { computeHmacSha256Hex, verifyHmacSha256Hex } from "./signature";

/**
 * The fake provider every automated payment test uses (D20). It never makes a
 * network call and is fully deterministic.
 *
 * Webhook contract (documented here because it is our own protocol):
 * - The body is JSON shaped like `FakeWebhookPayload`.
 * - The signature is the lowercase hex HMAC-SHA256 of the exact raw body bytes
 *   keyed by `PAYMENT_WEBHOOK_SECRET`, sent in the `x-fake-signature` header.
 * - `createFakeWebhook` builds a matching body + signature for tests.
 */

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";

const fakeWebhookPayloadSchema = z
  .object({
    eventId: z.string().min(1),
    type: z.enum(["payment_succeeded", "checkout_expired"]),
    bookingId: z.string().uuid(),
    holdId: z.string().uuid().optional(),
    paymentRef: z.string().min(1).nullable().optional(),
  })
  .transform((payload) => ({
    eventId: payload.eventId,
    type: payload.type,
    bookingId: payload.bookingId,
    holdId: payload.holdId,
    paymentRef: payload.paymentRef ?? null,
  }));

export interface FakeWebhookPayload {
  eventId: string;
  type: "payment_succeeded" | "checkout_expired";
  bookingId: string;
  holdId?: string;
  paymentRef?: string | null;
}

/** Hex HMAC-SHA256 of the exact raw body, to send in `x-fake-signature`. */
export function signFakeWebhook(
  rawBody: Buffer | string,
  secret: string,
): string {
  const bytes =
    typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  return computeHmacSha256Hex(bytes, secret);
}

/**
 * Build a signed fake webhook delivery. Tests pass `rawBody` to
 * `.send(rawBody)` (or `verifyWebhook` directly) and put `signature` in the
 * `x-fake-signature` header.
 */
export function createFakeWebhook(
  payload: FakeWebhookPayload,
  secret: string,
): { rawBody: Buffer; signature: string } {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  return { rawBody, signature: signFakeWebhook(rawBody, secret) };
}

export interface FakeRefundCall {
  paymentRef: string;
  amountPaise: number;
}

/**
 * Module-level controls shared by every `FakePaymentProvider` instance in the
 * process. The app builds its provider internally, so tests reach it through
 * this object instead of the app wiring.
 *
 * - `refundCalls` is the ordered audit of every refund attempt (including ones
 *   armed to fail), for "exactly one refund call" assertions.
 * - `failNextRefund` makes the next refund call throw once, then disarms
 *   (refund.retry).
 * - `failAfterDedupe` makes the next webhook transaction throw once at the
 *   `runAfterDedupeHook` seam, after the dedupe insert and before the booking
 *   lock (webhook.rollback).
 */
export interface FakePaymentControls {
  refundCalls: FakeRefundCall[];
  failNextRefund(error?: Error): void;
  failAfterDedupe(error?: Error): void;
  /** Clear the audit list and any armed failures (call in test setup/teardown). */
  reset(): void;
}

let nextRefundError: Error | null = null;
let nextAfterDedupeError: Error | null = null;

export const fakePaymentControls: FakePaymentControls = {
  refundCalls: [],
  failNextRefund(error?: Error): void {
    nextRefundError = error ?? new Error("fake provider: injected refund failure");
  },
  failAfterDedupe(error?: Error): void {
    nextAfterDedupeError =
      error ?? new Error("fake provider: injected post-dedupe failure");
  },
  reset(): void {
    fakePaymentControls.refundCalls.length = 0;
    nextRefundError = null;
    nextAfterDedupeError = null;
  },
};

/** Rule 6: money is an integer number of paise, always positive here. */
function assertPositiveIntegerPaise(amountPaise: number): void {
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    throw new Error(
      `amountPaise must be a positive integer number of paise (Rule 6), got ${String(
        amountPaise,
      )}`,
    );
  }
}

export class FakePaymentProvider implements PaymentProvider {
  constructor(private readonly webhookSecret: string) {}

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<{ checkoutUrl: string }> {
    assertPositiveIntegerPaise(input.amountPaise);

    // Deterministic and same-origin so the web app can redirect to it.
    return { checkoutUrl: `/bookings/${input.bookingId}?fakeCheckout=1` };
  }

  verifyWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): VerifiedWebhookEvent {
    if (!verifyHmacSha256Hex(rawBody, this.webhookSecret, signature)) {
      throw new WebhookVerificationError(
        "Invalid fake webhook signature",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookVerificationError(
        "Fake webhook body is not valid JSON",
      );
    }

    const result = fakeWebhookPayloadSchema.safeParse(parsed);
    if (!result.success) {
      throw new WebhookVerificationError(
        `Invalid fake webhook payload: ${result.error.issues
          .map((issue) =>
            issue.path.length > 0 ? issue.path.join(".") : "body",
          )
          .join(", ")}`,
      );
    }

    return result.data;
  }

  async refund(paymentRef: string, amountPaise: number): Promise<void> {
    assertPositiveIntegerPaise(amountPaise);
    fakePaymentControls.refundCalls.push({ paymentRef, amountPaise });

    if (nextRefundError !== null) {
      const error = nextRefundError;
      nextRefundError = null;
      throw error;
    }
  }

  /**
   * Test-only seam (D20a, doc-unspecified): the webhook transaction calls this
   * once between the `processed_webhooks` insert and the booking row lock.
   *
   * Every real provider omits the optional method, so the seam is a no-op
   * there. The fake provider throws the single error armed with
   * `fakePaymentControls.failAfterDedupe`, proving that a failure after the
   * dedupe insert rolls the whole transaction back.
   */
  runAfterDedupeHook(): void {
    if (nextAfterDedupeError !== null) {
      const error = nextAfterDedupeError;
      nextAfterDedupeError = null;
      throw error;
    }
  }
}
