import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  createFakeWebhook,
  createPaymentProvider,
  FakePaymentProvider,
  fakePaymentControls,
  RazorpayPaymentProvider,
  signFakeWebhook,
  type PaymentProvider,
  WebhookVerificationError,
} from "../../src/payments";

const SECRET = "test-webhook-secret";
const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const HOLD_ID = "22222222-2222-4222-8222-222222222222";

const FAKE_PAYLOAD = {
  eventId: "evt_fake_success_1",
  type: "payment_succeeded" as const,
  bookingId: BOOKING_ID,
  holdId: HOLD_ID,
  paymentRef: "pay_fake_1",
};

function fakeProvider(): FakePaymentProvider {
  return new FakePaymentProvider(SECRET);
}

function razorpayProvider(): RazorpayPaymentProvider {
  return new RazorpayPaymentProvider({
    keyId: "rzp_test_key_id",
    keySecret: "rzp_test_key_secret",
    webhookSecret: SECRET,
  });
}

interface RazorpaySampleInput {
  event: string;
  paymentId?: string;
  notes?: Record<string, unknown> | null;
}

/**
 * Minimal realistic Payment Links webhook body. A real `payment_link.paid`
 * delivery also contains `order` + `payment`; the provider only needs the
 * event name, the payment id and the link's `notes`.
 */
function razorpayWebhookBody({
  event,
  paymentId,
  notes = { bookingId: BOOKING_ID, holdId: HOLD_ID },
}: RazorpaySampleInput): Buffer {
  return Buffer.from(
    JSON.stringify({
      account_id: "acc_test",
      contains: paymentId === undefined ? ["payment_link"] : ["payment_link", "order", "payment"],
      created_at: 1_749_618_314,
      entity: "event",
      event,
      payload: {
        ...(paymentId === undefined
          ? {}
          : { payment: { entity: { id: paymentId, status: "captured" } } }),
        payment_link: {
          entity: {
            id: "plink_TEST123",
            short_url: "https://rzp.io/rzp/test",
            notes,
          },
        },
      },
    }),
    "utf8",
  );
}

/** Independently sign with the webhook secret, as Razorpay's servers do. */
function signRazorpay(rawBody: Buffer): string {
  return createHmac("sha256", SECRET).update(rawBody).digest("hex");
}

beforeEach(() => {
  fakePaymentControls.reset();
});

describe("fake payment provider", () => {
  it("returns a deterministic checkout URL and keeps money in integer paise", async () => {
    const provider = fakeProvider();

    await expect(
      provider.createCheckout({
        bookingId: BOOKING_ID,
        holdId: HOLD_ID,
        amountPaise: 12_500,
      }),
    ).resolves.toEqual({
      checkoutUrl: `/bookings/${BOOKING_ID}?fakeCheckout=1`,
    });
  });

  it("accepts a correctly signed webhook", () => {
    const { rawBody, signature } = createFakeWebhook(FAKE_PAYLOAD, SECRET);

    expect(fakeProvider().verifyWebhook(rawBody, signature)).toEqual(
      FAKE_PAYLOAD,
    );
  });

  it("rejects a tampered body with a valid-looking signature", () => {
    const { signature } = createFakeWebhook(FAKE_PAYLOAD, SECRET);
    const tampered = Buffer.from(
      JSON.stringify({ ...FAKE_PAYLOAD, paymentRef: "pay_tampered" }),
      "utf8",
    );

    expect(() => fakeProvider().verifyWebhook(tampered, signature)).toThrow(
      WebhookVerificationError,
    );
  });

  it("rejects a missing signature", () => {
    const { rawBody } = createFakeWebhook(FAKE_PAYLOAD, SECRET);

    expect(() => fakeProvider().verifyWebhook(rawBody, undefined)).toThrow(
      /Invalid fake webhook signature/,
    );
  });

  it("rejects an unknown event type even when signed", () => {
    const rawBody = Buffer.from(
      JSON.stringify({ ...FAKE_PAYLOAD, type: "payment_failed" }),
      "utf8",
    );

    expect(() =>
      fakeProvider().verifyWebhook(rawBody, signFakeWebhook(rawBody, SECRET)),
    ).toThrow(/Invalid fake webhook payload/);
  });

  it("records refund attempts and injects exactly one failure", async () => {
    const provider = fakeProvider();
    fakePaymentControls.failNextRefund();

    await expect(provider.refund("pay_fake_1", 1_000)).rejects.toThrow(
      /injected refund failure/,
    );
    await expect(provider.refund("pay_fake_1", 1_000)).resolves.toBeUndefined();

    expect(fakePaymentControls.refundCalls).toEqual([
      { paymentRef: "pay_fake_1", amountPaise: 1_000 },
      { paymentRef: "pay_fake_1", amountPaise: 1_000 },
    ]);
  });

  it("rejects non-integer paise without recording a refund", async () => {
    await expect(fakeProvider().refund("pay_fake_1", 12.5)).rejects.toThrow(
      /Rule 6/,
    );

    expect(fakePaymentControls.refundCalls).toHaveLength(0);
  });

  it("exposes a one-shot after-dedupe failure seam that real providers omit", () => {
    const provider = fakeProvider();
    fakePaymentControls.failAfterDedupe();

    expect(() => provider.runAfterDedupeHook()).toThrow(
      /post-dedupe failure/,
    );
    expect(() => provider.runAfterDedupeHook()).not.toThrow();

    const realProvider: PaymentProvider = razorpayProvider();
    expect(realProvider.runAfterDedupeHook).toBeUndefined();
  });
});

describe("razorpay payment provider", () => {
  it("verifies a valid X-Razorpay-Signature and maps payment_link.paid", () => {
    const rawBody = razorpayWebhookBody({
      event: "payment_link.paid",
      paymentId: "pay_TEST123",
    });

    expect(razorpayProvider().verifyWebhook(rawBody, signRazorpay(rawBody))).toEqual({
      eventId:
        "razorpay:payment_link.paid:plink_TEST123:pay_TEST123",
      type: "payment_succeeded",
      bookingId: BOOKING_ID,
      holdId: HOLD_ID,
      paymentRef: "pay_TEST123",
    });
  });

  it("maps payment_link.expired to checkout_expired with no paymentRef", () => {
    const rawBody = razorpayWebhookBody({ event: "payment_link.expired" });

    expect(razorpayProvider().verifyWebhook(rawBody, signRazorpay(rawBody))).toEqual({
      eventId: "razorpay:payment_link.expired:plink_TEST123",
      type: "checkout_expired",
      bookingId: BOOKING_ID,
      holdId: HOLD_ID,
      paymentRef: null,
    });
  });

  it("maps payment_link.cancelled to checkout_expired", () => {
    const rawBody = razorpayWebhookBody({ event: "payment_link.cancelled" });

    expect(razorpayProvider().verifyWebhook(rawBody, signRazorpay(rawBody))).toEqual({
      eventId: "razorpay:payment_link.cancelled:plink_TEST123",
      type: "checkout_expired",
      bookingId: BOOKING_ID,
      holdId: HOLD_ID,
      paymentRef: null,
    });
  });

  it("rejects a bad signature", () => {
    const rawBody = razorpayWebhookBody({
      event: "payment_link.paid",
      paymentId: "pay_TEST123",
    });
    const wrongSignature = signRazorpay(
      Buffer.from(JSON.stringify({ tampered: true }), "utf8"),
    );

    expect(() =>
      razorpayProvider().verifyWebhook(rawBody, wrongSignature),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects a missing signature", () => {
    const rawBody = razorpayWebhookBody({
      event: "payment_link.paid",
      paymentId: "pay_TEST123",
    });

    expect(() => razorpayProvider().verifyWebhook(rawBody, undefined)).toThrow(
      /Invalid Razorpay webhook signature/,
    );
  });

  it("rejects payment_link.partially_paid as an unsupported event", () => {
    const rawBody = razorpayWebhookBody({
      event: "payment_link.partially_paid",
      paymentId: "pay_PARTIAL",
    });

    expect(() =>
      razorpayProvider().verifyWebhook(rawBody, signRazorpay(rawBody)),
    ).toThrow(/Unsupported Razorpay webhook event/);
  });

  it("rejects a paid event without the payment entity", () => {
    const rawBody = razorpayWebhookBody({ event: "payment_link.paid" });

    expect(() =>
      razorpayProvider().verifyWebhook(rawBody, signRazorpay(rawBody)),
    ).toThrow(/missing the payment entity/);
  });

  it("rejects notes without a valid bookingId", () => {
    const rawBody = razorpayWebhookBody({
      event: "payment_link.expired",
      notes: { holdId: HOLD_ID },
    });

    expect(() =>
      razorpayProvider().verifyWebhook(rawBody, signRazorpay(rawBody)),
    ).toThrow(/missing a valid bookingId/);
  });
});

describe("createPaymentProvider", () => {
  it("builds the fake provider by default", () => {
    const provider = createPaymentProvider({
      PAYMENT_PROVIDER: "fake",
      PAYMENT_WEBHOOK_SECRET: SECRET,
    });

    expect(provider).toBeInstanceOf(FakePaymentProvider);
  });

  it("builds the razorpay provider when both keys are configured", () => {
    const provider = createPaymentProvider({
      PAYMENT_PROVIDER: "razorpay",
      PAYMENT_WEBHOOK_SECRET: SECRET,
      RAZORPAY_KEY_ID: "rzp_test_key_id",
      RAZORPAY_KEY_SECRET: "rzp_test_key_secret",
    });

    expect(provider).toBeInstanceOf(RazorpayPaymentProvider);
  });

  it("refuses razorpay without keys", () => {
    expect(() =>
      createPaymentProvider({
        PAYMENT_PROVIDER: "razorpay",
        PAYMENT_WEBHOOK_SECRET: SECRET,
      }),
    ).toThrow(/RAZORPAY_KEY_ID/);
  });

  it("refuses the unimplemented stripe provider", () => {
    expect(() =>
      createPaymentProvider({
        PAYMENT_PROVIDER: "stripe",
        PAYMENT_WEBHOOK_SECRET: SECRET,
      }),
    ).toThrow(/not implemented/);
  });
});
