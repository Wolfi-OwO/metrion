import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { isProduction } from '../config/index.js';

/**
 * HTTP error classes plus the terminal handler that maps them to a status
 * code and a JSON body. Throw one anywhere; `asyncHandler` makes sure a
 * rejected promise gets here too.
 *
 * Same shape as `applications/viewer/src/middlewares/error.ts` - this app
 * reuses that pattern rather than inventing a second one.
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

export class TooManyRequestsError extends AppError {
  constructor(message = 'Too Many Requests') {
    super(429, message);
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

  // Middleware this app did not write also throws - body-parser is the one
  // that matters: a malformed JSON body and a body over the size cap both
  // arrive here as plain errors carrying `status`/`statusCode` (400 and 413).
  // Without this branch both came back as 500 - the caller was told the
  // server had broken when it was their request that was wrong. Only 4xx is
  // honoured: a third-party 5xx stays an opaque 500.
  const status =
    (err as { status?: unknown; statusCode?: unknown } | null)?.status ??
    (err as { statusCode?: unknown } | null)?.statusCode;
  const message = err instanceof Error ? err.message : 'Internal server error';

  if (typeof status === 'number' && status >= 400 && status < 500) {
    res.status(status).json({
      error: 'RequestError',
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
