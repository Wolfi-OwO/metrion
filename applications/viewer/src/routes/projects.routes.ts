import express, { Router } from 'express';
import {
  createApiKey,
  createProject,
  listApiKeys,
  listProjects,
  revokeApiKey,
} from '../handlers/projects.handlers.js';
import { asyncHandler } from '../middlewares/error.js';
import { requireSession } from '../middlewares/require-session.js';
import { uuidIdParams, validateBody } from '../middlewares/validate.js';
import { createApiKeySchema, createProjectSchema } from '../schemas/projects.schemas.js';

/**
 * Projects and API keys - every route here needs a real session, unlike the
 * read API in `metrics.routes.ts`, which stays reachable (scoped to nothing)
 * without one.
 */
export const projectsRouter = Router();

projectsRouter.get('/api/v1/projects', asyncHandler(requireSession), asyncHandler(listProjects));

projectsRouter.post(
  '/api/v1/projects',
  asyncHandler(requireSession),
  // Same per-route `express.json()`, same size cap, as
  // `applications/ingest`'s one write route - this app otherwise parses no
  // body at all.
  express.json({ limit: '256kb' }),
  validateBody(createProjectSchema),
  asyncHandler(createProject),
);

projectsRouter.post(
  '/api/v1/projects/:id/keys',
  uuidIdParams,
  asyncHandler(requireSession),
  // Optional body (issue #20): a request with none at all still parses to
  // `{}`, so the pre-#20 project-wide-key behaviour is unaffected.
  express.json({ limit: '256kb' }),
  validateBody(createApiKeySchema),
  asyncHandler(createApiKey),
);

projectsRouter.get(
  '/api/v1/projects/:id/keys',
  uuidIdParams,
  asyncHandler(requireSession),
  asyncHandler(listApiKeys),
);

projectsRouter.delete(
  '/api/v1/keys/:id',
  uuidIdParams,
  asyncHandler(requireSession),
  asyncHandler(revokeApiKey),
);
