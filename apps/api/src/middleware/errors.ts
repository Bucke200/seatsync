import type { ErrorResponse } from "@seatsync/shared";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError } from "zod";

/**
 * Error with an HTTP status and a stable machine-readable code. Thrown by
 * middleware, services and db helpers; serialized by `errorHandler`.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Express 4 does not await async handlers, so rejected promises must be
 * forwarded to `next` explicitly or the request hangs.
 */
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}

function toResponse(error: ApiError): ErrorResponse {
  const response: ErrorResponse = {
    error: {
      code: error.code,
      message: error.message,
    },
  };

  if (error.details !== undefined) {
    response.error.details = error.details;
  }

  return response;
}

/**
 * Single place that turns thrown values into the documented error shape:
 * `{ error: { code, message, details? } }`.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.statusCode).json(toResponse(error));
    return;
  }

  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: error.issues,
      },
    } satisfies ErrorResponse);
    return;
  }

  // body-parser throws a SyntaxError for malformed JSON. Never log it: the
  // error carries the raw request body, which may contain credentials.
  if (error instanceof SyntaxError) {
    res.status(400).json({
      error: {
        code: "INVALID_JSON",
        message: "Invalid JSON body",
      },
    } satisfies ErrorResponse);
    return;
  }

  req.log.error({ err: error }, "unhandled request error");
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error",
    },
  } satisfies ErrorResponse);
}
