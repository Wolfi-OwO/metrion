import type { Request, Response } from 'express';
import { scopeProjectIds } from '../middlewares/project-scope.js';
import type { MetricsQuery, ResourcesQuery } from '../schemas/metrics.schemas.js';
import { getResources, getSeries } from '../services/metrics-service.js';

/**
 * Read handlers. Both are mounted behind `resolveProjectIds` then
 * `validateQuery` (`routes/metrics.routes.ts`), so `req.projectIds` and
 * `req.query` are already resolved and range-checked here - a handler that
 * re-derived either would be a second place for it to drift out of sync with
 * the middleware that owns it.
 *
 * `req.projectIds` is read here and nowhere in `metrics.schemas.ts`, on
 * purpose: it is never a query parameter a caller could set, only something
 * the route layer injects (see `middlewares/project-scope.ts`). `?projectId=`
 * IS a query parameter, but it only ever narrows `req.projectIds` down to one
 * of its own entries - `scopeProjectIds` is what enforces that, here rather
 * than in the schema, because "is this one of mine" needs the session-derived
 * list, not just the string's shape.
 */

export async function listResources(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ResourcesQuery;
  const projectIds = scopeProjectIds(req, query.projectId);
  const result = await getResources(projectIds, new Date(query.from), new Date(query.to));
  res.status(200).json(result);
}

export async function getMetricSeries(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as MetricsQuery;
  const result = await getSeries({
    projectIds: scopeProjectIds(req, query.projectId),
    resource: query.resource,
    subResource: query.subResource,
    perInstance: query.perInstance,
    names: query.name,
    from: new Date(query.from),
    to: new Date(query.to),
    stepSeconds: query.stepSeconds,
  });
  res.status(200).json(result);
}
