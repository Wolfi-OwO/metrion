import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://example.test';
process.env['PUBLIC_BASE_URL'] = 'https://viewer.example.test';
process.env['SESSION_SECRET'] = 'applications-test-session-secret';
process.env['OAUTH_GOOGLE_CLIENT_ID'] = 'applications-test-google-client';
process.env['OAUTH_GOOGLE_CLIENT_SECRET'] = 'applications-test-google-secret';
process.env['OAUTH_MICROSOFT_CLIENT_ID'] = 'applications-test-microsoft-client';
process.env['OAUTH_MICROSOFT_CLIENT_SECRET'] = 'applications-test-microsoft-secret';
process.env['OAUTH_GITHUB_CLIENT_ID'] = 'applications-test-github-client';
process.env['OAUTH_GITHUB_CLIENT_SECRET'] = 'applications-test-github-secret';

const { app } = await import('../dist/main.js');
const { createPool } = await import('@metrion/db/dist/pool.js');
const { setOAuthFetch } = await import('../dist/auth/providers.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `applications_test_${Date.now()}`;

/** Same minimal single-provider Google mock `tests/projects.test.ts` uses,
 * reused per distinct `(sub, email)` pair for two independent identities. */
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

  throw new Error(`Unexpected fetch in applications.test.ts: ${method} ${url}`);
};

function cookiePair(setCookieHeader: string | null): string {
  assert.ok(setCookieHeader, 'expected a Set-Cookie header');
  return setCookieHeader.split(';')[0]!;
}

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

interface ProjectBody {
  id: string;
}
interface ApplicationBody {
  id: string;
  key: string;
  displayName: string | null;
}

async function createProject(cookie: string, name: string): Promise<ProjectBody> {
  const res = await fetch(`${baseUrl}/api/v1/projects`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, `project creation failed: ${text}`);
  return JSON.parse(text) as ProjectBody;
}

function createApplication(
  cookie: string,
  projectId: string,
  key: string,
  displayName: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/projects/${projectId}/applications`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ key, displayName }),
  });
}

async function mustCreateApplication(
  cookie: string,
  projectId: string,
  key: string,
  displayName: string,
): Promise<ApplicationBody> {
  const res = await createApplication(cookie, projectId, key, displayName);
  const text = await res.text();
  assert.equal(res.status, 201, `application creation failed: ${text}`);
  return JSON.parse(text) as ApplicationBody;
}

function putDependencies(
  cookie: string,
  applicationId: string,
  dependsOn: string[],
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/applications/${applicationId}/dependencies`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dependsOn }),
  });
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
  // `api_keys.project_id` has no `ON DELETE CASCADE` (unlike applications/
  // thresholds/dependencies) - same reason `tests/projects.test.ts`'s own
  // `after()` deletes these first.
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

test('GET /api/v1/projects/:id/applications with no session is 401', async () => {
  const response = await fetch(
    `${baseUrl}/api/v1/projects/00000000-0000-0000-0000-000000000000/applications`,
  );
  assert.equal(response.status, 401);
});

test('POST /applications rejects a key that does not match the ingest IDENTIFIER charset', async () => {
  const cookie = await signInAs(`${marker}-a`, `${marker}-a@example.test`);
  const project = await createProject(cookie, `${marker} Charset Project`);

  const response = await createApplication(cookie, project.id, 'not a valid key!', 'Bad Key');
  assert.equal(response.status, 400);
});

test('POST /applications creates one; GET lists it back with a status', async () => {
  const cookie = await signInAs(`${marker}-b`, `${marker}-b@example.test`);
  const project = await createProject(cookie, `${marker} List Project`);

  const created = await mustCreateApplication(cookie, project.id, 'checkout-api', 'Checkout API');
  assert.equal(created.key, 'checkout-api');
  assert.equal(created.displayName, 'Checkout API');

  const listResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/applications`, {
    headers: { cookie },
  });
  assert.equal(listResponse.status, 200);
  const body = (await listResponse.json()) as {
    applications: { id: string; key: string; status: string }[];
  };
  const found = body.applications.find((a) => a.id === created.id);
  assert.ok(found, 'the created application must be listed');
  assert.equal(
    found!.status,
    'ok',
    'no threshold data yet must answer ok, not a fourth status value',
  );
});

test('a duplicate key in the same project is rejected with 409', async () => {
  const cookie = await signInAs(`${marker}-c`, `${marker}-c@example.test`);
  const project = await createProject(cookie, `${marker} Duplicate Project`);

  await mustCreateApplication(cookie, project.id, 'dup-app', 'First');
  const second = await createApplication(cookie, project.id, 'dup-app', 'Second');
  assert.equal(second.status, 409);
});

test('PATCH /applications/:id renames displayName; key is immutable and rejected if sent', async () => {
  const cookie = await signInAs(`${marker}-d`, `${marker}-d@example.test`);
  const project = await createProject(cookie, `${marker} Patch Project`);
  const app1 = await mustCreateApplication(cookie, project.id, 'patch-app', 'Old Name');

  const rejected = await fetch(`${baseUrl}/api/v1/applications/${app1.id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ key: 'renamed-app', displayName: 'New Name' }),
  });
  assert.equal(rejected.status, 400, '`key` must not be an accepted field on PATCH');

  const accepted = await fetch(`${baseUrl}/api/v1/applications/${app1.id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'New Name' }),
  });
  assert.equal(accepted.status, 200);
  const updated = (await accepted.json()) as ApplicationBody;
  assert.equal(updated.key, 'patch-app', 'key must never change');
  assert.equal(updated.displayName, 'New Name');
});

test('DELETE /applications/:id cascades dependencies and thresholds, and states metrics are kept', async () => {
  const cookie = await signInAs(`${marker}-e`, `${marker}-e@example.test`);
  const project = await createProject(cookie, `${marker} Delete Project`);
  const dependent = await mustCreateApplication(
    cookie,
    project.id,
    'delete-dependent',
    'Dependent',
  );
  const dependency = await mustCreateApplication(
    cookie,
    project.id,
    'delete-dependency',
    'Dependency',
  );

  const putResponse = await putDependencies(cookie, dependent.id, [dependency.id]);
  assert.equal(putResponse.status, 200);

  const thresholdResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/thresholds`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      applicationId: dependency.id,
      metricName: 'cpu.usage',
      direction: 'above',
      warningValue: 70,
      criticalValue: 90,
    }),
  });
  assert.equal(thresholdResponse.status, 201);

  const deleteResponse = await fetch(`${baseUrl}/api/v1/applications/${dependency.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(deleteResponse.status, 200);
  const deleteBody = (await deleteResponse.json()) as { deleted: boolean; message: string };
  assert.equal(deleteBody.deleted, true);
  assert.match(deleteBody.message, /metrics/i, 'response must state historical metrics are kept');

  const { rows: thresholdRows } = await fixturePool.query(
    'SELECT id FROM thresholds WHERE application_id = $1',
    [dependency.id],
  );
  assert.equal(thresholdRows.length, 0, 'thresholds must cascade with the application');

  const { rows: depRows } = await fixturePool.query(
    'SELECT * FROM application_dependencies WHERE dependent_id = $1 OR depends_on_id = $1',
    [dependency.id],
  );
  assert.equal(depRows.length, 0, 'dependency edges must cascade with the application');
});

test('GET/PUT dependencies: replaces the set, both directions read back correctly', async () => {
  const cookie = await signInAs(`${marker}-f`, `${marker}-f@example.test`);
  const project = await createProject(cookie, `${marker} Dependencies Project`);
  const checkout = await mustCreateApplication(cookie, project.id, 'dep-checkout', 'Checkout');
  const payments = await mustCreateApplication(cookie, project.id, 'dep-payments', 'Payments');

  const putResponse = await putDependencies(cookie, checkout.id, [payments.id]);
  assert.equal(putResponse.status, 200);

  const checkoutDeps = (await (
    await fetch(`${baseUrl}/api/v1/applications/${checkout.id}/dependencies`, {
      headers: { cookie },
    })
  ).json()) as { dependsOn: string[]; dependents: string[] };
  assert.deepEqual(checkoutDeps.dependsOn, [payments.id]);
  assert.deepEqual(checkoutDeps.dependents, []);

  const paymentsDeps = (await (
    await fetch(`${baseUrl}/api/v1/applications/${payments.id}/dependencies`, {
      headers: { cookie },
    })
  ).json()) as { dependsOn: string[]; dependents: string[] };
  assert.deepEqual(paymentsDeps.dependsOn, []);
  assert.deepEqual(paymentsDeps.dependents, [checkout.id]);

  // Replacing with an empty set clears it - a replace-the-set endpoint, not add/remove.
  const clearResponse = await putDependencies(cookie, checkout.id, []);
  assert.equal(clearResponse.status, 200);
  const cleared = (await (
    await fetch(`${baseUrl}/api/v1/applications/${checkout.id}/dependencies`, {
      headers: { cookie },
    })
  ).json()) as { dependsOn: string[] };
  assert.deepEqual(cleared.dependsOn, []);
});

test('PUT dependencies creating a cycle is rejected with 409 naming the path, and the edge set is unchanged', async () => {
  const cookie = await signInAs(`${marker}-g`, `${marker}-g@example.test`);
  const project = await createProject(cookie, `${marker} Cycle Project`);
  const a = await mustCreateApplication(cookie, project.id, 'cycle-a', 'A');
  const b = await mustCreateApplication(cookie, project.id, 'cycle-b', 'B');
  const c = await mustCreateApplication(cookie, project.id, 'cycle-c', 'C');

  assert.equal((await putDependencies(cookie, a.id, [b.id])).status, 200);
  assert.equal((await putDependencies(cookie, b.id, [c.id])).status, 200);

  const cycleResponse = await putDependencies(cookie, c.id, [a.id]);
  assert.equal(cycleResponse.status, 409);
  const cycleBody = (await cycleResponse.json()) as { message: string };
  assert.match(cycleBody.message, /cycle-c/);
  assert.match(cycleBody.message, /cycle-a/);
  assert.match(cycleBody.message, /cycle-b/);

  const cDeps = (await (
    await fetch(`${baseUrl}/api/v1/applications/${c.id}/dependencies`, { headers: { cookie } })
  ).json()) as { dependsOn: string[] };
  assert.deepEqual(
    cDeps.dependsOn,
    [],
    'a rejected write must leave the edge set exactly as it was',
  );
});

test('the database itself rejects a cross-tenant dependency edge, independent of any application-code check', async () => {
  const cookieA = await signInAs(`${marker}-h1`, `${marker}-h1@example.test`);
  const projectA = await createProject(cookieA, `${marker} Tenant A`);
  const appA = await mustCreateApplication(cookieA, projectA.id, 'tenant-a-app', 'A App');

  const cookieB = await signInAs(`${marker}-h2`, `${marker}-h2@example.test`);
  const projectB = await createProject(cookieB, `${marker} Tenant B`);
  const appB = await mustCreateApplication(cookieB, projectB.id, 'tenant-b-app', 'B App');

  await assert.rejects(
    () =>
      fixturePool.query(
        `INSERT INTO application_dependencies (project_id, dependent_id, depends_on_id)
         VALUES ($1, $2, $3)`,
        [projectA.id, appA.id, appB.id],
      ),
    (err: unknown) => {
      assert.equal(
        (err as { code?: string }).code,
        '23503',
        'must fail on the composite foreign key',
      );
      return true;
    },
  );
});

test("applications, dependencies and status for another user's project are 404, never 403", async () => {
  const ownerCookie = await signInAs(`${marker}-i`, `${marker}-i@example.test`);
  const project = await createProject(ownerCookie, `${marker} Not Yours`);
  const application = await mustCreateApplication(ownerCookie, project.id, 'not-yours-app', 'App');

  const otherCookie = await signInAs(`${marker}-j`, `${marker}-j@example.test`);

  const listResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/applications`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(listResponse.status, 404);

  const patchResponse = await fetch(`${baseUrl}/api/v1/applications/${application.id}`, {
    method: 'PATCH',
    headers: { cookie: otherCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName: 'Hijacked' }),
  });
  assert.equal(patchResponse.status, 404);

  const deleteResponse = await fetch(`${baseUrl}/api/v1/applications/${application.id}`, {
    method: 'DELETE',
    headers: { cookie: otherCookie },
  });
  assert.equal(deleteResponse.status, 404);

  const depsResponse = await fetch(
    `${baseUrl}/api/v1/applications/${application.id}/dependencies`,
    {
      headers: { cookie: otherCookie },
    },
  );
  assert.equal(depsResponse.status, 404);

  const putDepsResponse = await putDependencies(otherCookie, application.id, []);
  assert.equal(putDepsResponse.status, 404);

  const statusResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/status`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(statusResponse.status, 404);
});

test('POST /projects/:id/keys accepts an optional applicationId and states the binding', async () => {
  const cookie = await signInAs(`${marker}-k`, `${marker}-k@example.test`);
  const project = await createProject(cookie, `${marker} Key Binding Project`);
  const application = await mustCreateApplication(cookie, project.id, 'key-bound-app', 'Bound App');

  const boundResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ applicationId: application.id }),
  });
  assert.equal(boundResponse.status, 201);
  const bound = (await boundResponse.json()) as { applicationId: string | null; scope: string };
  assert.equal(bound.applicationId, application.id);
  assert.equal(bound.scope, 'application');

  const projectWideResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    method: 'POST',
    headers: { cookie },
  });
  assert.equal(
    projectWideResponse.status,
    201,
    'no body at all must still work, same as before #20',
  );
  const projectWide = (await projectWideResponse.json()) as {
    applicationId: string | null;
    scope: string;
  };
  assert.equal(projectWide.applicationId, null);
  assert.equal(projectWide.scope, 'project');
});

test('POST /projects/:id/keys with an applicationId from another project is 404', async () => {
  const ownerCookie = await signInAs(`${marker}-l1`, `${marker}-l1@example.test`);
  const project = await createProject(ownerCookie, `${marker} Key Owner Project`);

  const otherCookie = await signInAs(`${marker}-l2`, `${marker}-l2@example.test`);
  const otherProject = await createProject(otherCookie, `${marker} Key Other Project`);
  const otherApplication = await mustCreateApplication(
    otherCookie,
    otherProject.id,
    'other-project-app',
    'Other App',
  );

  const response = await fetch(`${baseUrl}/api/v1/projects/${project.id}/keys`, {
    method: 'POST',
    headers: { cookie: ownerCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ applicationId: otherApplication.id }),
  });
  assert.equal(response.status, 404);
});
