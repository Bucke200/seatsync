import pino from "pino";

/**
 * Process-wide pino logger.
 *
 * Per-request loggers are created by the request-id middleware as children of
 * this logger, so every request log line carries the same `requestId` that is
 * returned in the `X-Request-Id` response header.
 */
export const logger = pino({
  name: "seatsync-api",
});
