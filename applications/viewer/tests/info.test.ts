import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Nothing here touches a database; the address just has to exist before main.ts is imported.
process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://example.test';
process.env['PUBLIC_BASE_URL'] = 'https://viewer.example.test';
process.env['SESSION_SECRET'] = 'info-test-session-secret';
for (const p of ['GOOGLE', 'MICROSOFT', 'GITHUB']) {
  process.env[`OAUTH_${p}_CLIENT_ID`] = 'info-test';
  process.env[`OAUTH_${p}_CLIENT_SECRET`] = 'info-test';
}

const { app } = await import('../dist/main.js');
const { appInfo } = await import('../dist/lib/app-info.js');

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

test('GET /api/info answers the shape every app of the stack answers, without signing in', async () => {
  const response = await fetch(`${baseUrl}/api/info`);
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body['name'], 'metrion-viewer');
  for (const key of ['version', 'revision', 'buildDate', 'repositoryUrl'])
    assert.equal(typeof body[key], 'string', key);
});

test('appInfo reads the build args and prefixes a bare version with v', () => {
  const info = appInfo({
    APP_VERSION: '0.8.4',
    APP_REVISION: 'abc',
    APP_BUILD_DATE: '2026-11-24T10:00:00Z',
  });
  assert.equal(info.version, 'v0.8.4');
  assert.equal(info.revision, 'abc');
  assert.equal(info.buildDate, '2026-11-24T10:00:00Z');
});

test('appInfo says dev, with nothing invented, outside a real image', () => {
  const info = appInfo({});
  assert.equal(info.version, 'dev');
  assert.equal(info.revision, '');
});
