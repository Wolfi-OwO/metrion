import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

/**
 * Matches `docker-compose.dev.yml` / `@metrion/db`'s own local-dev default.
 * Requires `docker compose -f docker-compose.dev.yml up -d` beforehand, same
 * as `packages/db/tests/migrate.test.ts` and `applications/ingest/tests/ingest.test.ts`.
 */
const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

// Set to an address nothing answers on, BEFORE main.ts is ever imported -
// proves liveness needs no real connection, same reasoning as the ingest
// service's own test.
process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';

// The rest are all `requireEnv` presence checks too (issue #7, Task 6) - this
// file scopes every request with `setProjectIdsResolver` directly, so none of
// the auth machinery they gate is ever exercised for real here.
process.env['CORS_ALLOWED_ORIGINS'] = 'https://example.test';
process.env['PUBLIC_BASE_URL'] = 'https://viewer.example.test';
process.env['SESSION_SECRET'] = 'metrics-test-session-secret';
process.env['OAUTH_GOOGLE_CLIENT_ID'] = 'metrics-test';
process.env['OAUTH_GOOGLE_CLIENT_SECRET'] = 'metrics-test';
process.env['OAUTH_MICROSOFT_CLIENT_ID'] = 'metrics-test';
process.env['OAUTH_MICROSOFT_CLIENT_SECRET'] = 'metrics-test';
process.env['OAUTH_GITHUB_CLIENT_ID'] = 'metrics-test';
process.env['OAUTH_GITHUB_CLIENT_SECRET'] = 'metrics-test';

const { app } = await import('../dist/main.js');
const { createPool } = await import('@metrion/db/dist/pool.js');
const { setProjectIdsResolver } = await import('../dist/middlewares/project-scope.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `metrics_test_${Date.now()}`;
const ownerEmail = `${marker}@example.test`;

let projectAId: string;
let projectBId: string;

/**
 * The test-only side of `middlewares/project-scope.ts`'s seam: this is
 * exactly what issue #7 replaces with a real session -> project lookup,
 * called here directly because there is no session to derive it from yet.
 */
function scopeTo(projectIds: string[]): void {
  setProjectIdsResolver(() => projectIds);
}

interface ResourcesBody {
  resources: { resource: string; subResources: string[]; metricNames: string[] }[];
}

interface MetricsBody {
  source: 'raw' | 'hourly';
  series: { name: string; unit: string | null; points: { value: number; count: number }[] }[];
}

function getResources(from: Date, to: Date, projectId?: string): Promise<Response> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (projectId) params.set('projectId', projectId);
  return fetch(`${baseUrl}/api/v1/resources?${params}`);
}

function getMetrics(query: {
  resource: string;
  names: string[];
  from: Date;
  to: Date;
  stepSeconds: number;
  projectId?: string;
}): Promise<Response> {
  const params = new URLSearchParams({
    resource: query.resource,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    stepSeconds: String(query.stepSeconds),
  });
  for (const name of query.names) params.append('name', name);
  if (query.projectId) params.set('projectId', query.projectId);
  return fetch(`${baseUrl}/api/v1/metrics?${params}`);
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const liveness = await fetch(`${baseUrl}/api/v1/health/liveness`);
  assert.equal(liveness.status, 200, 'liveness must not require a database connection');

  // Only now does anything in this process touch a real database.
  process.env['DATABASE_URL'] = REAL_DATABASE_URL;
  fixturePool = createPool(REAL_DATABASE_URL);

  const userRow = await fixturePool.query<{ id: string }>(
    'INSERT INTO users (email) VALUES ($1) RETURNING id',
    [ownerEmail],
  );
  const userId = userRow.rows[0]!.id;

  const projectA = await fixturePool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [userId, `${marker}-a`, `${marker}-a`],
  );
  projectAId = projectA.rows[0]!.id;

  const projectB = await fixturePool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [userId, `${marker}-b`, `${marker}-b`],
  );
  projectBId = projectB.rows[0]!.id;

  // Project A: one recent point (the raw-table test) and two old points 30
  // minutes apart (the metrics_hourly test - close enough together to land
  // in the same hourly bucket, so their combined average is easy to check).
  const recentTime = new Date(Date.now() - 60 * 60 * 1000);
  const oldTime1 = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  const oldTime2 = new Date(oldTime1.getTime() + 30 * 60 * 1000);

  await fixturePool.query(
    `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
     VALUES
       ($1, $2, 'host-a', NULL, 'raw.metric', 40, 'percent', 60),
       ($3, $2, 'host-a', NULL, 'wide.metric', 40, 'percent', 60),
       ($4, $2, 'host-a', NULL, 'wide.metric', 60, 'percent', 60)`,
    [recentTime.toISOString(), projectAId, oldTime1.toISOString(), oldTime2.toISOString()],
  );

  // Project B: the SAME metric name projectA's raw-table row uses, under a
  // different resource and a value that must never surface for a caller
  // scoped to project A.
  await fixturePool.query(
    `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
     VALUES ($1, $2, 'host-b', NULL, 'raw.metric', 999, 'percent', 60)`,
    [recentTime.toISOString(), projectBId],
  );

  // Continuous aggregates refresh on a schedule/policy, not on INSERT - the
  // wide-range test needs this to actually see the rows just written.
  // Retried on 55P03 ("concurrent refresh"): `node --test` runs this file
  // alongside `tests/public-status.test.ts`, which refreshes the same
  // `metrics_hourly` aggregate in its own `before()`/test body - TimescaleDB
  // allows only one in-flight refresh per aggregate, not per window, so the
  // two can collide with no data-correctness issue, just a race to retry.
  await refreshMetricsHourly(fixturePool);
});

async function refreshMetricsHourly(pool: Pool): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query("CALL refresh_continuous_aggregate('metrics_hourly', NULL, NULL)");
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== '55P03' || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
}

after(async () => {
  await fixturePool.query('DELETE FROM metrics WHERE project_id = ANY($1)', [
    [projectAId, projectBId],
  ]);
  await fixturePool.query(
    'DELETE FROM projects WHERE owner_user_id = (SELECT id FROM users WHERE email = $1)',
    [ownerEmail],
  );
  await fixturePool.query('DELETE FROM users WHERE email = $1', [ownerEmail]);
  await fixturePool.end();
  scopeTo([]);
  await new Promise((resolve) => server.close(resolve));
});

test('GET /api/v1/metrics: scoped to A, reads its own recent row from the raw table', async () => {
  scopeTo([projectAId]);
  const response = await getMetrics({
    resource: 'host-a',
    names: ['raw.metric'],
    from: new Date(Date.now() - 6 * 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 60,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as MetricsBody;
  assert.equal(body.source, 'raw', 'a 6-hour range must be served by the raw table');
  assert.equal(body.series[0]!.points.length, 1);
  assert.equal(body.series[0]!.points[0]!.value, 40);
  assert.equal(body.series[0]!.unit, 'percent');
});

test("GET /api/v1/metrics: scoped to A, never returns B's row even under B's own resource/name", async () => {
  scopeTo([projectAId]);
  const response = await getMetrics({
    resource: 'host-b',
    names: ['raw.metric'],
    from: new Date(Date.now() - 6 * 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 60,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as MetricsBody;
  assert.equal(
    body.series[0]!.points.length,
    0,
    "the query layer must scope by project_id, not merely by resource/name - B's value (999) must never appear",
  );
});

test('GET /api/v1/metrics: a 30-day range is answered from metrics_hourly', async () => {
  scopeTo([projectAId]);
  const response = await getMetrics({
    resource: 'host-a',
    names: ['wide.metric'],
    from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 86_400,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as MetricsBody;
  assert.equal(body.source, 'hourly', 'a 30-day range must be served by metrics_hourly');
  assert.equal(body.series[0]!.points.length, 1);
  assert.equal(body.series[0]!.points[0]!.value, 50, 'weighted average of 40 and 60');
  assert.equal(body.series[0]!.points[0]!.count, 2);
  assert.equal(
    body.series[0]!.unit,
    'percent',
    'unit is not a metrics_hourly column - must fall back to the raw table',
  );
});

test('GET /api/v1/metrics: a range past the old 31-day cap is accepted, and the response carries no skippedLines', async () => {
  scopeTo([projectAId]);
  const response = await getMetrics({
    resource: 'host-a',
    names: ['wide.metric'],
    from: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 86_400,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal('skippedLines' in body, false);
});

test('GET /api/v1/metrics: no resolved project ids answers empty, not an error', async () => {
  scopeTo([]);
  const response = await getMetrics({
    resource: 'host-a',
    names: ['raw.metric'],
    from: new Date(Date.now() - 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 60,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as MetricsBody;
  assert.equal(body.series[0]!.points.length, 0);
});

test("GET /api/v1/resources: scoped to A, excludes B's resource", async () => {
  scopeTo([projectAId]);
  const response = await getResources(new Date(Date.now() - 11 * 24 * 60 * 60 * 1000), new Date());
  assert.equal(response.status, 200);
  const body = (await response.json()) as ResourcesBody;
  const resources = body.resources.map((entry) => entry.resource);
  assert.ok(resources.includes('host-a'));
  assert.equal(resources.includes('host-b'), false, "B's resource must not leak into A's listing");
});

/**
 * The gap this task closes: before `projectId`, a caller who owns both A and
 * B could only ever ask for the union of both - exactly what
 * `resolveProjectIdsFromSession` still returns with the param absent below.
 */
test('GET /api/v1/metrics: ?projectId narrows to just that one project, even when the caller owns more than one', async () => {
  scopeTo([projectAId, projectBId]);
  const response = await getMetrics({
    resource: 'host-a',
    names: ['raw.metric'],
    from: new Date(Date.now() - 6 * 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 60,
    projectId: projectAId,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as MetricsBody;
  assert.equal(body.series[0]!.points.length, 1);
  assert.equal(body.series[0]!.points[0]!.value, 40);
});

test('GET /api/v1/metrics: ?projectId naming a project the caller does not own is 404, not 403, not data', async () => {
  scopeTo([projectAId]);
  const response = await getMetrics({
    resource: 'host-b',
    names: ['raw.metric'],
    from: new Date(Date.now() - 6 * 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 60,
    projectId: projectBId,
  });
  assert.equal(response.status, 404);
  const body = (await response.json()) as { message: string };
  assert.equal(body.message, 'Project not found.');
});

test('GET /api/v1/metrics: ?projectId that is not a UUID is a 400, not a 404 or a 500', async () => {
  scopeTo([projectAId]);
  const response = await getMetrics({
    resource: 'host-a',
    names: ['raw.metric'],
    from: new Date(Date.now() - 6 * 60 * 60 * 1000),
    to: new Date(),
    stepSeconds: 60,
    projectId: 'not-a-uuid',
  });
  assert.equal(response.status, 400);
});

test("GET /api/v1/resources: ?projectId narrows to just that project, excluding a sibling project's resource", async () => {
  scopeTo([projectAId, projectBId]);
  const response = await getResources(
    new Date(Date.now() - 11 * 24 * 60 * 60 * 1000),
    new Date(),
    projectAId,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as ResourcesBody;
  const resources = body.resources.map((entry) => entry.resource);
  assert.ok(resources.includes('host-a'));
  assert.equal(resources.includes('host-b'), false);
});

test('GET /api/v1/resources: ?projectId naming a project the caller does not own is 404', async () => {
  scopeTo([projectAId]);
  const response = await getResources(
    new Date(Date.now() - 11 * 24 * 60 * 60 * 1000),
    new Date(),
    projectBId,
  );
  assert.equal(response.status, 404);
});
