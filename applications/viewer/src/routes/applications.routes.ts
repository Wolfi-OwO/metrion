import express, { Router } from 'express';
import {
  createApplication,
  deleteApplication,
  getDependencies,
  getProjectStatus,
  getProjectStatusEvents,
  listApplications,
  replaceDependencies,
  updateApplication,
} from '../handlers/applications.handlers.js';
import { asyncHandler } from '../middlewares/error.js';
import { resolveProjectIds } from '../middlewares/project-scope.js';
import { requireSession } from '../middlewares/require-session.js';
import { validateBody, validateQuery } from '../middlewares/validate.js';
import {
  createApplicationSchema,
  replaceDependenciesSchema,
  statusEventsQuerySchema,
  updateApplicationSchema,
} from '../schemas/applications.schemas.js';

/**
 * Applications, their dependency graph, and the status endpoints that read
 * off it. Every route here needs both `requireSession` (a real 401 for no
 * session, `middlewares/require-session.ts`) AND `resolveProjectIds` (so
 * `req.projectIds` - what `scopeProjectIds` checks every `:id` path param
 * against, `middlewares/project-scope.ts` - is actually populated from that
 * session). `projects.routes.ts` only needed the first, because its handlers
 * check ownership against `req.userId` directly; these handlers need the
 * resolved project-id list instead, the same seam `metrics.routes.ts` uses.
 */
export const applicationsRouter = Router();

const requireProjectScope = [asyncHandler(requireSession), asyncHandler(resolveProjectIds)];

applicationsRouter.get(
  '/api/v1/projects/:id/applications',
  ...requireProjectScope,
  asyncHandler(listApplications),
);

applicationsRouter.post(
  '/api/v1/projects/:id/applications',
  ...requireProjectScope,
  express.json({ limit: '256kb' }),
  validateBody(createApplicationSchema),
  asyncHandler(createApplication),
);

applicationsRouter.patch(
  '/api/v1/applications/:id',
  ...requireProjectScope,
  express.json({ limit: '256kb' }),
  validateBody(updateApplicationSchema),
  asyncHandler(updateApplication),
);

applicationsRouter.delete(
  '/api/v1/applications/:id',
  ...requireProjectScope,
  asyncHandler(deleteApplication),
);

applicationsRouter.get(
  '/api/v1/applications/:id/dependencies',
  ...requireProjectScope,
  asyncHandler(getDependencies),
);

applicationsRouter.put(
  '/api/v1/applications/:id/dependencies',
  ...requireProjectScope,
  express.json({ limit: '256kb' }),
  validateBody(replaceDependenciesSchema),
  asyncHandler(replaceDependencies),
);

applicationsRouter.get(
  '/api/v1/projects/:id/status',
  ...requireProjectScope,
  asyncHandler(getProjectStatus),
);

applicationsRouter.get(
  '/api/v1/projects/:id/status/events',
  ...requireProjectScope,
  validateQuery(statusEventsQuerySchema),
  asyncHandler(getProjectStatusEvents),
);
