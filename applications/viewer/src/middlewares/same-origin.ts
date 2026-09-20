import type { RequestHandler } from 'express';
import { config } from '../config/index.js';
import { ForbiddenError } from './error.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for the session cookie: every non-GET request must come from
 * an allowed origin. Browsers always send `Origin` on a non-GET; when it is
 * absent, `Sec-Fetch-Site: same-origin` is the fallback. No token, no store.
 *
 * Only the viewer's own origin (`PUBLIC_BASE_URL`) is accepted, not
 * `CORS_ALLOWED_ORIGINS`: CORS stays for the public reads, but a state-changing
 * request has no business coming from any other site. Every Azure Container
 * App is same-site to this one (azurecontainerapps.io is not in the public
 * suffix list), so `SameSite=Lax` and `Sec-Fetch-Site: same-site` prove nothing.
 */
const ownOrigin = new URL(config.publicBaseUrl).origin;

export const sameOrigin: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const origin = req.get('origin');
  const allowed =
    origin !== undefined ? origin === ownOrigin : req.get('sec-fetch-site') === 'same-origin';
  next(allowed ? undefined : new ForbiddenError('Cross-origin request refused.'));
};
