import type { Request, Response } from 'express';
import { NotFoundError } from '../middlewares/error.js';
import type { PublicRangeQuery } from '../schemas/public-status.schemas.js';
import { getPublicUptime } from '../services/public-status-service.js';
import {
  getPublicUptimeRange,
  rangeMaxAgeSeconds,
} from '../services/public-uptime-range-service.js';

/**
 * No `apiKeyContext`, no session - there is no caller identity on this route
 * (`routes/index.ts` mounts it without `requireApiKey`). `:id` is checked
 * directly against `projects.public_status_enabled` inside `getPublicUptime`,
 * which returns `null` for a nonexistent project id AND for an existing-but-
 * unflagged one - the same "404, never 403" shape the viewer's own copy uses.
 */
export async function getPublicProjectUptime(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  const result = await getPublicUptime(projectId);
  if (result === null) {
    throw new NotFoundError('Project not found.');
  }

  // Matches the service's 60s cache; lets the consumer and any CDN reuse it too.
  res.set('Cache-Control', 'public, max-age=60');
  res.status(200).json({
    projectId,
    generatedAt: new Date().toISOString(),
    applications: result.applications,
  });
}

/**
 * `GET .../uptime/range`. The query was validated (and `from`/`to` parsed) by
 * `validateQuery(publicRangeQuerySchema)` upstream; 404 shape is the sibling
 * handler's, so an unknown id and an unflagged one stay indistinguishable.
 */
export async function getPublicProjectUptimeRange(req: Request, res: Response): Promise<void> {
  const result = await getPublicUptimeRange(
    req.params.id!,
    res.locals['query'] as PublicRangeQuery,
  );
  if (result === null) {
    throw new NotFoundError('Project not found.');
  }

  res.set(
    'Cache-Control',
    `public, max-age=${rangeMaxAgeSeconds(Date.parse(result.range.to), Date.now())}`,
  );
  res.status(200).json(result);
}
