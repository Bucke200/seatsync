import { z } from "zod";
import type {
  CreateCheckoutInput,
  PaymentProvider,
  VerifiedWebhookEvent,
  WebhookEventType,
} from "./index";
import { PaymentProviderRequestError, WebhookVerificationError } from "./errors";
import { verifyHmacSha256Hex } from "./signature";

/**
 * Razorpay Payment Links provider (D20).
 *
 * - Checkout: `POST https://api.razorpay.com/v1/payment_links` with the amount
 *   in paise, `currency: "INR"` and `notes: { bookingId, holdId }`; the
 *   returned `short_url` is the checkout URL.
 * - Webhook: `X-Razorpay-Signature` is the hex HMAC-SHA256 of the raw body
 *   keyed by `PAYMENT_WEBHOOK_SECRET`, checked with `timingSafeEqual`.
 * - Refund: `POST /v1/payments/:id/refund` with the amount in paise.
 * - Refund replay: Razorpay has no idempotent refund endpoint. Replaying a
 *   refund that already succeeded returns HTTP 400 whose
 *   `error.description` is "The payment has been fully refunded already";
 *   that 400 IS the idempotent-replay answer, so `refund()` resolves and the
 *   caller marks the booking REFUNDED instead of retrying forever (D38).
 *   Every other 400 (insufficient balance, malformed request, ...) stays a
 *   `PaymentProviderRequestError`.
 * - Refund throttling: HTTP 429 (and 5xx) stay retryable errors; the retry
 *   job's existing interval handles them. No in-request `Retry-After` sleep
 *   is added because `refund()` runs inside the job's row-locking
 *   transaction, which must not be held open while waiting.
 *
 * Event mapping (Razorpay Payment Links docs, checked 2026-11-28):
 * - `payment_link.paid`      -> `payment_succeeded` (payment id -> paymentRef)
 * - `payment_link.expired`   -> `checkout_expired`
 * - `payment_link.cancelled` -> `checkout_expired`
 *
 * Every other event (including `payment_link.partially_paid`) is rejected as
 * unknown so the route returns 400 and writes nothing: a partial payment must
 * never confirm a booking. Razorpay's `X-Razorpay-Event-Id` header is not part
 * of the provider interface, so the dedupe `eventId` is derived
 * deterministically from the event name plus the payment or payment-link id,
 * which is stable across redeliveries of the same event.
 */

export const RAZORPAY_SIGNATURE_HEADER = "x-razorpay-signature";

const RAZORPAY_API_BASE_URL = "https://api.razorpay.com/v1";

export interface RazorpayProviderOptions {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

const razorpayWebhookSchema = z.object({
  event: z.string().min(1),
  payload: z.object({
    payment: z
      .object({
        entity: z.object({ id: z.string().min(1) }),
      })
      .optional(),
    payment_link: z
      .object({
        entity: z.object({
          id: z.string().min(1),
          notes: z.record(z.unknown()).nullable().optional(),
        }),
      })
      .optional(),
  }),
});

const EVENT_TYPE_BY_RAZORPAY_EVENT: Readonly<Record<string, WebhookEventType>> =
  {
    "payment_link.paid": "payment_succeeded",
    "payment_link.expired": "checkout_expired",
    "payment_link.cancelled": "checkout_expired",
  };

const uuidSchema = z.string().uuid();

/** Read a UUID note from Razorpay's free-form `notes` object. */
function readUuidNote(
  notes: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = notes?.[key];
  if (typeof value !== "string" || !uuidSchema.safeParse(value).success) {
    return undefined;
  }
  return value;
}

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

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function describeResponseBody(body: unknown): string {
  if (body === undefined) {
    return "<empty response>";
  }

  if (typeof body === "string") {
    return body;
  }

  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function readStringField(value: unknown, field: string): string | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const fieldValue = record[field];
  return typeof fieldValue === "string" && fieldValue.length > 0
    ? fieldValue
    : undefined;
}

/**
 * Razorpay's idempotent-replay answer for a refund that already succeeded:
 * HTTP 400 with `error.description` =
 * "The payment has been fully refunded already" (observed live 2026-11-28).
 * The match is a tolerant case-insensitive substring that accepts either word
 * order with optional `fully`, so wording tweaks still converge (D38):
 * - trailing order requires the affirmative auxiliary directly before
 *   "refunded" (`has been refunded already`);
 * - canonical order requires "already" directly before "refunded"
 *   (`already refunded`).
 * A bare `/refunded\s+already/` would also match the negation "has not been
 * refunded already", which is a different error; the auxiliary guard above
 * keeps negated phrasings from resolving the refund.
 */
const ALREADY_REFUNDED_DESCRIPTION =
  /(?:has been|was|is)\s+(?:fully\s+)?refunded\s+already|already\s+(?:fully\s+)?refunded/i;

function isAlreadyRefundedError(body: unknown): boolean {
  if (typeof body !== "object" || body === null) {
    return false;
  }

  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const description = (error as Record<string, unknown>).description;
  return (
    typeof description === "string" &&
    ALREADY_REFUNDED_DESCRIPTION.test(description)
  );
}

export class RazorpayPaymentProvider implements PaymentProvider {
  private readonly authorizationHeader: string;

  constructor(private readonly options: RazorpayProviderOptions) {
    this.authorizationHeader = `Basic ${Buffer.from(
      `${options.keyId}:${options.keySecret}`,
      "utf8",
    ).toString("base64")}`;
  }

  async createCheckout(
    input: CreateCheckoutInput,
  ): Promise<{ checkoutUrl: string }> {
    assertPositiveIntegerPaise(input.amountPaise);

    const response = await fetch(`${RAZORPAY_API_BASE_URL}/payment_links`, {
      method: "POST",
      headers: {
        Authorization: this.authorizationHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: "INR",
        notes: {
          bookingId: input.bookingId,
          holdId: input.holdId,
        },
      }),
    });

    const body = await readResponseBody(response);

    if (!response.ok) {
      throw new PaymentProviderRequestError(
        `Razorpay payment link creation failed (HTTP ${
          response.status
        }): ${describeResponseBody(body)}`,
      );
    }

    const checkoutUrl = readStringField(body, "short_url");
    if (checkoutUrl === undefined) {
      throw new PaymentProviderRequestError(
        "Razorpay payment link response is missing short_url",
      );
    }

    return { checkoutUrl };
  }

  verifyWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): VerifiedWebhookEvent {
    if (
      !verifyHmacSha256Hex(rawBody, this.options.webhookSecret, signature)
    ) {
      throw new WebhookVerificationError(
        "Invalid Razorpay webhook signature",
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookVerificationError(
        "Razorpay webhook body is not valid JSON",
      );
    }

    const result = razorpayWebhookSchema.safeParse(parsed);
    if (!result.success) {
      throw new WebhookVerificationError(
        "Invalid Razorpay webhook payload",
      );
    }

    const { event, payload } = result.data;
    const type = EVENT_TYPE_BY_RAZORPAY_EVENT[event];
    if (type === undefined) {
      throw new WebhookVerificationError(
        `Unsupported Razorpay webhook event: ${event}`,
      );
    }

    const paymentLink = payload.payment_link?.entity;
    if (paymentLink === undefined) {
      throw new WebhookVerificationError(
        "Razorpay webhook payload is missing payment_link",
      );
    }

    const bookingId = readUuidNote(paymentLink.notes, "bookingId");
    if (bookingId === undefined) {
      throw new WebhookVerificationError(
        "Razorpay webhook notes are missing a valid bookingId",
      );
    }

    const holdId = readUuidNote(paymentLink.notes, "holdId");

    let paymentRef: string | null = null;
    if (type === "payment_succeeded") {
      const paymentId = payload.payment?.entity.id;
      if (paymentId === undefined) {
        throw new WebhookVerificationError(
          "Razorpay payment_link.paid webhook is missing the payment entity",
        );
      }
      paymentRef = paymentId;
    }

    const eventId =
      paymentRef === null
        ? `razorpay:${event}:${paymentLink.id}`
        : `razorpay:${event}:${paymentLink.id}:${paymentRef}`;

    return { eventId, type, bookingId, holdId, paymentRef };
  }

  async refund(paymentRef: string, amountPaise: number): Promise<void> {
    assertPositiveIntegerPaise(amountPaise);

    const response = await fetch(
      `${RAZORPAY_API_BASE_URL}/payments/${encodeURIComponent(
        paymentRef,
      )}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: this.authorizationHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ amount: amountPaise }),
      },
    );

    if (!response.ok) {
      const body = await readResponseBody(response);

      // D38: Razorpay has no idempotent refund endpoint, so a replay of a
      // refund that already succeeded (the retry job's crash window) comes
      // back as HTTP 400 "The payment has been fully refunded already".
      // The money is already with the customer: resolve so the caller marks
      // the booking REFUNDED. Every other 400 keeps failing.
      if (response.status === 400 && isAlreadyRefundedError(body)) {
        return;
      }

      throw new PaymentProviderRequestError(
        `Razorpay refund failed (HTTP ${
          response.status
        }): ${describeResponseBody(body)}`,
      );
    }

    // Drain the success body so the connection can be reused.
    await readResponseBody(response);
  }
}
