import type { RequestHandler } from 'express';
import { config } from '../config/index.js';
import { ForbiddenError } from './error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for the session cookie: every non-GET request must come from
 * an allowed origin. Browsers always send `Origin` on a non-GET; when it is
 * absent, `Sec-Fetch-Site: same-origin` is the fallback. No token, no store.
 *
 * The viewer's own origin (`PUBLIC_BASE_URL`) is accepted alongside
 * `CORS_ALLOWED_ORIGINS`: the SPA is same-origin, and the production value of
 * the CORS list is set on the Container App, not in this repo, so the guard
 * must not depend on it happening to contain the viewer's own FQDN.
 */
const ownOrigin = new URL(config.publicBaseUrl).origin;

export const sameOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  const allowed =
    origin !== undefined
      ? origin === ownOrigin || config.corsAllowedOrigins.includes(origin)
      : req.get('sec-fetch-site') === 'same-origin';
  next(allowed ? undefined : new ForbiddenError('Cross-origin request refused.'));
};
