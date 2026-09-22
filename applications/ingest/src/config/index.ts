/**
 * The only place `process.env` is read. Everything else imports `config`.
 *
 * No `DATABASE_URL` entry here on purpose: `@metrion/db`'s `createPool()`
 * already reads it itself, with its own local-dev fallback matching
 * `docker-compose.dev.yml` - duplicating that read here would just be a
 * second place for the default to drift from the one `@metrion/db` owns.
 *
 * No API-key env var either, unlike the viewer's old `INGEST_TOKEN`: auth
 * here is per-project and lives in the `api_keys` table (ADR 0005), not one
 * shared secret this process has to be booted with.
 */
export const config = {
  port: Number(process.env['PORT']) || 8090,
  nodeEnv: process.env['NODE_ENV'] ?? 'development',
  /** pino level: trace/debug/info/warn/error/fatal/silent. */
  logLevel: process.env['LOG_LEVEL'] ?? 'info',

  /** Requests per window per API key on the ingest endpoint - never per IP, see ADR 0005. */
  ingestRateLimitMax: Number(process.env['INGEST_RATE_LIMIT_MAX']) || 120,
  ingestRateLimitWindowMs: Number(process.env['INGEST_RATE_LIMIT_WINDOW_MS']) || 60_000,

  /**
   * Requests per window for `GET /api/v1/public/projects/:id/uptime` -
   * shared across every caller (`keyGenerator: () => 'public-status'` in
   * `routes/index.ts`), never per IP: the route takes no API key at all, so
   * there is no per-caller identity to key on, and IP alone is spoofable/
   * shared behind proxies. Unlike `/api/v1/ingest`, this route has no auth
   * step ahead of it to reject a flood before it reaches the limiter, so a
   * global cap exists here where the ingest route has none.
   */
  publicStatusRateLimitMax: Number(process.env['PUBLIC_STATUS_RATE_LIMIT_MAX']) || 120,
  publicStatusRateLimitWindowMs:
    Number(process.env['PUBLIC_STATUS_RATE_LIMIT_WINDOW_MS']) || 60_000,

  /**
   * Per-API-key hourly cap on rows written to the permanent `uptime_samples`
   * store (security review finding 1, 2026-09-21). `uptime_samples` has no
   * retention policy by design (ADR 0009), so one key with no cap could grow
   * it forever; the default is about 8x the real fleet's need (7 monitors x 3
   * metrics x 60 samples/h = 1,260/h). Charged BEFORE the write
   * (`handlers/ingest.handlers.ts`), so a rejected request leaves nothing
   * behind. Overridable so a test can exercise the boundary without a
   * multi-thousand-row HTTP body.
   */
  uptimeQuotaMaxRowsPerHour: Number(process.env['UPTIME_QUOTA_MAX_ROWS_PER_HOUR']) || 10_000,
  uptimeQuotaWindowMs: Number(process.env['UPTIME_QUOTA_WINDOW_MS']) || 60 * 60 * 1000,
} as const;

export const isProduction = config.nodeEnv === 'production';
