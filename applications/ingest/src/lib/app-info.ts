// Build metadata for GET /api/info: the same fields and names every app of the stack answers (name, version,
// revision, buildDate, repositoryUrl). The Dockerfile copies its build args into these variables; outside a real image
// the version is "dev" and the rest is empty. Kept in each service, not in @metrion/shared: that package is type-only
// by design and must erase completely at compile time.
export interface AppInfo {
  name: string;
  version: string;
  revision: string;
  buildDate: string;
  repositoryUrl: string;
}

export function appInfo(env: NodeJS.ProcessEnv = process.env): AppInfo {
  const raw = env['APP_VERSION'] || 'dev';
  return {
    name: 'metrion-ingest',
    // Release tags read v0.6.4 everywhere else; the build arg is the bare number.
    version: /^\d/.test(raw) ? `v${raw}` : raw,
    revision: env['APP_REVISION'] ?? '',
    buildDate: env['APP_BUILD_DATE'] ?? '',
    repositoryUrl: env['APP_REPOSITORY_URL'] ?? 'https://github.com/Wolfi-OwO/metrion',
  };
}
