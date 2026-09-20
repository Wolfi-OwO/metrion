import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import './with-origin.ts';

const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://example.test';
process.env['PUBLIC_BASE_URL'] = 'https://viewer.example.test';
process.env['SESSION_SECRET'] = 'projects-test-session-secret';
process.env['OAUTH_GOOGLE_CLIENT_ID'] = 'projects-test-google-client';
process.env['OAUTH_GOOGLE_CLIENT_SECRET'] = 'projects-test-google-secret';
process.env['OAUTH_MICROSOFT_CLIENT_ID'] = 'projects-test-microsoft-client';
process.env['OAUTH_MICROSOFT_CLIENT_SECRET'] = 'projects-test-microsoft-secret';
process.env['OAUTH_GITHUB_CLIENT_ID'] = 'projects-test-github-client';
process.env['OAUTH_GITHUB_CLIENT_SECRET'] = 'projects-test-github-secret';

const { app } = await import('../dist/main.js');
const { createPool } = await import('@metrion/db/dist/pool.js');
const { setOAuthFetch } = await import('../dist/auth/providers.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `projects_test_${Date.now()}`;

/**
 * Only Google, and only a sign-in - this file's subject is the project/key
 * endpoints behind a session, not the provider mechanics `auth.test.ts`
 * already covers for all three. A minimal mocked Google, reused for two
 * distinct signed-in identities (`ownerA`/`ownerB`, below), is enough to get
 * two real, independent sessions to test ownership scoping with.
 */
const GOOGLE_ISSUER = 'https://accounts.google.com';
let currentSub = '';
let currentEmail = '';

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

const mockFetch: typeof fetch = async (input, init) => {
  const url = requestUrl(input);
  const method = (init?.method ?? 'GET').toUpperCase();

  if (url === `${GOOGLE_ISSUER}/.well-known/openid-configuration`) {
    return jsonResponse({
      issuer: GOOGLE_ISSUER,
      authorization_endpoint: `${GOOGLE_ISSUER}/authorize`,
      token_endpoint: `${GOOGLE_ISSUER}/token`,
      userinfo_endpoint: `${GOOGLE_ISSUER}/userinfo`,
      jwks_uri: `${GOOGLE_ISSUER}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
    });
  }
  if (url === `${GOOGLE_ISSUER}/token` && method === 'POST') {
    return jsonResponse({ access_token: 'google-access-token', token_type: 'Bearer' });
  }
  if (url === `${GOOGLE_ISSUER}/userinfo`) {
    return jsonResponse({ sub: currentSub, email: currentEmail });
  }

  throw new Error(`Unexpected fetch in projects.test.ts: ${method} ${url}`);
};

function cookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'expected a Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

/** Signs in as a distinct Google identity and returns its session cookie -
 * each call with a new `(sub, email)` produces a new, independent user. */
async function signInAs(sub: string, email: string): Promise<string> {
  currentSub = sub;
  currentEmail = email;

  const start = await fetch(`${baseUrl}/auth/google`, { redirect: 'manual' });
  const state = new URL(start.headers.get('location')!).searchParams.get('state');
  const callback = await fetch(
    `${baseUrl}/auth/google/callback?code=fake-code&state=${encodeURIComponent(state!)}`,
    { redirect: 'manual' },
  );
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
    `DELETE FROM api_keys WHERE project_id IN (
       SELECT id FROM projects WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1)
     )`,
    [`${marker}%`],
  );
  await fixturePool.query(
    `DELETE FROM projects WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE $1)`,
    [`${marker}%`],
  );
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

test('GET /api/v1/projects with no session is 401', async () => {
  const response = await fetch(`${baseUrl}/api/v1/projects`);
  assert.equal(response.status, 401);
});

test('POST /api/v1/projects creates a project owned by the caller, and GET lists it back', async () => {
  const cookie = await signInAs(`${marker}-owner-a`, `${marker}-owner-a@example.test`);

  const createResponse = await fetch(`${baseUrl}/api/v1/projects`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: `${marker} Project` }),
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as { id: string; slug: string; name: string };
  assert.equal(created.name, `${marker} Project`);
  assert.ok(created.slug.length > 0);

  const listResponse = await fetch(`${baseUrl}/api/v1/projects`, { headers: { cookie } });
  assert.equal(listResponse.status, 200);
  const body = (await listResponse.json()) as { projects: { id: string }[] };
  assert.ok(body.projects.some((project) => project.id === created.id));
});

test('two projects with the same name get different, non-colliding slugs', async () => {
  const cookie = await signInAs(`${marker}-owner-b`, `${marker}-owner-b@example.test`);

  const first = await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Same Name' }),
    })
  ).json();
  const second = await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Same Name' }),
    })
  ).json();

  assert.notEqual(
    (first as { slug: string }).slug,
    (second as { slug: string }).slug,
    'a name collision must not collide on the unique slug column',
  );
});

test('an API key is displayed once at creation and is unreadable afterwards', async () => {
  const cookie = await signInAs(`${marker}-owner-c`, `${marker}-owner-c@example.test`);
  const project = (await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${marker} Keys Project` }),
    })
  ).json()) as { id: string };

  const keyResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(keyResponse.status, 201);
  const key = (await keyResponse.json()) as { id: string; key: string; keyPrefix: string };
  const match = /^mtr_([^_]+)_(.+)$/.exec(key.key);
  assert.ok(match, `key must be shaped mtr_<prefix>_<secret>, got ${key.key}`);
  assert.equal(match![1], key.keyPrefix);

  const { rows } = await fixturePool.query<{ key_hash: Buffer }>(
    'SELECT key_hash FROM api_keys WHERE id = $1',
    [key.id],
  );
  assert.equal(
    Buffer.compare(rows[0]!.key_hash, createHash('sha256').update(match![2]!, 'utf8').digest()),
    0,
    'the stored hash must match the secret half of the displayed key, same construction as applications/ingest',
  );

  // The only place a key is ever returned is this one response - nothing
  // this app serves shows the secret, or even the hash, again.
  const listResponse = await fetch(`${baseUrl}/api/v1/projects`, { headers: { cookie } });
  const listBody = JSON.stringify(await listResponse.json());
  assert.equal(
    listBody.includes(match![2]!),
    false,
    'the raw secret must never reappear in any response',
  );
});

test('POST /api/v1/projects/:id/keys for a project owned by someone else is 404', async () => {
  const ownerCookie = await signInAs(`${marker}-owner-d`, `${marker}-owner-d@example.test`);
  const project = (await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${marker} Not Yours` }),
    })
  ).json()) as { id: string };

  const otherCookie = await signInAs(`${marker}-owner-e`, `${marker}-owner-e@example.test`);
  const response = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    method: 'POST',
    headers: { cookie: otherCookie },
  });
  assert.equal(response.status, 404);
});

test('GET /api/v1/projects/:id/keys lists metadata only, never the secret or its hash', async () => {
  const cookie = await signInAs(`${marker}-owner-g`, `${marker}-owner-g@example.test`);
  const project = (await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${marker} List Keys Project` }),
    })
  ).json()) as { id: string };

  const created = (await (
    await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
      method: 'POST',
      headers: { cookie },
    })
  ).json()) as { id: string; key: string; keyPrefix: string };

  const listResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    headers: { cookie },
  });
  assert.equal(listResponse.status, 200);
  const body = (await listResponse.json()) as {
    keys: {
      id: string;
      keyPrefix: string;
      createdAt: string;
      lastUsedAt: string | null;
      revokedAt: string | null;
    }[];
  };
  assert.equal(body.keys.length, 1);
  const row = body.keys[0]!;
  assert.equal(row.id, created.id);
  assert.equal(row.keyPrefix, created.keyPrefix);
  assert.equal(row.revokedAt, null);
  assert.equal(row.lastUsedAt, null);

  const secretHalf = /^mtr_[^_]+_(.+)$/.exec(created.key)![1]!;
  const rawBody = JSON.stringify(body);
  assert.equal(rawBody.includes(secretHalf), false, 'the secret must never appear in the list');
  assert.equal(
    'keyHash' in row || 'key_hash' in row,
    false,
    'the hash must never appear in the list',
  );
});

test('GET /api/v1/projects/:id/keys reflects a revocation', async () => {
  const cookie = await signInAs(`${marker}-owner-h`, `${marker}-owner-h@example.test`);
  const project = (await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${marker} Revoked Listing Project` }),
    })
  ).json()) as { id: string };
  const key = (await (
    await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
      method: 'POST',
      headers: { cookie },
    })
  ).json()) as { id: string };

  await fetch(`${baseUrl}/api/v1/keys/${key.id}`, { method: 'DELETE', headers: { cookie } });

  const listResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    headers: { cookie },
  });
  const body = (await listResponse.json()) as { keys: { id: string; revokedAt: string | null }[] };
  assert.ok(body.keys[0]!.revokedAt !== null);
});

test('GET /api/v1/projects/:id/keys for a project owned by someone else is 404', async () => {
  const ownerCookie = await signInAs(`${marker}-owner-i`, `${marker}-owner-i@example.test`);
  const project = (await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie: ownerCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${marker} Not Yours For Listing` }),
    })
  ).json()) as { id: string };
  await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    method: 'POST',
    headers: { cookie: ownerCookie },
  });

  const otherCookie = await signInAs(`${marker}-owner-j`, `${marker}-owner-j@example.test`);
  const response = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(response.status, 404);
});

test('GET /api/v1/projects/:id/keys with no session is 401', async () => {
  const cookie = await signInAs(`${marker}-owner-k`, `${marker}-owner-k@example.test`);
  const project = (await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${marker} No Session Listing Project` }),
    })
  ).json()) as { id: string };

  const response = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`);
  assert.equal(response.status, 401);
});

test('DELETE /api/v1/keys/:id revokes the key; a repeat delete is 404', async () => {
  const cookie = await signInAs(`${marker}-owner-f`, `${marker}-owner-f@example.test`);
  const project = (await (
    await fetch(`${baseUrl}/api/v1/projects`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: `${marker} Revoke Project` }),
    })
  ).json()) as { id: string };
  const key = (await (
    await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
      method: 'POST',
      headers: { cookie },
    })
  ).json()) as { id: string };

  const deleteResponse = await fetch(`${baseUrl}/api/v1/keys/${key.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(deleteResponse.status, 204);

  const { rows } = await fixturePool.query<{ revoked_at: Date | null }>(
    'SELECT revoked_at FROM api_keys WHERE id = $1',
    [key.id],
  );
  assert.ok(rows[0]!.revoked_at !== null);

  const repeat = await fetch(`${baseUrl}/api/v1/keys/${key.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(repeat.status, 404, 'an already-revoked key must not be revocable again');
});
