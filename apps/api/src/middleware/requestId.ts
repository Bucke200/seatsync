import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { Logger } from "pino";
import { logger } from "../logger";

declare module "express-serve-static-core" {
  interface Request {
    /** Correlation ID taken from the incoming `x-request-id` header or generated. */
    id: string;
    /** Request-scoped logger with `requestId` already bound. */
    log: Logger;
  }
}

/**
 * Assign every request a correlation ID, echo it in `X-Request-Id`, attach a
 * child logger and log the completed request with that ID.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incomingRequestId = req.header("x-request-id")?.trim();
  const requestId =
    incomingRequestId !== undefined && incomingRequestId.length > 0
      ? incomingRequestId
      : randomUUID();

  req.id = requestId;
  req.log = logger.child({ requestId });
  res.setHeader("X-Request-Id", requestId);

  const startedAt = performance.now();

  res.once("finish", () => {
    req.log.info(
      {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "request completed",
    );
  });

  next();
}
