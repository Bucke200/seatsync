import type { Config } from "../config";
import { FakePaymentProvider } from "./fake";
import { RazorpayPaymentProvider } from "./razorpay";

/**
 * Payment provider abstraction (D20).
 *
 * The rest of the API depends only on this interface. Selection is driven by
 * `PAYMENT_PROVIDER` in `config.ts`: `fake` is the deterministic provider every
 * automated test uses, `razorpay` is the real sandbox/live provider.
 */

export type WebhookEventType = "payment_succeeded" | "checkout_expired";

export interface CreateCheckoutInput {
  bookingId: string;
  holdId: string;
  /** Integer paise (Rule 6). */
  amountPaise: number;
}

export interface CreateCheckoutResult {
  checkoutUrl: string;
}

export interface VerifiedWebhookEvent {
  /** Stable provider event id used for `processed_webhooks` de-duplication. */
  eventId: string;
  type: WebhookEventType;
  bookingId: string;
  holdId?: string;
  /** Provider payment id (refund target), or null for expiry events. */
  paymentRef: string | null;
}

export interface PaymentProvider {
  createCheckout(input: CreateCheckoutInput): Promise<CreateCheckoutResult>;

  /**
   * Verify authenticity and normalize the provider payload.
   *
   * Throws `WebhookVerificationError` on a bad signature, malformed JSON or an
   * unsupported event. The route maps every throw to `400` and writes nothing.
   */
  verifyWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): VerifiedWebhookEvent;

  /** Refund `amountPaise` (integer paise). Throws on failure so callers retry. */
  refund(paymentRef: string, amountPaise: number): Promise<void>;

  /**
   * Test-only seam (D20a, doc-unspecified). The webhook transaction invokes
   * this once between the `processed_webhooks` insert and the booking lock.
   * Only `FakePaymentProvider` implements it, so real providers never observe
   * it; with no error armed it does nothing.
   */
  runAfterDedupeHook?(): void;
}

export type PaymentProviderConfig = Pick<
  Config,
  | "PAYMENT_PROVIDER"
  | "PAYMENT_WEBHOOK_SECRET"
  | "RAZORPAY_KEY_ID"
  | "RAZORPAY_KEY_SECRET"
>;

/**
 * Build the configured provider. `config.ts` already fails fast when
 * `PAYMENT_PROVIDER=razorpay` lacks keys; the guard here keeps direct callers
 * (tests, future jobs) equally safe.
 */
export function createPaymentProvider(
  config: PaymentProviderConfig,
): PaymentProvider {
  switch (config.PAYMENT_PROVIDER) {
    case "fake":
      return new FakePaymentProvider(config.PAYMENT_WEBHOOK_SECRET);

    case "razorpay": {
      const keyId = config.RAZORPAY_KEY_ID;
      const keySecret = config.RAZORPAY_KEY_SECRET;

      if (keyId === undefined || keySecret === undefined) {
        throw new Error(
          "RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are required when PAYMENT_PROVIDER is razorpay",
        );
      }

      return new RazorpayPaymentProvider({
        keyId,
        keySecret,
        webhookSecret: config.PAYMENT_WEBHOOK_SECRET,
      });
    }

    case "stripe":
      throw new Error(
        "PAYMENT_PROVIDER=stripe is not implemented; use fake or razorpay",
      );

    default: {
      const unsupported: never = config.PAYMENT_PROVIDER;
      throw new Error(`Unsupported PAYMENT_PROVIDER: ${String(unsupported)}`);
    }
  }
}

export {
  createFakeWebhook,
  FakePaymentProvider,
  fakePaymentControls,
  FAKE_SIGNATURE_HEADER,
  signFakeWebhook,
} from "./fake";
export type {
  FakePaymentControls,
  FakeRefundCall,
  FakeWebhookPayload,
} from "./fake";
export {
  RAZORPAY_SIGNATURE_HEADER,
  RazorpayPaymentProvider,
} from "./razorpay";
export type { RazorpayProviderOptions } from "./razorpay";
export {
  PaymentProviderRequestError,
  WebhookVerificationError,
} from "./errors";
