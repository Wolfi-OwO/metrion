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

// Minimal request log (no pino-http dependency): method, path, status, duration.
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info(
      {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number(process.hrtime.bigint() - start) / 1e6,
      },
      'request',
    );
  });
  next();
});

// No `cors()` here, unlike the viewer: no route sends
// `Access-Control-Allow-Origin`, so browsers keep blocking cross-origin reads.
// The one keyless route (public uptime) is read server-side by the portfolio,
// and the ingest route is called by servers/scripts with an API key, so
// neither needs a browser cross-origin path.
app.use(routes);

app.use(notFound);
app.use(errorHandler);

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  app.listen(config.port, () => {
    logger.info(`Ingest listening on port ${config.port}.`);
  });
}
