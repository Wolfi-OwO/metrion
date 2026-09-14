import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isProduction } from '../config/index.js';

/**
 * HTTP error classes plus the terminal handler that maps them to a status
 * code and a JSON body. Throw one anywhere; `asyncHandler` makes sure a
 * rejected promise gets here too.
 */
export class AppError extends Error {
  readonly statusCode: number;
  /** Whether the message is safe to send to a client (4xx) or hidden in production (5xx). */
  readonly expose: boolean;

  constructor(statusCode: number, message: string, expose = statusCode < 500) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.expose = expose;
  }
}

export class BadRequestError extends AppError {
  constructor(message = 'Bad Request') {
    super(400, message);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(401, message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not Found') {
    super(404, message);
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = 'Service Unavailable') {
    super(503, message);
  }
}

/** A unique-key clash or a dependency cycle - both name a conflict with
 * existing state rather than a malformed request, so 409 rather than 400. */
export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(409, message);
  }
}

/** One field-level validation failure. `path` is dot-joined, e.g. `metrics.0.value`. */
export interface FieldIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Raised by `middlewares/validate.ts`. Carries per-field detail so a 400
 * names the field that failed instead of just "bad request".
 */
export class ValidationError extends BadRequestError {
  readonly issues: readonly FieldIssue[];

  constructor(issues: readonly FieldIssue[]) {
    super('Validation failed.');
    this.issues = issues;
  }
}

/**
 * 404 for anything unmatched. The message carries the method but NOT the URL:
 * echoing `req.originalUrl` back would put the request path and query string
 * into a response body (and into any log that records it), which is exactly
 * what the privacy rules exclude everywhere else in this pipeline.
 */
export function notFound(req: Request, _res: Response, next: NextFunction): void {
  next(new NotFoundError(`No route matches this ${req.method} request.`));
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: err.name,
      message: err.expose || !isProduction ? err.message : 'Internal Server Error',
      statusCode: err.statusCode,
      ...(err instanceof ValidationError ? { issues: err.issues } : {}),
    });
    return;
  }

  // Middleware this app did not write also throws, and body-parser is the one
  // that matters: a malformed JSON body and a body over the 256 kB cap both
  // arrive here as plain errors carrying `status`/`statusCode` (400 and 413).
  // Without this branch both came back as 500 - the caller was told the server
  // had broken when it was their request that was wrong, the 413 never
  // revealed that a size cap exists, and every malformed request a scanner
  // sends showed up in the 5xx rate that a real outage has to stand out from.
  // Only 4xx is honoured: a third-party 5xx stays an opaque 500.
  const status =
    (err as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (err as { statusCode?: unknown } | null)?.statusCode;
  const message = err instanceof Error ? err.message : 'Internal server error';

  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({
      // Not `BadRequestError`: this branch also carries 413 from the body size
      // cap, and naming every one of them "bad request" would put a wrong
      // label next to a right status code.
      error: 'RequestError',
      // The body-parser message quotes the offending fragment of the request,
      // so it is echoed only outside production, same rule as every other
      // non-AppError message here.
      message: isProduction ? 'Bad Request' : message,
      statusCode: status,
    });
    return;
  }

  res.status(500).json({
    error: 'InternalServerError',
    message: isProduction ? 'Internal Server Error' : message,
    statusCode: 500,
  });
}

/** Wraps a handler so a rejected promise reaches `errorHandler` instead of hanging the request. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
