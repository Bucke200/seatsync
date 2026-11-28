import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Redis } from "ioredis";
import type { Pool } from "pg";
import swaggerUi from "swagger-ui-express";
import { loadConfig, type Config } from "./config";
import { errorHandler } from "./middleware/errors";
import type { HoldsRateLimiter } from "./middleware/rateLimit";
import { requestIdMiddleware } from "./middleware/requestId";
import { generateOpenApiDocument } from "./openapi";
import { createAuthRouter } from "./routes/auth";
import { createBookingsRouter } from "./routes/bookings";
import { createEventsRouter } from "./routes/events";
import { createHealthRouter } from "./routes/health";
import { createHoldsRouter } from "./routes/holds";
import { createWebhooksRouter } from "./routes/webhooks";

export interface AppDependencies {
  pool: Pool;
  redis: Redis;
  /** Defaults to `loadConfig(process.env)` so existing call sites keep working. */
  config?: Config;
  /**
   * D33 rate limiter. `server.ts` creates it so it can close the dedicated
   * Redis connection during shutdown; tests may inject one to control its
   * client. When omitted, the holds router creates its own.
   */
  holdsRateLimiter?: HoldsRateLimiter;
}

/**
 * Build the Express app from injected dependencies so tests can supply their
 * own Postgres pool and Redis client without importing the server entrypoint.
 */
export function createApp({
  pool,
  redis,
  config = loadConfig(process.env),
  holdsRateLimiter,
}: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  // Request IDs are assigned first so every response, including rejected ones,
  // still carries `X-Request-Id`.
  app.use(requestIdMiddleware);

  // D34: security headers on every response. The only deviation from helmet's
  // defaults is `upgrade-insecure-requests`: Swagger UI (`/docs`) loads its
  // same-origin bundle over http in local development, and the default
  // directive rewrites those asset requests to https where nothing listens.
  // HSTS covers the production HTTPS deployment, so dropping this one
  // directive is enough; every other default (CSP with `default-src 'self'`,
  // nosniff, frame denial, referrer policy, HSTS) stays on.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: { "upgrade-insecure-requests": null },
      },
    }),
  );

  // D34/design §364: allowlist from CORS_ORIGINS, never a `*` wildcard. For a
  // non-matching origin the cors package omits `Access-Control-Allow-Origin`
  // (the header that grants access), so the browser exposes nothing and sends
  // no credentialed request. Credentials are enabled for the refresh-token
  // cookie flow. Mounted before body parsing so preflight OPTIONS requests
  // never allocate a body parser.
  app.use(cors({ origin: config.CORS_ORIGINS, credentials: true }));

  // D22: the webhook HMAC is computed over the exact delivered bytes. Mount
  // the raw parser (and the webhook router) before `express.json()` so only
  // `/webhooks/*` gets a Buffer; JSON body parsing stays on for every other
  // route. body-parser marks the request as parsed, so express.json() skips
  // these requests instead of reserializing them. The raw parser keeps its
  // default 100kb limit, so oversized webhook deliveries get the same 413
  // mapping as oversized JSON bodies.
  app.use("/webhooks", express.raw({ type: "*/*" }));
  app.use("/webhooks", createWebhooksRouter(pool, config));

  // D34: bound JSON request bodies. body-parser raises `entity.too.large`
  // (status 413) past the limit; `errorHandler` maps it to
  // `413 PAYLOAD_TOO_LARGE` instead of the generic 500 fallback.
  app.use(express.json({ limit: "100kb" }));
  app.use(cookieParser());
  app.use("/health", createHealthRouter({ pool, redis }));
  app.use("/auth", createAuthRouter(pool, config));
  app.use("/events", createEventsRouter(pool, config));
  // Two prefixes under one router (`/events/{id}/holds`, `/holds/{id}`). The
  // limiter is created per app and applied only to the POST path inside.
  const holds = createHoldsRouter(pool, config, holdsRateLimiter);
  app.use(holds.router);
  // Expose the effective limiter (injected or created here) for tests and
  // diagnostics; `server.ts` owns the production instance and closes it.
  app.locals["holdsRateLimiter"] = holds.rateLimiter;
  // `/holds/{id}/checkout` (Step 3); booking reads join this router in Step 5.
  app.use(createBookingsRouter(pool, config));

  const openApiDocument = generateOpenApiDocument();
  const swaggerHtml = swaggerUi.generateHTML(openApiDocument);

  app.get("/docs.json", (_req, res) => {
    res.json(openApiDocument);
  });
  // Serve /docs (no trailing slash) directly so Swagger UI answers 200 instead
  // of swaggerUi.serve redirecting to /docs/ with a 301.
  app.get("/docs", (_req, res) => {
    res.type("html").send(swaggerHtml);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use(errorHandler);

  return app;
}
