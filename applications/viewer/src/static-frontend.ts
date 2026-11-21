import { existsSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Express } from 'express';

/**
 * Serves the built client and falls back to `index.html` for client-side
 * routes - the same pattern as `nutrilens/apps/api/src/static-frontend.ts`
 * and `portfolio-webpage`.
 *
 * A no-op when the assets are absent, so local development still runs the
 * client off its own Vite server instead of a stale build.
 *
 * Must be mounted after every API router and before `notFound`.
 */
const CLIENT_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Vite puts a content hash in every file name under assets/, so a changed file is always a new URL and may be kept for
// a year. Everything else (index.html, the icon) keeps its name across releases, so it is revalidated with its ETag:
// "no-cache" still stores the file, and an unchanged one costs a 304 with no body, while a deploy shows at once.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'no-cache';
const ASSETS_DIR = join(CLIENT_DIST, 'assets') + sep;

/**
 * First path segments that belong to the server, not to the SPA.
 *
 * Only consulted for requests NOTHING above matched - a real route always wins
 * on its own. This is what keeps an unmatched `/api/v1/typo` a JSON 404
 * instead of quietly returning the chart app with status 200, which is the
 * failure mode that makes a broken API call look like a broken UI.
 *
 * The legal routes are deliberately absent: they are real routes registered
 * before this fallback, so they are already unreachable from here.
 */
const SERVER_PATH_SEGMENTS = new Set(['api', 'docs', 'openapi.json']);

export function mountFrontend(app: Express): void {
  if (!existsSync(CLIENT_DIST)) return;

  // `index: false` so the static handler never answers `/` itself - the
  // fallback below owns that, and one owner is easier to reason about than
  // two that happen to agree.
  app.use(
    express.static(CLIENT_DIST, {
      index: false,
      setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', filePath.startsWith(ASSETS_DIR) ? IMMUTABLE : REVALIDATE);
      },
    }),
  );

  app.get(/.*/, (req, res, next) => {
    const firstSegment = req.path.split('/')[1];
    if (firstSegment !== undefined && SERVER_PATH_SEGMENTS.has(firstSegment)) {
      next();
      return;
    }
    res.set('Cache-Control', REVALIDATE).sendFile(join(CLIENT_DIST, 'index.html'));
  });
}
