import { Router } from 'express';
import { applicationsRouter } from './applications.routes.js';
import { authRouter } from './auth.routes.js';
import { docsRouter } from './docs.routes.js';
import { healthRouter } from './health.routes.js';
import { legalRouter } from './legal.routes.js';
import { metricsRouter } from './metrics.routes.js';
import { projectsRouter } from './projects.routes.js';
import { publicStatusRouter } from './public-status.routes.js';
import { thresholdsRouter } from './thresholds.routes.js';

/**
 * Every route the app serves, mounted in one place.
 *
 * No ingest route here any more - `POST /api/v1/ingest` moved to the
 * dedicated `@metrion/ingest` service (Task 4), which resolves tenancy from a
 * per-project API key (docs/adr/0005-api-key-determines-tenancy.md) instead
 * of this app's old single shared `INGEST_TOKEN`.
 */
export const routes = Router();

routes.use(healthRouter);
routes.use(authRouter);
routes.use(projectsRouter);
routes.use(applicationsRouter);
routes.use(thresholdsRouter);
routes.use(metricsRouter);
routes.use(publicStatusRouter);
routes.use(docsRouter);
// Before the SPA fallback in main.ts, so `/impressum` renders the Impressum
// rather than the chart app.
routes.use(legalRouter);
