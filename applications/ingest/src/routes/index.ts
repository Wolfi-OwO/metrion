import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { config } from '../config/index.js';
import { buildOpenApiDocument } from '../docs/openapi.js';
import { ingestMetrics } from '../handlers/ingest.handlers.js';
import {
  getPublicProjectUptime,
  getPublicProjectUptimeRange,
} from '../handlers/public-status.handlers.js';
import { requireApiKey } from '../middlewares/api-key.js';
import { asyncHandler } from '../middlewares/error.js';
import { validateBody, validateQuery } from '../middlewares/validate.js';
import { ingestBodySchema } from '../schemas/ingest.schemas.js';
import { publicRangeQuerySchema } from '../schemas/public-status.schemas.js';

/** Every route this service serves, mounted in one place. */
export const routes = Router();

/**
 * Liveness only, and it touches nothing else - no auth, no database. `getPool()`
 * in `lib/db.ts` is lazy specifically so this route never creates a pool.
 */
routes.get('/api/v1/health/liveness', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

const openApiDocument = buildOpenApiDocument();
routes.get('/openapi.json', (_req, res) => {
  res.json(openApiDocument);
});

/**
 * Keyed on the API key's own hash (`req.apiKeyContext.rateLimitKey`), never
 * on IP - see ADR 0005 and `middlewares/api-key.ts`. Mounted AFTER
 * `requireApiKey`, so an unauthenticated flood of guessed keys is rejected
 * before it can create a bucket, and `apiKeyContext` is always set by the
 * time this runs.
 */
const ingestRateLimiter = rateLimit({
  windowMs: config.ingestRateLimitWindowMs,
  limit: config.ingestRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.apiKeyContext?.rateLimitKey ?? 'unauthenticated',
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'TooManyRequestsError', message: 'Too many requests.', statusCode: 429 },
});

routes.post(
  '/api/v1/ingest',
  asyncHandler(requireApiKey),
  ingestRateLimiter,
  // Bounded well above a realistic batch (200 envelopes of 1000 points would
  // not fit) and far below anything that could exhaust memory.
  express.json({ limit: '256kb' }),
  validateBody(ingestBodySchema),
  asyncHandler(ingestMetrics),
);

/**
 * One shared bucket for every caller (`keyGenerator: () => 'public-status'`),
 * not per IP: this route takes no API key and no session at all - there is
 * no per-caller identity to key on - so unlike `ingestRateLimiter` above,
 * this is the only thing standing between an unauthenticated GET and being
 * unthrottled. Mounted ahead of the handler, same position `requireApiKey`
 * holds for `/api/v1/ingest`.
 */
const publicStatusRateLimiter = rateLimit({
  windowMs: config.publicStatusRateLimitWindowMs,
  limit: config.publicStatusRateLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: () => 'public-status',
  message: { error: 'TooManyRequestsError', message: 'Too many requests.', statusCode: 429 },
});

/**
 * The one route a session-less caller can read - moved here from
 * `applications/viewer` so ingest, not the viewer, is what a public status
 * page depends on. No `requireApiKey`: visibility is the project's own
 * `public_status_enabled` opt-in, checked inside `getPublicUptime` directly
 * against the `:id` path param.
 */
routes.get(
  '/api/v1/public/projects/:id/uptime',
  publicStatusRateLimiter,
  asyncHandler(getPublicProjectUptime),
);

/** Same gate, same shared limiter as `/uptime`; the range is validated before
 * any query runs, so a bad range costs no DB work. */
routes.get(
  '/api/v1/public/projects/:id/uptime/range',
  publicStatusRateLimiter,
  validateQuery(publicRangeQuerySchema),
  asyncHandler(getPublicProjectUptimeRange),
);
