import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// The guard answers before any handler runs, so no database is needed.
process.env.DATABASE_URL = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env.CORS_ALLOWED_ORIGINS = 'https://example.test';
process.env.PUBLIC_BASE_URL = 'https://viewer.example.test';
process.env.SESSION_SECRET = 'same-origin-test-session-secret';
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

// DELETE on a non-existent key: without the guard it would hit requireSession
// (401), so 401 proves the guard let the request through and 403 proves it did not.
const post = (headers: Record<string, string>) =>
  fetch(`${baseUrl}/api/v1/keys/00000000-0000-0000-0000-000000000000`, {
    method: 'DELETE',
    headers,
  });

test('non-GET without Origin or Sec-Fetch-Site is refused', async () => {
  const response = await post({});
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { statusCode: number }).statusCode, 403);
});

test('non-GET from a foreign Origin is refused', async () => {
  assert.equal((await post({ Origin: 'https://evil.test' })).status, 403);
});

test('non-GET from the own Origin reaches the handler, a CORS-only origin does not', async () => {
  assert.equal((await post({ Origin: 'https://example.test' })).status, 403);
  assert.equal((await post({ Origin: 'https://viewer.example.test' })).status, 401);
});

test('non-GET without Origin passes only as Sec-Fetch-Site same-origin', async () => {
  assert.equal((await post({ 'Sec-Fetch-Site': 'same-origin' })).status, 401);
  assert.equal((await post({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  // Every Azure Container App is same-site to the viewer (azurecontainerapps.io
  // is not in the public suffix list), so same-site proves nothing.
  assert.equal((await post({ 'Sec-Fetch-Site': 'same-site' })).status, 403);
  assert.equal((await post({ Origin: 'null' })).status, 403);
});

test('GET is untouched', async () => {
  assert.equal((await fetch(`${baseUrl}/api/v1/health/liveness`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/impressum`)).status, 200);
});
