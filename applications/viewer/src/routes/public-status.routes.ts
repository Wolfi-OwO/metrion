import { Router } from 'express';
import { getPublicProjectUptime } from '../handlers/public-status.handlers.js';
import { asyncHandler } from '../middlewares/error.js';

/**
 * The one route a session-less caller can read project data from - the
 * portfolio status page's second, labelled source
 * (organizational/uptime-sources.md). Mounted with neither
 * `resolveProjectIds` nor `requireSession`: those exist to resolve "the
 * caller's own projects" from a session, and this route has no caller
 * identity to resolve one from. Visibility is instead the project's own
 * `public_status_enabled` opt-in
 * (`packages/db/migrations/0011_project_public_status.sql`), checked in
 * `services/status-service.ts#getPublicUptime` directly against the `:id`
 * path param - the same "no session middleware, scope inside the handler"
 * shape `routes/legal.routes.ts` and `routes/health.routes.ts` already use
 * for their own unauthenticated routes.
 */
export const publicStatusRouter = Router();

publicStatusRouter.get('/api/v1/public/projects/:id/uptime', asyncHandler(getPublicProjectUptime));
