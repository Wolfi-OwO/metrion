import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import './with-origin.ts';

const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';
process.env['CORS_ALLOWED_ORIGINS'] = 'https://example.test';
process.env['PUBLIC_BASE_URL'] = 'https://viewer.example.test';
process.env['SESSION_SECRET'] = 'thresholds-test-session-secret';
process.env['OAUTH_GOOGLE_CLIENT_ID'] = 'thresholds-test-google-client';
process.env['OAUTH_GOOGLE_CLIENT_SECRET'] = 'thresholds-test-google-secret';
process.env['OAUTH_MICROSOFT_CLIENT_ID'] = 'thresholds-test-microsoft-client';
process.env['OAUTH_MICROSOFT_CLIENT_SECRET'] = 'thresholds-test-microsoft-secret';
process.env['OAUTH_GITHUB_CLIENT_ID'] = 'thresholds-test-github-client';
process.env['OAUTH_GITHUB_CLIENT_SECRET'] = 'thresholds-test-github-secret';

const { app } = await import('../dist/main.js');
const { createPool } = await import('@metrion/db/dist/pool.js');
const { setOAuthFetch } = await import('../dist/auth/providers.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `thresholds_test_${Date.now()}`;

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

  throw new Error(`Unexpected fetch in thresholds.test.ts: ${method} ${url}`);
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
  // The OAuth binding cookie a browser would send back with the callback.
  const oauthCookie = start.headers
    .getSetCookie()
    .map((h) => h.split(';')[0]!)
    .find((pair) => pair.startsWith('__Host-mtr_oauth='));
  const callback = await fetch(
    `${baseUrl}/auth/google/callback?code=fake-code&state=${encodeURIComponent(state!)}`,
    { redirect: 'manual', headers: { cookie: oauthCookie! } },
  );
  return cookiePair(
    callback.headers.getSetCookie().find((h) => h.startsWith('__Host-mtr_session=')) ?? null,
  );
}

interface ProjectBody {
  id: string;
}
interface ApplicationBody {
  id: string;
  key: string;
}
interface ThresholdBody {
  id: string;
  applicationId: string | null;
  direction: string;
  warningValue: number | null;
  criticalValue: number | null;
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

async function mustCreateApplication(
  cookie: string,
  projectId: string,
  key: string,
  displayName: string,
): Promise<ApplicationBody> {
  const res = await fetch(`${baseUrl}/api/v1/projects/${projectId}/applications`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ key, displayName }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, `application creation failed: ${text}`);
  return JSON.parse(text) as ApplicationBody;
}

function createThreshold(
  cookie: string,
  projectId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/projects/${projectId}/thresholds`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Directly seeds `threshold_status`, standing in for the evaluator (#22),
 * which does not exist yet - exactly what issue #20's own acceptance
 * criteria call for. */
async function seedThresholdStatus(
  thresholdId: string,
  state: 'ok' | 'warning' | 'critical',
  value: number,
): Promise<void> {
  await fixturePool.query(
    `INSERT INTO threshold_status (threshold_id, sub_resource_key, state, reason, value, since)
     VALUES ($1, '', $2, 'threshold', $3, now())`,
    [thresholdId, state, value],
  );
}

async function seedStatusEvent(
  projectId: string,
  thresholdId: string,
  fromState: string,
  toState: string,
): Promise<void> {
  await fixturePool.query(
    `INSERT INTO status_events (project_id, threshold_id, from_state, to_state, value, at)
     VALUES ($1, $2, $3, $4, 99, now())`,
    [projectId, thresholdId, fromState, toState],
  );
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

test('GET /api/v1/projects/:id/thresholds with no session is 401', async () => {
  const response = await fetch(
    `${baseUrl}/api/v1/projects/00000000-0000-0000-0000-000000000000/thresholds`,
  );
  assert.equal(response.status, 401);
});

test('POST /thresholds creates one and GET lists it back', async () => {
  const cookie = await signInAs(`${marker}-a`, `${marker}-a@example.test`);
  const project = await createProject(cookie, `${marker} Create Project`);
  const application = await mustCreateApplication(cookie, project.id, 'threshold-app', 'App');

  const response = await createThreshold(cookie, project.id, {
    applicationId: application.id,
    metricName: 'cpu.usage',
    direction: 'above',
    warningValue: 70,
    criticalValue: 90,
  });
  const responseText = await response.text();
  assert.equal(response.status, 201, responseText);
  const created = JSON.parse(responseText) as ThresholdBody;
  assert.equal(created.direction, 'above');
  assert.equal(created.warningValue, 70);
  assert.equal(created.criticalValue, 90);

  const listResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/thresholds`, {
    headers: { cookie },
  });
  assert.equal(listResponse.status, 200);
  const body = (await listResponse.json()) as { thresholds: ThresholdBody[] };
  assert.ok(body.thresholds.some((t) => t.id === created.id));
});

test('a "below" threshold with warningValue < criticalValue is rejected on create', async () => {
  const cookie = await signInAs(`${marker}-b`, `${marker}-b@example.test`);
  const project = await createProject(cookie, `${marker} Below Reject Project`);

  // direction "below": lower is worse, so criticalValue must be <= warningValue.
  // Sending criticalValue (50) greater than warningValue (10) is backwards.
  const response = await createThreshold(cookie, project.id, {
    metricName: 'memory.free',
    direction: 'below',
    warningValue: 10,
    criticalValue: 50,
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { issues?: { path: string }[] };
  assert.ok(body.issues?.some((issue) => issue.path === 'criticalValue'));
});

test('an "above" threshold with warningValue > criticalValue is rejected on create', async () => {
  const cookie = await signInAs(`${marker}-c`, `${marker}-c@example.test`);
  const project = await createProject(cookie, `${marker} Above Reject Project`);

  const response = await createThreshold(cookie, project.id, {
    metricName: 'cpu.usage',
    direction: 'above',
    warningValue: 90,
    criticalValue: 70,
  });
  assert.equal(response.status, 400);
});

test('PATCH /thresholds/:id merges onto the existing row before re-checking direction ordering', async () => {
  const cookie = await signInAs(`${marker}-d`, `${marker}-d@example.test`);
  const project = await createProject(cookie, `${marker} Patch Project`);

  const created = (await (
    await createThreshold(cookie, project.id, {
      metricName: 'memory.free',
      direction: 'below',
      warningValue: 500,
      criticalValue: 100,
    })
  ).json()) as ThresholdBody;

  // Only warningValue changes; direction ("below") and criticalValue (100)
  // come from the existing row - 50 < 100 breaks the "below" ordering.
  const badPatch = await fetch(`${baseUrl}/api/v1/thresholds/${created.id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ warningValue: 50 }),
  });
  assert.equal(badPatch.status, 400);

  const goodPatch = await fetch(`${baseUrl}/api/v1/thresholds/${created.id}`, {
    method: 'PATCH',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ warningValue: 200 }),
  });
  assert.equal(goodPatch.status, 200);
  const updated = (await goodPatch.json()) as ThresholdBody;
  assert.equal(updated.warningValue, 200);
  assert.equal(updated.criticalValue, 100, 'untouched fields must survive a partial PATCH');
});

test('DELETE /thresholds/:id removes it', async () => {
  const cookie = await signInAs(`${marker}-e`, `${marker}-e@example.test`);
  const project = await createProject(cookie, `${marker} Delete Project`);
  const created = (await (
    await createThreshold(cookie, project.id, {
      metricName: 'cpu.usage',
      direction: 'above',
      warningValue: 70,
      criticalValue: 90,
    })
  ).json()) as ThresholdBody;

  const deleteResponse = await fetch(`${baseUrl}/api/v1/thresholds/${created.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(deleteResponse.status, 204);

  const repeat = await fetch(`${baseUrl}/api/v1/thresholds/${created.id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  assert.equal(repeat.status, 404);
});

test("thresholds and status for another user's project are 404, never 403", async () => {
  const ownerCookie = await signInAs(`${marker}-f1`, `${marker}-f1@example.test`);
  const project = await createProject(ownerCookie, `${marker} Not Yours`);
  const created = (await (
    await createThreshold(ownerCookie, project.id, {
      metricName: 'cpu.usage',
      direction: 'above',
      warningValue: 70,
      criticalValue: 90,
    })
  ).json()) as ThresholdBody;

  const otherCookie = await signInAs(`${marker}-f2`, `${marker}-f2@example.test`);

  const listResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/thresholds`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(listResponse.status, 404);

  const patchResponse = await fetch(`${baseUrl}/api/v1/thresholds/${created.id}`, {
    method: 'PATCH',
    headers: { cookie: otherCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ warningValue: 1 }),
  });
  assert.equal(patchResponse.status, 404);

  const deleteResponse = await fetch(`${baseUrl}/api/v1/thresholds/${created.id}`, {
    method: 'DELETE',
    headers: { cookie: otherCookie },
  });
  assert.equal(deleteResponse.status, 404);

  const statusResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/status`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(statusResponse.status, 404);

  const eventsResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/status/events`, {
    headers: { cookie: otherCookie },
  });
  assert.equal(eventsResponse.status, 404);
});

test('GET /status answers ok for every application when threshold_status has no rows yet', async () => {
  const cookie = await signInAs(`${marker}-g`, `${marker}-g@example.test`);
  const project = await createProject(cookie, `${marker} No Data Project`);
  const application = await mustCreateApplication(cookie, project.id, 'no-data-app', 'App');
  await createThreshold(cookie, project.id, {
    applicationId: application.id,
    metricName: 'cpu.usage',
    direction: 'above',
    warningValue: 70,
    criticalValue: 90,
  });

  const response = await fetch(`${baseUrl}/api/v1/projects/${project.id}/status`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    applications: { id: string; status: string; effectiveStatus: string; causedBy: unknown }[];
  };
  const found = body.applications.find((a) => a.id === application.id);
  assert.ok(found);
  assert.equal(
    found!.status,
    'ok',
    'no evaluator has run yet - expected and correct, per issue #20',
  );
  assert.equal(found!.effectiveStatus, 'ok');
  assert.equal(found!.causedBy, null);
});

test('GET /status computes effectiveStatus/causedBy from a failing transitive dependency', async () => {
  const cookie = await signInAs(`${marker}-h`, `${marker}-h@example.test`);
  const project = await createProject(cookie, `${marker} Dependency Status Project`);

  const checkout = await mustCreateApplication(cookie, project.id, 'status-checkout', 'Checkout');
  const payments = await mustCreateApplication(cookie, project.id, 'status-payments', 'Payments');
  const database = await mustCreateApplication(cookie, project.id, 'status-database', 'Database');

  // checkout -> payments -> database, so database's failure must reach
  // checkout even though checkout does not depend on it directly.
  await fetch(`${baseUrl}/api/v1/projects/${project.id}/applications/${checkout.id}/dependencies`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dependsOn: [payments.id] }),
  });
  await fetch(`${baseUrl}/api/v1/projects/${project.id}/applications/${payments.id}/dependencies`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ dependsOn: [database.id] }),
  });

  const threshold = (await (
    await createThreshold(cookie, project.id, {
      applicationId: database.id,
      metricName: 'connections.available',
      direction: 'below',
      warningValue: 10,
      criticalValue: 2,
    })
  ).json()) as ThresholdBody;

  // The evaluator (#22) does not exist yet - seed the row it would have
  // written directly, per issue #20's own acceptance criteria.
  await seedThresholdStatus(threshold.id, 'critical', 0);
  await seedStatusEvent(project.id, threshold.id, 'ok', 'critical');

  const response = await fetch(`${baseUrl}/api/v1/projects/${project.id}/status`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    applications: {
      id: string;
      key: string;
      status: string;
      effectiveStatus: string;
      causedBy: { id: string; key: string } | null;
    }[];
  };

  const databaseStatus = body.applications.find((a) => a.id === database.id)!;
  assert.equal(databaseStatus.status, 'critical');
  assert.equal(databaseStatus.effectiveStatus, 'critical');
  assert.equal(databaseStatus.causedBy, null, 'its own failure is not attributed to a dependency');

  const paymentsStatus = body.applications.find((a) => a.id === payments.id)!;
  assert.equal(paymentsStatus.status, 'ok', "payments' own thresholds never fired");
  assert.equal(
    paymentsStatus.effectiveStatus,
    'critical',
    'worse than its own status via its dependency',
  );
  assert.equal(paymentsStatus.causedBy?.id, database.id);
  assert.equal(paymentsStatus.causedBy?.key, 'status-database');

  const checkoutStatus = body.applications.find((a) => a.id === checkout.id)!;
  assert.equal(checkoutStatus.status, 'ok');
  assert.equal(
    checkoutStatus.effectiveStatus,
    'critical',
    'must propagate through a TRANSITIVE dependency, not only a direct one',
  );
  assert.equal(checkoutStatus.causedBy?.id, database.id);

  const eventsResponse = await fetch(
    `${baseUrl}/api/v1/projects/${project.id}/status/events?limit=10`,
    {
      headers: { cookie },
    },
  );
  assert.equal(eventsResponse.status, 200);
  const eventsBody = (await eventsResponse.json()) as {
    events: { thresholdId: string; fromState: string; toState: string }[];
  };
  assert.ok(
    eventsBody.events.some((e) => e.thresholdId === threshold.id && e.toState === 'critical'),
  );

  // Never a colour - always exactly one of ok/warning/critical.
  const raw = JSON.stringify(body);
  assert.equal(/#[0-9a-fA-F]{3,6}/.test(raw), false, 'the API must never emit a hex colour');
});
