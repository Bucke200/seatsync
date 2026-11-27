import { describe, expect, it } from "@jest/globals";
import { loadConfig } from "../src/config";

const REQUIRED_ENV = {
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://seatsync:seatsync@localhost:5434/seatsync",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "test-jwt-secret",
  PAYMENT_WEBHOOK_SECRET: "test-webhook-secret",
} as const;

/** Run `loadConfig` and return the message it threw, failing if it did not throw. */
function configErrorMessage(env: Record<string, string>): string {
  try {
    loadConfig(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("loadConfig was expected to throw but returned a config");
}

describe("loadConfig", () => {
  it("throws naming every required variable when the environment is empty", () => {
    const message = configErrorMessage({});

    expect(message).toContain("Missing required environment variable(s)");
    for (const variable of Object.keys(REQUIRED_ENV)) {
      expect(message).toContain(variable);
    }
  });

  it("applies the Config-table defaults to a valid environment", () => {
    const config = loadConfig({ ...REQUIRED_ENV });

    expect(config.DB_POOL_SIZE).toBe(20);
    expect(config.HOLD_TTL_SECONDS).toBe(600);
    expect(config.PAYMENT_PROVIDER).toBe("fake");
    expect(config.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("defaults to the fake provider with no Razorpay keys", () => {
    const config = loadConfig({ ...REQUIRED_ENV });

    expect(config.PAYMENT_PROVIDER).toBe("fake");
    expect(config.RAZORPAY_KEY_ID).toBeUndefined();
    expect(config.RAZORPAY_KEY_SECRET).toBeUndefined();
  });

  it("requires both Razorpay keys when the provider is razorpay", () => {
    const message = configErrorMessage({
      ...REQUIRED_ENV,
      PAYMENT_PROVIDER: "razorpay",
    });

    expect(message).toContain("RAZORPAY_KEY_ID");
    expect(message).toContain("RAZORPAY_KEY_SECRET");
    expect(message).toContain("required when PAYMENT_PROVIDER is razorpay");
  });

  it("requires the Razorpay key secret when only the key id is set", () => {
    const message = configErrorMessage({
      ...REQUIRED_ENV,
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_test_key_id",
    });

    expect(message).toContain("RAZORPAY_KEY_SECRET");
    expect(message).not.toContain("RAZORPAY_KEY_ID");
  });

  it("treats a blank Razorpay key as missing", () => {
    const message = configErrorMessage({
      ...REQUIRED_ENV,
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "   ",
      RAZORPAY_KEY_SECRET: "rzp_test_key_secret",
    });

    expect(message).toContain("RAZORPAY_KEY_ID");
    expect(message).not.toContain("RAZORPAY_KEY_SECRET");
  });

  it("accepts the razorpay provider when both keys are set", () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      PAYMENT_PROVIDER: "razorpay",
      RAZORPAY_KEY_ID: "rzp_test_key_id",
      RAZORPAY_KEY_SECRET: "rzp_test_key_secret",
    });

    expect(config.PAYMENT_PROVIDER).toBe("razorpay");
    expect(config.RAZORPAY_KEY_ID).toBe("rzp_test_key_id");
    expect(config.RAZORPAY_KEY_SECRET).toBe("rzp_test_key_secret");
  });

  it("rejects an unknown payment provider", () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, PAYMENT_PROVIDER: "paypal" })).toThrow(
      /PAYMENT_PROVIDER/,
    );
  });

  it("treats an empty required variable as missing", () => {
    const message = configErrorMessage({ ...REQUIRED_ENV, JWT_SECRET: "" });

    expect(message).toContain("Missing required environment variable(s)");
    expect(message).toContain("JWT_SECRET");
  });
});
