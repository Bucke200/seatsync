import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shared HMAC-SHA256 helpers for payment webhook verification.
 *
 * Both the fake and Razorpay providers sign the *raw* request body with
 * `PAYMENT_WEBHOOK_SECRET`. The raw `Buffer` is essential: re-serializing a
 * parsed JSON body can change byte order/whitespace and break the signature.
 */

/** Hex-encoded HMAC-SHA256 of `rawBody` keyed by `secret`. */
export function computeHmacSha256Hex(rawBody: Buffer, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time comparison of a webhook signature against the HMAC of the raw
 * body. Missing, blank or wrong-length signatures are rejected without
 * touching the digest comparison.
 */
export function verifyHmacSha256Hex(
  rawBody: Buffer,
  secret: string,
  signature: string | undefined,
): boolean {
  if (signature === undefined) {
    return false;
  }

  const provided = Buffer.from(signature.trim().toLowerCase(), "utf8");
  const expected = Buffer.from(computeHmacSha256Hex(rawBody, secret), "utf8");

  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}
