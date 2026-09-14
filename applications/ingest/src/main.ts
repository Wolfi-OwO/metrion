import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFound } from './middlewares/error.js';
import { routes } from './routes/index.js';

export { logger };

/**
 * The whole startup file: app at module scope, then `listen` only when this
 * file is the entrypoint - same shape as `applications/viewer/src/main.ts`
 * and `applications/agent/src/main.ts`, so a test can import `app` and drive
 * it over a real socket without a second process.
 */
export const app = express();

app.set('trust proxy', 1);

app.use(helmet());

// No `cors()` here, unlike the viewer: every sender is a server or a script
// holding an API key, never a browser acting on a visitor's behalf, so there
// is no cross-origin case to guard against on this endpoint.
app.use(routes);

app.use(notFound);
app.use(errorHandler);

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  app.listen(config.port, () => {
    logger.info(`Ingest listening on port ${config.port}.`);
  });
}
