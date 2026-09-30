import type { RequestHandler } from 'express';
import { config } from '../config/index.js';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * `__Host-mtr_oauth` (`auth/session.ts`) is browser-enforced host-only, so a
 * login started on the old default Azure hostname can never complete once
 * `PUBLIC_BASE_URL` points at the custom domain - the provider redirects back
 * to the new host, which never had the cookie to check the state against.
 * Redirecting to the canonical host before the flow starts is the actual fix:
 * the cookie prefix makes cross-host OAuth impossible by design, not a bug to
 * work around downstream.
 *
 * Only ever matches the specific known-old-default pattern
 * (`*.azurecontainerapps.io`) - never localhost, never an arbitrary host - so
 * this can't turn into an open redirect off a spoofed `Host` header.
 */
const canonicalHostname = new URL(config.publicBaseUrl).hostname;

/**
 * The deploy workflow's smoke-check curls the old FQDN's liveness endpoint
 * directly (`deploy.yml`'s "Verify the running app" step reads it straight
 * from `az containerapp show`, which is always the system-generated
 * `*.azurecontainerapps.io` name, never a custom domain) - that must keep
 * answering 200 on the old host, not redirect.
 */
const HEALTH_PREFIX = '/api/v1/health/';

export const canonicalHost: RequestHandler = (req, res, next) => {
  if (
    !SAFE_METHODS.has(req.method) ||
    req.hostname === canonicalHostname ||
    !req.hostname.endsWith('.azurecontainerapps.io') ||
    req.path.startsWith(HEALTH_PREFIX)
  ) {
    next();
    return;
  }
  res.redirect(308, `${config.publicBaseUrl}${req.originalUrl}`);
};
