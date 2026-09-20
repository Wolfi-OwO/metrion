import type { NextFunction, Request, Response } from 'express';
import { z, type ZodError, type ZodIssue, type ZodType } from 'zod';
import type { FieldIssue } from './error.js';
import { ValidationError } from './error.js';

/**
 * One issue per failed field, dot-joining the path so it reads as
 * `metrics.0.value`.
 *
 * Union issues are flattened rather than reported as-is. A `z.union` reports
 * only `{ path: '', message: 'Invalid input' }` at the top level and hides the
 * real per-field failures in `issue.errors`, one array per branch - so a
 * malformed ingest body came back as a 400 that named no field at all, which
 * is exactly what a validation error is supposed to avoid. Flattened here, at
 * the one place every route's validation passes through, rather than in the
 * one schema that happens to be a union today.
 */
function toFieldIssues(error: ZodError): FieldIssue[] {
  const issues: FieldIssue[] = [];

  const walk = (candidates: readonly ZodIssue[], prefix: readonly PropertyKey[]): void => {
    for (const issue of candidates) {
      const path = [...prefix, ...issue.path];
      if (issue.code === 'invalid_union') {
        for (const branch of issue.errors) walk(branch, path);
        continue;
      }
      // Zod's message for an unrecognised key quotes the key names back, so a
      // request to `?secret=x&token=y` answered with `Unrecognized keys:
      // "secret", "token"` puts a fragment of the caller's query string into a
      // response body. Harmless in itself - it is their own input - but "no
      // query strings in an error body" is a rule this pipeline keeps whole
      // rather than case by case, and the caller learns nothing from the names
      // they just sent.
      const message =
        issue.code === 'unrecognized_keys' ? 'Unrecognized keys in the request.' : issue.message;
      issues.push({ path: path.map(String).join('.'), message });
    }
  };

  walk(error.issues, []);

  // Two union branches can fail on the same field for the same reason; report
  // it once.
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Validates `req.body` and replaces it with the parsed result, so a handler
 * mounted behind this can trust its shape instead of re-checking it. The
 * schema is the single source of truth: unknown keys are stripped by the
 * schema's own `.strict()`/shape, never forwarded to a handler.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return function validate(req: Request, _res: Response, next: NextFunction): void {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      next(new ValidationError(toFieldIssues(result.error)));
      return;
    }
    req.body = result.data;
    next();
  };
}

/** The same for `req.query`. */
export function validateQuery<T>(schema: ZodType<T>) {
  return function validate(req: Request, _res: Response, next: NextFunction): void {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      next(new ValidationError(toFieldIssues(result.error)));
      return;
    }
    // Express 4 lets `req.query` be reassigned; Express 5 makes it a getter,
    // which is one of the reasons this app is pinned to 4.
    req.query = result.data as Request['query'];
    next();
  };
}

/**
 * The same for `req.params`. Not reassigned (Express re-populates `params` per
 * route layer); it only rejects. Without it a malformed uuid reaches Postgres
 * and comes back as a 500 (`invalid input syntax for type uuid`).
 */
export function validateParams<T>(schema: ZodType<T>) {
  return function validate(req: Request, _res: Response, next: NextFunction): void {
    const result = schema.safeParse(req.params);
    if (!result.success) {
      next(new ValidationError(toFieldIssues(result.error)));
      return;
    }
    next();
  };
}

/** Every `:id` route in this app is a uuid. */
export const uuidIdParams = validateParams(z.object({ id: z.uuid() }));
