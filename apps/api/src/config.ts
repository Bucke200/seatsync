import { z } from "zod";

/**
 * Typed, fail-fast environment configuration for the SeatSync API.
 *
 * Every tunable value from the SeatSync Config table is read here. Nothing in
 * this file may be bypassed with a hard-coded value elsewhere in the API: call
 * `loadConfig()` once at startup and pass the resulting object around.
 */

const DEFAULT_CORS_ORIGINS = "http://localhost:3000";

const paymentProviderSchema = z.enum(["stripe", "razorpay", "fake"]);

const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const configSchema = z
  .object({
    DATABASE_URL: z.string().min(1, "must not be empty"),
    REDIS_URL: z.string().min(1, "must not be empty"),
    DB_POOL_SIZE: positiveInteger(20),
    JWT_SECRET: z.string().min(1, "must not be empty"),
    ACCESS_TOKEN_TTL_SECONDS: positiveInteger(900),
    REFRESH_TOKEN_TTL_SECONDS: positiveInteger(1_209_600),
    HOLD_TTL_SECONDS: positiveInteger(600),
    SWEEPER_INTERVAL_SECONDS: positiveInteger(30),
    MAX_SEATS_PER_HOLD: positiveInteger(6),
    PAYMENT_PROVIDER: paymentProviderSchema.default("fake"),
    PAYMENT_WEBHOOK_SECRET: z.string().min(1, "must not be empty"),
    /**
     * Razorpay API credentials (D19). Optional for every other provider and
     * required only when PAYMENT_PROVIDER=razorpay, enforced by the
     * superRefine below so the fake provider stays usable without sandbox keys.
     */
    RAZORPAY_KEY_ID: z.string().min(1, "must not be empty").optional(),
    RAZORPAY_KEY_SECRET: z.string().min(1, "must not be empty").optional(),
    HOLDS_RATE_LIMIT_PER_MINUTE: positiveInteger(20),
    CORS_ORIGINS: z
      .string()
      .default(DEFAULT_CORS_ORIGINS)
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter((origin) => origin.length > 0),
      )
      .refine((origins) => origins.length > 0, {
        message: "must contain at least one origin",
      }),
    /**
     * Doc-unspecified env addition: the hosted web origin. When set, Razorpay
     * Payment Links receive a `callback_url` so a paid customer lands back on
     * `<WEB_URL>/bookings/<id>` instead of Razorpay's own confirmation page.
     * Unset (or blank, dropped by `normalizeEnv`) sends no callback. This only
     * changes the provider request body; there is no API contract change.
     */
    WEB_URL: z.string().url().optional(),
    LIVE_UPDATE_MAX_MS: positiveInteger(1_000),
    RETENTION_DAYS: positiveInteger(30),
  })
  .superRefine((config, ctx) => {
    if (config.PAYMENT_PROVIDER !== "razorpay") {
      return;
    }

    // `normalizeEnv` drops blank values, so undefined here also covers "" and
    // whitespace-only input.
    if (config.RAZORPAY_KEY_ID === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RAZORPAY_KEY_ID"],
        message: "is required when PAYMENT_PROVIDER is razorpay",
      });
    }

    if (config.RAZORPAY_KEY_SECRET === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["RAZORPAY_KEY_SECRET"],
        message: "is required when PAYMENT_PROVIDER is razorpay",
      });
    }
  });

export type PaymentProvider = z.infer<typeof paymentProviderSchema>;
export type Config = z.infer<typeof configSchema>;

const REQUIRED_VARIABLES = [
  "DATABASE_URL",
  "REDIS_URL",
  "JWT_SECRET",
  "PAYMENT_WEBHOOK_SECRET",
] as const;

type EnvSource = Record<string, string | undefined>;

/** Treat unset, empty and whitespace-only variables as absent so defaults apply. */
function normalizeEnv(env: EnvSource): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string") {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      normalized[name] = trimmed;
    }
  }

  return normalized;
}

/**
 * Validate and coerce the environment. Throws an Error listing every missing
 * required variable, or every invalid value, so a misconfigured process fails
 * at startup instead of at the first request.
 */
export function loadConfig(env: EnvSource = process.env): Config {
  const normalizedEnv = normalizeEnv(env);

  const missing = REQUIRED_VARIABLES.filter(
    (name) => normalizedEnv[name] === undefined,
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        "Copy .env.example to .env and set every required variable before starting the API.",
    );
  }

  const parsed = configSchema.safeParse(normalizedEnv);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const variable =
          issue.path.length > 0 ? issue.path.join(".") : "environment";
        return `  - ${variable}: ${issue.message}`;
      })
      .join("\n");

    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}
