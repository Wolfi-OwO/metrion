import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import { config } from './config/index.js';
import { errorHandler, notFound } from './middlewares/error.js';
import { sameOrigin } from './middlewares/same-origin.js';
import {
  resolveProjectIdsFromSession,
  setProjectIdsResolver,
} from './middlewares/project-scope.js';
import { LEGAL_PATHS } from './routes/legal.routes.js';
import { routes } from './routes/index.js';
import { mountFrontend } from './static-frontend.js';

// The seam `middlewares/project-scope.ts` was built for (issue #7, Task 6):
// `GET /api/v1/metrics` and `/resources` now scope to the calling session's
// own projects instead of always answering empty. `tests/metrics.test.ts`
// still calls `setProjectIdsResolver` itself to override this for its
// two-project leakage proof - the last call before a request wins, and a
// test file's own `before()` runs after this module-level line.
setProjectIdsResolver(resolveProjectIdsFromSession);

/**
 * The whole startup file: app at module scope, then `listen` only when this
 * file is the entrypoint - the same `isMainModule` shape
 * `applications/agent/src/main.ts` already uses, so a test can import
 * `app` and drive it over a real socket without a second process. No
 * `createApp()` factory: there is exactly one app.
 */
export const app = express();

// Azure Container Apps terminates TLS at its ingress and forwards plain HTTP.
// `1` trusts exactly that one hop so `req.protocol` is honest. It deliberately
// does NOT make us read a client IP: the request logger below never
// serializes an address.
app.set('trust proxy', 1);

// Express 4 parses query strings with `qs` by default. Every query parameter
// this API takes is a flat scalar (`from`, `to`, `resource`, `subResource`,
// `name`, `stepSeconds`), so `qs`'s nested-object and array syntax buys
// nothing here and costs two things: it is the component both open advisories
// against this dependency tree live in (`npm audit`: an `arrayLimit` bypass
// via bracket-key comma parsing, reachable from a query string on the public
// read endpoints, and a prototype-pollution-dependent DoS), and it is what
// lets `?resource[x]=1` arrive as an object where a string was expected.
// `simple` is Node's own `querystring`: flat keys, flat values, no `qs` on the
// request path at all. Do not switch this back to `extended` without a
// parameter that genuinely needs nesting.
app.set('query parser', 'simple');

app.use(helmet());

// `credentials: true` and a real allowlist, not `*` - `GET /api/v1/me` and
// the project/key endpoints now read a session cookie (issue #7, Task 6), so
// an unrestricted origin would let a page nobody owns ride a signed-in
// visitor's cookie. `config.corsAllowedOrigins` is required
// (`config/index.ts`); there is no `*` fallback left to reach for. `methods`
// now includes DELETE for `DELETE /api/v1/keys/:id`.
app.use(
  cors({
    origin: config.corsAllowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
  }),
);

/**
 * One bucket for the whole app, deliberately not per client.
 *
 * Behind Container Apps ingress the source address is the proxy's, and reading
 * a client IP is what the privacy rules exclude everywhere else in this
 * pipeline - so there is no per-caller identity to key on and none is going to
 * be invented for a rate limiter. A global bucket bounds the total work
 * regardless of who asks, which is the property that actually matters here:
 * the read endpoints need no credentials and each one fans out to up to 31
 * blob reads, and any traffic at all keeps a `minReplicas: 0` container warm.
 *
 * ponytail: one abuser can spend the global budget and 429 everyone else. That
 * is the accepted ceiling of a global bucket - with `maxReplicas: 1` a flood
 * costs availability either way, and this way it does not also cost money.
 * Upgrade path if it ever bites: cache parsed day-blobs in process so repeat
 * queries stop hitting storage, before reaching for a per-caller key.
 *
 * Liveness is exempt: Container Apps probes it on a fixed schedule and a
 * probe answered with 429 would restart a container that is perfectly healthy.
 * The legal documents are exempt for a different reason - Austrian
 * ECG requires the Impressum to be immediately accessible, and a 429 is not
 * that. Both are cheap, constant responses that no flood benefits from.
 */
const RATE_LIMIT_EXEMPT_PATHS = new Set(['/api/v1/health/liveness', ...LEGAL_PATHS]);

app.use(
  rateLimit({
    windowMs: config.globalRateLimitWindowMs,
    limit: config.globalRateLimitMax,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: () => 'global',
    validate: { keyGeneratorIpFallback: false },
    skip: (req) => RATE_LIMIT_EXEMPT_PATHS.has(req.path),
    message: { error: 'TooManyRequestsError', message: 'Too many requests.', statusCode: 429 },
  }),
);

const logger = pino({
  level: config.logLevel,
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  formatters: { level: (label) => ({ level: label.toUpperCase() }) },
});

app.use(
  pinoHttp({
    logger,
    // The DEFAULT pino-http request serializer emits `remoteAddress`,
    // `remotePort` and the full header set - so out of the box it logs the
    // client IP and the user agent, and `url` carries the query string. That
    // is precisely the capture the privacy review banned at the collector, and
    // a log file is no better a place for it than a blob. Replaced, not
    // trimmed: anything left to the default would come back the moment
    // pino-std-serializers adds a field.
    serializers: {
      req: (req: { method: string; url?: string }) => ({
        method: req.method,
        path: (req.url ?? '').split('?')[0],
      }),
      res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
    },
  }),
);

// One guard for every state-changing request, mounted before any router so a
// route added later is covered without opting in.
app.use(sameOrigin);

app.use(routes);

// After every route above, so a real handler always wins, and before
// `notFound`, so an unmatched non-API path becomes the SPA rather than a 404.
mountFrontend(app);

// Mounted last: 404 for anything unmatched, then the terminal error handler.
app.use(notFound);
app.use(errorHandler);

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  app.listen(config.port, () => {
    logger.info(`Viewer listening on port ${config.port}.`);
  });
}
