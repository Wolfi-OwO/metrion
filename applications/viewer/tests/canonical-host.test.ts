import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

process.env.DATABASE_URL = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env.CORS_ALLOWED_ORIGINS = 'https://example.test';
process.env.PUBLIC_BASE_URL = 'https://metrion.woofi-developments.at';
process.env.SESSION_SECRET = 'canonical-host-test-session-secret';
for (const p of ['GOOGLE', 'MICROSOFT', 'GITHUB']) {
  process.env[`OAUTH_${p}_CLIENT_ID`] = 'test';
  process.env[`OAUTH_${p}_CLIENT_SECRET`] = 'test';
}

const { app } = await import('../dist/main.js');

let server: Server;
let baseUrl: string;

const OLD_HOST = 'metrion-viewer.yellowmushroom-787641f4.westeurope.azurecontainerapps.io';

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// A bare `Host` header is a forbidden header name under the Fetch spec -
// undici silently drops it and keeps the real socket's `127.0.0.1`. `main.ts`
// sets `trust proxy: 1`, which is exactly what makes Express honour
// `X-Forwarded-Host` for `req.hostname` instead - the same header Container
// Apps' own ingress would set for a real proxied request.
const asHost = (host: string) => ({ 'X-Forwarded-Host': host });

test('a request on the old azurecontainerapps.io host redirects 308 to the canonical host, same path', async () => {
  const response = await fetch(`${baseUrl}/auth/github`, {
    headers: asHost(OLD_HOST),
    redirect: 'manual',
  });
  assert.equal(response.status, 308);
  assert.equal(
    response.headers.get('location'),
    'https://metrion.woofi-developments.at/auth/github',
  );
});

test('a request already on the canonical host is not redirected by this middleware', async () => {
  const response = await fetch(`${baseUrl}/api/v1/me`, {
    headers: asHost('metrion.woofi-developments.at'),
    redirect: 'manual',
  });
  assert.notEqual(response.status, 308);
});

test('the liveness health check on the old host still answers 200, not a redirect', async () => {
  const response = await fetch(`${baseUrl}/api/v1/health/liveness`, {
    headers: asHost(OLD_HOST),
    redirect: 'manual',
  });
  assert.equal(response.status, 200);
});

test('a non-GET/HEAD request is untouched by this middleware', async () => {
  const response = await fetch(`${baseUrl}/api/v1/keys/00000000-0000-0000-0000-000000000000`, {
    method: 'DELETE',
    headers: asHost(OLD_HOST),
    redirect: 'manual',
  });
  // same-origin.ts refuses it (403) rather than canonical-host.ts redirecting
  // it (308) - proof this middleware only ever acts on GET/HEAD.
  assert.notEqual(response.status, 308);
});
