/**
 * A webhook failed authenticity or payload validation.
 *
 * `POST /webhooks/:provider` maps this to `400 WEBHOOK_SIGNATURE_INVALID` and
 * performs no database writes (D22). Nothing is retried: a forged or malformed
 * delivery must never be persisted.
 */
export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * A provider REST call (create checkout, refund) failed.
 *
 * Refund callers let this propagate so the retry job can claim the booking
 * again on its next run; checkout callers surface it as a 5xx/502.
 */
export class PaymentProviderRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentProviderRequestError";
  }
}
