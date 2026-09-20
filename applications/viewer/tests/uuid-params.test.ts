import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import './with-origin.ts';

// The uuid guard is the first middleware on every `:id` route, so it answers
// before the session check or any query: no database and no sign-in needed.
// Cross-tenant valid-uuid 404s stay covered by applications/thresholds/
// projects.test.ts, which need real rows.
process.env.DATABASE_URL = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env.CORS_ALLOWED_ORIGINS = 'https://example.test';
process.env.PUBLIC_BASE_URL = 'https://viewer.example.test';
process.env.SESSION_SECRET = 'uuid-params-test-session-secret';
for (const p of ['GOOGLE', 'MICROSOFT', 'GITHUB']) {
  process.env[`OAUTH_${p}_CLIENT_ID`] = 'test';
  process.env[`OAUTH_${p}_CLIENT_SECRET`] = 'test';
}

const { app } = await import('../dist/main.js');

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

const ROUTES: readonly [string, string][] = [
  ['GET', '/api/v1/projects/:id/applications'],
  ['POST', '/api/v1/projects/:id/applications'],
  ['PATCH', '/api/v1/applications/:id'],
  ['DELETE', '/api/v1/applications/:id'],
  ['GET', '/api/v1/applications/:id/dependencies'],
  ['PUT', '/api/v1/applications/:id/dependencies'],
  ['GET', '/api/v1/projects/:id/status'],
  ['GET', '/api/v1/projects/:id/status/events'],
  ['GET', '/api/v1/projects/:id/thresholds'],
  ['POST', '/api/v1/projects/:id/thresholds'],
  ['PATCH', '/api/v1/thresholds/:id'],
  ['DELETE', '/api/v1/thresholds/:id'],
  ['POST', '/api/v1/projects/:id/keys'],
  ['GET', '/api/v1/projects/:id/keys'],
  ['DELETE', '/api/v1/keys/:id'],
];

for (const [method, template] of ROUTES) {
  test(`${method} ${template} answers 400 for a malformed id`, async () => {
    const response = await fetch(`${baseUrl}${template.replace(':id', 'not-a-uuid')}`, { method });
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { error: string }).error, 'ValidationError');
  });
}
