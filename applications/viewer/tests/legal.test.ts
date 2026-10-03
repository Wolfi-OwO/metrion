import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Set, not connected to: `config/index.ts`'s `requireEnv` only checks that
// this is present, and legal-document rendering never touches the pool
// `lib/db.ts` builds lazily from it.
process.env.DATABASE_URL = 'postgres://bogus:bogus@127.0.0.1:1/bogus';

// The rest are all `requireEnv` presence checks too (issue #7, Task 6) -
// legal-document rendering touches none of the auth machinery they gate.
process.env.CORS_ALLOWED_ORIGINS = 'https://example.test';
process.env.PUBLIC_BASE_URL = 'https://viewer.example.test';
process.env.SESSION_SECRET = 'legal-test-session-secret';
process.env.OAUTH_GOOGLE_CLIENT_ID = 'legal-test';
process.env.OAUTH_GOOGLE_CLIENT_SECRET = 'legal-test';
process.env.OAUTH_MICROSOFT_CLIENT_ID = 'legal-test';
process.env.OAUTH_MICROSOFT_CLIENT_SECRET = 'legal-test';
process.env.OAUTH_GITHUB_CLIENT_ID = 'legal-test';
process.env.OAUTH_GITHUB_CLIENT_SECRET = 'legal-test';

const { app } = await import('../dist/main.js');
const { renderMarkdown } = await import('../dist/lib/markdown.js');

let server: Server;
let baseUrl: string;

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const DOCUMENTS = [
  { path: '/impressum', file: 'IMPRESSUM.md', lang: 'de' },
  { path: '/privacy', file: 'PRIVACY.md', lang: 'en' },
  { path: '/terms', file: 'TERMS_OF_USE.md', lang: 'en' },
  { path: '/third-party-notices', file: 'THIRD_PARTY_NOTICES.md', lang: 'en' },
];

test('legal documents are served as HTML with the right language', async () => {
  for (const document of DOCUMENTS) {
    const response = await fetch(`${baseUrl}${document.path}`);
    assert.equal(response.status, 200, document.path);
    assert.match(response.headers.get('content-type') ?? '', /text\/html/, document.path);
    assert.match(response.headers.get('content-type') ?? '', /charset=utf-8/i, document.path);

    const html = await response.text();
    assert.ok(
      html.includes(`<html lang="${document.lang}">`),
      `${document.path} must be lang=${document.lang}`,
    );
  }
});

test('the SPA fallback does not swallow the legal routes', async () => {
  // The failure this guards against is silent: a catch-all sendFile registered
  // ahead of these routes returns the chart app with status 200, so the page
  // "works" while the Impressum is unreachable - which is the compliance gap,
  // not a cosmetic one.
  for (const document of DOCUMENTS) {
    const html = await (await fetch(`${baseUrl}${document.path}`)).text();
    assert.equal(
      html.includes('<div id="root">'),
      false,
      `${document.path} returned the SPA shell`,
    );
    assert.ok(html.includes('<h1>'), `${document.path} must render a document heading`);
  }
});

test('legal routes need no authentication', async () => {
  // No Authorization header at all - a visitor, a regulator or a court must be
  // able to read these without holding a token.
  const response = await fetch(`${baseUrl}/impressum`);
  assert.equal(response.status, 200);
});

test('renderMarkdown drops no visible text from any legal document', async () => {
  // The property that actually matters for a legally required disclosure: a
  // subset converter is acceptable, silently losing a sentence is not. Every
  // word of four or more characters in the source must survive into the
  // rendered page.
  for (const document of DOCUMENTS) {
    const source = readFileSync(new URL(`../../../${document.file}`, import.meta.url), 'utf8');
    const rendered = renderMarkdown(source);
    const text = rendered
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"');

    const words = new Set(source.match(/[\p{L}\p{N}]{4,}/gu) ?? []);
    for (const word of words) {
      assert.ok(text.includes(word), `${document.file}: "${word}" was dropped by the renderer`);
    }
  }
});

test('renderMarkdown handles the constructs these documents actually use', () => {
  const html = renderMarkdown(
    [
      '# Title',
      '',
      'A **bold** word, an *emphasised* one and `code:<name>` that must stay literal.',
      '',
      '- first bullet',
      '  wrapped continuation',
      '- second bullet',
      '',
      '| Field | Content |',
      '| ----- | ------- |',
      '| `a`   | b       |',
      '',
      'Mail <someone@example.com> and <https://example.com>.',
    ].join('\n'),
  );

  assert.ok(html.includes('<h1>Title</h1>'));
  assert.ok(html.includes('<strong>bold</strong>'));
  assert.ok(html.includes('<em>emphasised</em>'));
  // Inside a code span the angle brackets are text, never a link.
  assert.ok(html.includes('<code>code:&lt;name&gt;</code>'));
  assert.ok(html.includes('<li>first bullet wrapped continuation</li>'));
  assert.ok(html.includes('<table><thead><tr><th>Field</th><th>Content</th></tr></thead>'));
  assert.ok(html.includes('<td><code>a</code></td>'));
  assert.ok(html.includes('<a href="mailto:someone@example.com">'));
  assert.ok(html.includes('<a href="https://example.com" rel="noopener noreferrer">'));
  // No raw markers left behind.
  assert.equal(html.includes('**'), false, html);
});
