import { describe, expect, it } from "@jest/globals";
import { loadConfig } from "../src/config";

const REQUIRED_ENV = {
  DATABASE_URL: "postgres://seatsync:seatsync@localhost:5434/seatsync",
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
