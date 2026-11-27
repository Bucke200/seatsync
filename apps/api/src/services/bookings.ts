import type { Pool } from "pg";
import type { Config } from "../config";
import { createCheckoutForHold } from "../db/bookings";
import { ApiError } from "../middleware/errors";
import { createPaymentProvider } from "../payments";

/**
 * Checkout orchestration (D21). Thin on purpose: the transaction, locking and
 * SQL live in `db/bookings.ts`; this layer only builds the configured provider
 * and turns `created` into the HTTP status (201 new, 200 replayed).
 */

export interface CheckoutHoldInput {
  holdId: string;
  userId: string;
}

export interface CheckoutHoldOutcome {
  statusCode: 200 | 201;
  body: {
    bookingId: string;
    checkoutUrl: string;
  };
}

export async function checkoutHold(
  pool: Pool,
  config: Config,
  input: CheckoutHoldInput,
): Promise<CheckoutHoldOutcome> {
  let provider: ReturnType<typeof createPaymentProvider>;

  try {
    provider = createPaymentProvider(config);
  } catch {
    // A misconfigured/unimplemented provider is the provider's fault, not the
    // caller's; keep the response shape identical to a mid-transaction failure.
    throw new ApiError(
      502,
      "PROVIDER_ERROR",
      `Payment provider (${config.PAYMENT_PROVIDER}) is not available`,
    );
  }

  const result = await createCheckoutForHold(pool, config, provider, input);

  return {
    statusCode: result.created ? 201 : 200,
    body: {
      bookingId: result.bookingId,
      checkoutUrl: result.checkoutUrl,
    },
  };
}
