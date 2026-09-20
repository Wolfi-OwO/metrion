/**
 * The only place `process.env` is read. Everything else imports `config`.
 */

/**
 * A missing required var fails loudly at process start, not as `undefined`
 * three calls deep into a request. Same helper `applications/agent/src/config/index.ts`
 * already uses.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * `PUBLIC_BASE_URL` is what `middlewares/same-origin.ts` trusts as the
 * viewer's own origin, so a malformed value must stop the boot rather than
 * become the string "null". https is mandatory in production; http is only
 * accepted for localhost (dev and tests use it).
 */
function requirePublicBaseUrl(): string {
  const value = requireEnv('PUBLIC_BASE_URL');
  const url = new URL(value); // throws on a malformed value
  const isLocalhost = url.protocol === 'http:' && url.hostname === 'localhost';
  const isHttps = url.protocol === 'https:';
  if (!isHttps && !(isLocalhost && process.env.NODE_ENV !== 'production')) {
    throw new Error(
      'PUBLIC_BASE_URL must be an https:// URL (http://localhost only outside production).',
    );
  }
  return value;
}

export const config = {
  port: Number(process.env.PORT) || 8080,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  /** pino level: trace/debug/info/warn/error/fatal/silent. */
  logLevel: process.env.LOG_LEVEL ?? 'info',

  /**
   * A fail-fast presence check ONLY, not the value `lib/db.ts` connects
   * with - it reads `process.env['DATABASE_URL']` itself, lazily, so a test
   * can still swap the value after `config` has already loaded (see
   * `lib/db.ts`). Required at all, unlike `applications/ingest`'s config
   * (which leaves this out entirely and lets `@metrion/db`'s own silent
   * local-dev fallback apply): the read endpoints used to degrade to a 503
   * when storage was unconfigured (Azure Blob was optional by design, see
   * ADR 0001's era of this file). That degrade path is gone with it -
   * Postgres is no longer optional infrastructure the process can boot
   * without, so a missing `DATABASE_URL` fails the boot instead of failing
   * every request one at a time.
   */
  databaseUrl: requireEnv('DATABASE_URL'),

  /**
   * Requests per window across the WHOLE app, every caller together.
   *
   * This is now the app's only rate limiter - `POST /api/v1/ingest` moved to
   * `@metrion/ingest` (Task 4), which keys its own limiter on the API key
   * instead.
   */
  globalRateLimitMax: Number(process.env.GLOBAL_RATE_LIMIT_MAX) || 300,
  globalRateLimitWindowMs: Number(process.env.GLOBAL_RATE_LIMIT_WINDOW_MS) || 60_000,

  /**
   * Comma-separated browser origins allowed to call the API, e.g.
   * `https://metrion.example.at`. Required, not merely honoured when present:
   * `GET /api/v1/me` and the project/key endpoints now read a session cookie
   * (issue #7, Task 6), so an unrestricted `*` origin is no longer a safe
   * default - a page nobody owns could otherwise drive an authenticated
   * request on a signed-in visitor's cookie. `requireEnv` fails boot the same
   * way a missing `DATABASE_URL` does, rather than silently falling back to
   * `*` the way this used to.
   */
  corsAllowedOrigins: requireEnv('CORS_ALLOWED_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0),

  /**
   * The ONLY place a redirect base is derived from. Every OAuth redirect_uri
   * this app builds is `${publicBaseUrl}/auth/<provider>/callback` - never a
   * literal host baked in elsewhere - so a later phase-2 domain switch is one
   * variable, not a grep across the auth code.
   */
  publicBaseUrl: requirePublicBaseUrl(),

  /** HMAC key for signing the opaque session cookie value (`auth/session.ts`).
   * The session itself lives in the `sessions` table, keyed by an
   * unguessable `gen_random_uuid()` - this signature is a cheap early reject
   * for a tampered or truncated cookie, not what makes the session secure. */
  sessionSecret: requireEnv('SESSION_SECRET'),

  oauthGoogleClientId: requireEnv('OAUTH_GOOGLE_CLIENT_ID'),
  oauthGoogleClientSecret: requireEnv('OAUTH_GOOGLE_CLIENT_SECRET'),

  oauthMicrosoftClientId: requireEnv('OAUTH_MICROSOFT_CLIENT_ID'),
  oauthMicrosoftClientSecret: requireEnv('OAUTH_MICROSOFT_CLIENT_SECRET'),
  /** `common` accepts both personal Microsoft accounts and any work/school
   * tenant - the only sane default for a public sign-up flow that has no
   * business restricting itself to one organisation. */
  oauthMicrosoftTenant: process.env.OAUTH_MICROSOFT_TENANT ?? 'common',

  oauthGithubClientId: requireEnv('OAUTH_GITHUB_CLIENT_ID'),
  oauthGithubClientSecret: requireEnv('OAUTH_GITHUB_CLIENT_SECRET'),
} as const;

export const isProduction = config.nodeEnv === 'production';
