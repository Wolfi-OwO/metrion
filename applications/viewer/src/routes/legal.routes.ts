import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { renderDocumentPage, renderMarkdown } from '../lib/markdown.js';

/**
 * The legal documents, served as real HTML pages.
 *
 * Austrian § 5 ECG requires the Impressum to be "leicht und unmittelbar
 * zugänglich" from the deployed site. A Markdown file in a GitHub repo does
 * not satisfy that, so these routes put the same content at a stable URL on
 * the running app. They are unauthenticated and exempt from the global rate
 * limiter (see `RATE_LIMIT_EXEMPT_PATHS` in `main.ts`): an Impressum answered
 * with 429 is not immediately accessible.
 */

/**
 * The documents live in two different places depending on how the app was
 * started, and both are resolved by the same code path on purpose.
 *
 * In the image the Dockerfile copies them next to the compiled output; from a
 * checkout they are at the repo root, four levels above `dist/routes/`.
 * Picking whichever exists is what stops the pair of environments from
 * diverging - hard-coding either one gives a route that passes every local
 * test and 404s in production, or the reverse.
 */
const CANDIDATE_ROOTS = [
  join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'),
];

function resolveDocument(file: string): string {
  const found = CANDIDATE_ROOTS.map((root) => join(root, file)).find((path) => existsSync(path));
  if (found === undefined) {
    throw new Error(`Legal document ${file} is missing from the deployment.`);
  }
  return found;
}

interface LegalDocument {
  readonly path: string;
  readonly file: string;
  readonly title: string;
  /** IMPRESSUM.md is German; the other two are English. Screen readers and
   * translation tools both depend on this being right per document, not
   * per site. */
  readonly lang: string;
}

const DOCUMENTS: readonly LegalDocument[] = [
  { path: '/impressum', file: 'IMPRESSUM.md', title: 'Impressum - metrion', lang: 'de' },
  { path: '/privacy', file: 'PRIVACY.md', title: 'Privacy Policy - metrion', lang: 'en' },
  { path: '/terms', file: 'TERMS_OF_USE.md', title: 'Terms of Use - metrion', lang: 'en' },
  {
    path: '/third-party-notices',
    file: 'THIRD_PARTY_NOTICES.md',
    title: 'Third-party notices - metrion',
    lang: 'en',
  },
];

/** The paths these routes own. Exported so the limiter and the SPA fallback
 * agree with this file instead of keeping their own copy of the list. */
export const LEGAL_PATHS: readonly string[] = DOCUMENTS.map((document) => document.path);

export const legalRouter = Router();

for (const document of DOCUMENTS) {
  legalRouter.get(document.path, (_req, res) => {
    // Read per request rather than cached at import: these files change only
    // on deploy, and a missing file must surface as a 500 for that one route
    // instead of stopping the whole app from booting - the charts and the API
    // have no reason to go down because a legal document was not copied.
    const markdown = readFileSync(resolveDocument(document.file), 'utf8');
    res
      .status(200)
      .type('html')
      .send(renderDocumentPage(document.title, document.lang, renderMarkdown(markdown)));
  });
}
