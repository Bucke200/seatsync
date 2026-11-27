import type { Pool } from "pg";
import type { Config } from "../config";
import {
  processWebhookEvent,
  type ProcessWebhookEventResult,
} from "../db/bookings";
import { refundRefundableBookings } from "../jobs/retryRefunds";
import { logger } from "../logger";
import { ApiError } from "../middleware/errors";
import {
  createPaymentProvider,
  FAKE_SIGNATURE_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
  type PaymentProvider,
  type VerifiedWebhookEvent,
} from "../payments";

/**
 * Webhook orchestration (D22, D23, D24).
 *
 * The route hands us the exact raw bytes and the provider's signature header.
 * Verification happens before any database work; the Rule 4/Rule 2 transaction
 * lives in `db/bookings.ts`. The post-COMMIT refund trigger is awaited here so
 * tests observe a deterministic REFUNDED state by the time the 200 arrives.
 */

/**
 * Which header carries the HMAC for each provider. The fake provider is the
 * default because it is the only offline implementation; `razorpay` uses its
 * documented header. Express header lookups are case-insensitive.
 */
export function webhookSignatureHeader(providerName: string): string {
  return providerName === "razorpay"
    ? RAZORPAY_SIGNATURE_HEADER
    : FAKE_SIGNATURE_HEADER;
}

/**
 * Resolve `POST /webhooks/:provider` against the configured provider.
 *
 * The path selector must equal `PAYMENT_PROVIDER`: a webhook URL for another
 * provider is a client error, never a silent fallback. `stripe` is accepted by
 * config validation but unimplemented by `createPaymentProvider`, so its
 * factory error maps to the same distinct `UNKNOWN_PROVIDER` 400. This is the
 * doc-unspecified status decision for step 4 (the doc only specifies 400 for
 * bad signatures).
 */
export function resolveWebhookProvider(
  config: Config,
  providerName: string,
): PaymentProvider {
  if (providerName !== config.PAYMENT_PROVIDER) {
    throw new ApiError(
      400,
      "UNKNOWN_PROVIDER",
      `Unknown payment provider: ${providerName}`,
    );
  }

  try {
    return createPaymentProvider(config);
  } catch {
    throw new ApiError(
      400,
      "UNKNOWN_PROVIDER",
      `Payment provider ${providerName} is not available`,
    );
  }
}

/**
 * D22/D23: every verification failure (bad signature, malformed body,
 * unsupported event) is the same 400 with zero DB writes. The underlying
 * provider error is intentionally not echoed.
 */
function verifyWebhookDelivery(
  provider: PaymentProvider,
  rawBody: Buffer,
  signature: string | undefined,
): VerifiedWebhookEvent {
  try {
    return provider.verifyWebhook(rawBody, signature);
  } catch {
    throw new ApiError(
      400,
      "WEBHOOK_SIGNATURE_INVALID",
      "Webhook signature verification failed",
    );
  }
}

export interface WebhookDeliveryInput {
  providerName: string;
  rawBody: Buffer;
  signature: string | undefined;
}

/**
 * Verify one delivery, process it in the Rule 4/Rule 2 transaction, then (only
 * if the transaction asked for it) refund the FAILED booking AFTER COMMIT. A
 * refund failure never changes the HTTP result: the booking remains FAILED and
 * `retryRefunds` retries it.
 */
export async function handleWebhookDelivery(
  pool: Pool,
  config: Config,
  input: WebhookDeliveryInput,
): Promise<ProcessWebhookEventResult> {
  const provider = resolveWebhookProvider(config, input.providerName);
  const event = verifyWebhookDelivery(
    provider,
    input.rawBody,
    input.signature,
  );
  const result = await processWebhookEvent(pool, config, provider, event);

  if (result.refundBookingId !== null) {
    try {
      await refundRefundableBookings(pool, config, provider, {
        onlyBookingId: result.refundBookingId,
      });
    } catch (error) {
      logger.error(
        { err: error, bookingId: result.refundBookingId },
        "post-commit refund trigger failed; retry job will retry it",
      );
    }
  }

  return result;
}
