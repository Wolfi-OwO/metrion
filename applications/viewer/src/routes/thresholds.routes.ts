import express, { Router } from 'express';
import {
  createThreshold,
  deleteThreshold,
  listThresholds,
  updateThreshold,
} from '../handlers/thresholds.handlers.js';
import { asyncHandler } from '../middlewares/error.js';
import { resolveProjectIds } from '../middlewares/project-scope.js';
import { requireSession } from '../middlewares/require-session.js';
import { uuidIdParams, validateBody } from '../middlewares/validate.js';
import { createThresholdSchema, updateThresholdSchema } from '../schemas/thresholds.schemas.js';

/** Same two-middleware chain as `applications.routes.ts` - see its comment. */
export const thresholdsRouter = Router();

const requireProjectScope = [asyncHandler(requireSession), asyncHandler(resolveProjectIds)];

thresholdsRouter.get(
  '/api/v1/projects/:id/thresholds',
  uuidIdParams,
  ...requireProjectScope,
  asyncHandler(listThresholds),
);

thresholdsRouter.post(
  '/api/v1/projects/:id/thresholds',
  uuidIdParams,
  ...requireProjectScope,
  express.json({ limit: '256kb' }),
  validateBody(createThresholdSchema),
  asyncHandler(createThreshold),
);

thresholdsRouter.patch(
  '/api/v1/thresholds/:id',
  uuidIdParams,
  ...requireProjectScope,
  express.json({ limit: '256kb' }),
  validateBody(updateThresholdSchema),
  asyncHandler(updateThreshold),
);

thresholdsRouter.delete(
  '/api/v1/thresholds/:id',
  uuidIdParams,
  ...requireProjectScope,
  asyncHandler(deleteThreshold),
);
