import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import './with-origin.ts';

/**
 * Matches `docker-compose.dev.yml` / `@metrion/db`'s own local-dev default.
 * Requires `docker compose -f docker-compose.dev.yml up -d` beforehand, same
 * as the other `applications/viewer` and `applications/ingest` tests.
 */
const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://example.test';
process.env['PUBLIC_BASE_URL'] = 'https://viewer.example.test';
process.env['SESSION_SECRET'] = 'auth-test-session-secret';
// No real client credentials required - `setOAuthFetch` below intercepts
// every outbound call this task's provider code makes, per the issue's own
// acceptance criteria ("test against a mocked OAuth provider").
process.env['OAUTH_GOOGLE_CLIENT_ID'] = 'auth-test-google-client';
process.env['OAUTH_GOOGLE_CLIENT_SECRET'] = 'auth-test-google-secret';
process.env['OAUTH_MICROSOFT_CLIENT_ID'] = 'auth-test-microsoft-client';
process.env['OAUTH_MICROSOFT_CLIENT_SECRET'] = 'auth-test-microsoft-secret';
process.env['OAUTH_GITHUB_CLIENT_ID'] = 'auth-test-github-client';
process.env['OAUTH_GITHUB_CLIENT_SECRET'] = 'auth-test-github-secret';

const { app } = await import('../dist/main.js');
const { createPool } = await import('@metrion/db/dist/pool.js');
const { setOAuthFetch } = await import('../dist/auth/providers.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `auth_test_${Date.now()}`;

interface MockProfile {
  sub: string;
  email: string;
}

/** One mutable "current profile" per provider - tests reassign these to
 * drive the "same subject, changed email" and "sign-in with each provider"
 * scenarios without needing a second mock server. */
const mockProfiles: Record<'google' | 'microsoft' | 'github', MockProfile> = {
  google: { sub: `${marker}-google-sub`, email: `${marker}-google-1@example.test` },
  microsoft: { sub: `${marker}-microsoft-sub`, email: `${marker}-microsoft-1@example.test` },
  github: { sub: '910001', email: `${marker}-github-1@example.test` },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A real OIDC discovery document's shape, minimal to what `providers.ts`'s
 * `oidcProvider` actually reads: `issuer` (validated against the requested
 * URL by `openid-client` itself), and the three endpoints it calls. */
function discoveryDocument(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    userinfo_endpoint: `${issuer}/userinfo`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
  };
}

const GOOGLE_ISSUER = 'https://accounts.google.com';
const MICROSOFT_ISSUER = 'https://login.microsoftonline.com/common/v2.0';

/**
 * The mocked provider responder every test in this file runs against - the
 * seam `setOAuthFetch` (`auth/providers.ts`) exists for. Handles Google's and
 * Microsoft's OIDC discovery + token + userinfo endpoints, and GitHub's two
 * hand-rolled ones.
 */
const mockFetch: typeof fetch = async (input, init) => {
  const url = requestUrl(input);
  const method = (init?.method ?? 'GET').toUpperCase();

  if (url === `${GOOGLE_ISSUER}/.well-known/openid-configuration`) {
    return jsonResponse(discoveryDocument(GOOGLE_ISSUER));
  }
  if (url === `${GOOGLE_ISSUER}/token` && method === 'POST') {
    return jsonResponse({ access_token: 'google-access-token', token_type: 'Bearer' });
  }
  if (url === `${GOOGLE_ISSUER}/userinfo`) {
    return jsonResponse({ sub: mockProfiles.google.sub, email: mockProfiles.google.email });
  }

  if (url === `${MICROSOFT_ISSUER}/.well-known/openid-configuration`) {
    return jsonResponse(discoveryDocument(MICROSOFT_ISSUER));
  }
  if (url === `${MICROSOFT_ISSUER}/token` && method === 'POST') {
    return jsonResponse({ access_token: 'microsoft-access-token', token_type: 'Bearer' });
  }
  if (url === `${MICROSOFT_ISSUER}/userinfo`) {
    return jsonResponse({ sub: mockProfiles.microsoft.sub, email: mockProfiles.microsoft.email });
  }

  if (url === 'https://github.com/login/oauth/access_token' && method === 'POST') {
    return jsonResponse({ access_token: 'github-access-token', token_type: 'bearer' });
  }
  if (url === 'https://api.github.com/user') {
    return jsonResponse({ id: Number(mockProfiles.github.sub), email: mockProfiles.github.email });
  }

  throw new Error(`Unexpected fetch in auth.test.ts: ${method} ${url}`);
};

/** Extracts just `name=value` from a `Set-Cookie` response header, dropping
 * `Path`/`HttpOnly`/`Secure`/`SameSite`/`Expires` - a `fetch`-driven test has
 * no cookie jar of its own, so this is what stands in for a browser
 * forwarding the cookie on the next request. */
function cookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'expected a Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

/** Drives `GET /auth/:provider` then `GET /auth/:provider/callback`, and
 * returns the `Set-Cookie` pair from a successful sign-in. */
async function signIn(provider: string): Promise<string> {
  const start = await fetch(`${baseUrl}/auth/${provider}`, { redirect: 'manual' });
  assert.equal(start.status, 302, `${provider}: GET /auth/${provider} must redirect`);
  const location = new URL(start.headers.get('location')!);
  const state = location.searchParams.get('state');
  assert.ok(state, `${provider}: authorization URL must carry a state`);

  const callback = await fetch(
    `${baseUrl}/auth/${provider}/callback?code=fake-code&state=${encodeURIComponent(state)}`,
    { redirect: 'manual' },
  );
  assert.equal(callback.status, 302, `${provider}: callback must redirect on success`);
  return cookiePair(callback.headers.get('set-cookie'));
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const liveness = await fetch(`${baseUrl}/api/v1/health/liveness`);
  assert.equal(liveness.status, 200, 'liveness must not require a database connection');

  process.env['DATABASE_URL'] = REAL_DATABASE_URL;
  fixturePool = createPool(REAL_DATABASE_URL);
  setOAuthFetch(mockFetch);
});

after(async () => {
  await fixturePool.query(
    `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`${marker}%`],
  );
  await fixturePool.query(
    `DELETE FROM identities WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`${marker}%`],
  );
  await fixturePool.query('DELETE FROM users WHERE email LIKE $1', [`${marker}%`]);
  await fixturePool.end();
  setOAuthFetch(undefined);
  await new Promise((resolve) => server.close(resolve));
});

for (const provider of ['google', 'microsoft', 'github'] as const) {
  test(`sign-in with ${provider} against a mocked provider produces one users row and one identities row`, async () => {
    const cookie = await signIn(provider);

    const { rows } = await fixturePool.query(
      `SELECT u.id AS user_id, u.email, i.provider, i.provider_subject
         FROM identities i JOIN users u ON u.id = i.user_id
        WHERE i.provider = $1 AND i.provider_subject = $2`,
      [provider, mockProfiles[provider].sub],
    );
    assert.equal(rows.length, 1, `expected exactly one identity for ${provider}`);
    assert.equal(rows[0].email, mockProfiles[provider].email);

    const me = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } });
    assert.equal(me.status, 200);
    const meBody = (await me.json()) as { id: string; email: string };
    assert.equal(meBody.id, rows[0].user_id);
    assert.equal(meBody.email, mockProfiles[provider].email);
  });
}

test('a second sign-in with the same provider subject but a changed email reuses the existing user', async () => {
  const first = await signIn('google');
  const firstMe = await (
    await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie: first } })
  ).json();

  mockProfiles.google = { ...mockProfiles.google, email: `${marker}-google-2@example.test` };

  const second = await signIn('google');
  const secondMe = (await (
    await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie: second } })
  ).json()) as { id: string; email: string };

  assert.equal(secondMe.id, (firstMe as { id: string }).id, 'must be the same user id');
  assert.equal(secondMe.email, `${marker}-google-2@example.test`, 'must reflect the new email');

  const { rows } = await fixturePool.query(
    'SELECT count(*)::int AS count FROM identities WHERE provider = $1 AND provider_subject = $2',
    ['google', mockProfiles.google.sub],
  );
  assert.equal(rows[0].count, 1, 'must still be exactly one identity row, not two');
});

test('a callback with a mismatched state is rejected', async () => {
  const start = await fetch(`${baseUrl}/auth/google`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location')!);
  assert.ok(location.searchParams.get('state'));

  const response = await fetch(
    `${baseUrl}/auth/google/callback?code=fake-code&state=not-the-state-we-issued`,
    { redirect: 'manual' },
  );
  assert.equal(response.status, 401);
});

test('an unknown provider name is rejected before any provider call is made', async () => {
  const response = await fetch(`${baseUrl}/auth/not-a-real-provider`, { redirect: 'manual' });
  assert.equal(response.status, 404);
});

test('logout invalidates the session row, so a replayed cookie returns 401', async () => {
  const cookie = await signIn('microsoft');

  const beforeLogout = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } });
  assert.equal(beforeLogout.status, 200);

  const logoutResponse = await fetch(`${baseUrl}/auth/logout`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(logoutResponse.status, 204);

  const replayed = await fetch(`${baseUrl}/api/v1/me`, { headers: { cookie } });
  assert.equal(replayed.status, 401, 'a replayed cookie after logout must be rejected');
});

test('GET /api/v1/me with no cookie is 401', async () => {
  const response = await fetch(`${baseUrl}/api/v1/me`);
  assert.equal(response.status, 401);
});
