import type { NextFunction, Request, Response } from 'express';
import { readSessionCookie, resolveSessionUserId } from '../auth/session.js';
import { getPool } from '../lib/db.js';
import { NotFoundError } from './error.js';

/**
 * The seam issue #7 (OAuth accounts / sessions, Task 6) replaces.
 *
 * Before this task there was no session system, so nothing here could
 * resolve "the caller's own projects" from anything real - `req.projectIds`
 * came from one swappable resolver function defaulting to "no projects",
 * the safe failure direction for a scoping bug. That default is gone:
 * `setProjectIdsResolver` below is now called (from `main.ts`) with
 * `resolveProjectIdsFromSession`, which reads the session cookie, resolves
 * it to a user, and lists that user's own projects - an anonymous caller
 * (no cookie, or an invalid one) still resolves to `[]`, so
 * `GET /api/v1/metrics` stays a public endpoint that simply has nothing to
 * show an unauthenticated caller, rather than requiring a session outright.
 *
 * `metrics-service.ts` takes `projectIds` as a plain parameter and never
 * reads a query parameter or session itself, so plugging in the real
 * resolver was the only thing that needed to change - nothing from routes
 * down to the SQL moved.
 *
 * `tests/metrics.test.ts` still uses `setProjectIdsResolver` directly to seed
 * the two-project leakage proof its acceptance criteria call for, overriding
 * the real resolver in-process rather than standing up a real session for
 * every test - the seam this task built on remains useful as a test hook
 * even now that a real implementation exists.
 */
export type ProjectIdsResolver = (req: Request) => string[] | Promise<string[]>;

let currentResolver: ProjectIdsResolver = () => [];

export function setProjectIdsResolver(resolver: ProjectIdsResolver): void {
  currentResolver = resolver;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      projectIds?: string[];
    }
  }
}

export async function resolveProjectIds(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    req.projectIds = await currentResolver(req);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * The real resolver `main.ts` wires in. Ownership, not membership, is the
 * only tenancy relationship `projects` has (`owner_user_id`, one column, no
 * members table) - "the caller's own projects" and "projects this user
 * owns" are the same query.
 */
/**
 * The `?projectId=` narrowing every read route applies on top of
 * `req.projectIds`. `projectId` never bypasses ownership: it can only pick
 * out one entry of the list the session already resolved to, so a caller who
 * names a project they do not own gets the same 404 a made-up id would - the
 * "same 404 whether it does not exist or is not yours" rule
 * `handlers/projects.handlers.ts` already applies to `POST .../keys`.
 */
export function scopeProjectIds(req: Request, projectId: string | undefined): string[] {
  const owned = req.projectIds ?? [];
  if (projectId === undefined) return owned;
  if (!owned.includes(projectId)) {
    throw new NotFoundError('Project not found.');
  }
  return [projectId];
}

export async function resolveProjectIdsFromSession(req: Request): Promise<string[]> {
  const sessionId = readSessionCookie(req);
  if (!sessionId) return [];

  const userId = await resolveSessionUserId(sessionId);
  if (!userId) return [];

  const { rows } = await getPool().query<{ id: string }>(
    'SELECT id FROM projects WHERE owner_user_id = $1 AND NOT hidden',
    [userId],
  );
  return rows.map((row) => row.id);
}
