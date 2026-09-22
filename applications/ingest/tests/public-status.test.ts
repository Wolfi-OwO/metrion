import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

/**
 * Same fixture shape as `tests/ingest.test.ts` - a real Postgres/TimescaleDB
 * instance is required (`docker compose -f docker-compose.dev.yml up -d`).
 * Unlike the viewer's own copy of this suite, no OAuth/session env vars are
 * set here at all: this endpoint takes no session, and ingest's `main.ts`
 * never reads any of them in the first place.
 */
const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

// Set to an address nothing answers on, BEFORE main.ts is ever imported -
// the same liveness-must-not-touch-a-database proof `tests/ingest.test.ts`
// makes, repeated here since this is a second, independent test file
// `node --test` may run this process's `app` in.
process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';

const { app } = await import('../dist/main.js');
const { clearPublicUptimeCache } = await import('../dist/services/public-status-service.js');
const { createPool } = await import('@metrion/db/dist/pool.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `public_status_test_${Date.now()}`;
const ownerEmail = `${marker}@example.test`;

let flaggedProjectId: string;
let unflaggedProjectId: string;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface HistoryEntry {
  day: string;
  upPct: number | null;
  samples: number;
}

interface AppEntry {
  key: string;
  displayName: string | null;
  uptime: { h24: number | null; d7: number | null; d30: number | null };
  latencyMs: number | null;
  lastSampleAt: string | null;
  history: HistoryEntry[];
}

interface UptimeBody {
  projectId: string;
  generatedAt: string;
  applications: AppEntry[];
}

async function insertMetric(
  projectId: string,
  resource: string,
  name: string,
  value: number,
  time: Date,
  unit = 'bool',
  subResource: string | null = null,
): Promise<void> {
  await fixturePool.query(
    `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 300)`,
    [time.toISOString(), projectId, resource, subResource, name, value, unit],
  );
}

function getUptime(projectId: string): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/public/projects/${projectId}/uptime`);
}

/** Retried on 55P03 ("concurrent refresh"): `node --test` runs this file
 * alongside `tests/ingest.test.ts`, and both may end up sharing a
 * `metrics_hourly` refresh window - TimescaleDB allows only one in-flight
 * refresh per aggregate, not per window, so the two can collide with no
 * data-correctness issue, just a race to retry. */
async function refreshMetricsHourly(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fixturePool.query("CALL refresh_continuous_aggregate('metrics_hourly', NULL, NULL)");
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== '55P03' || attempt >= 5) throw err;
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
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

  const userRow = await fixturePool.query<{ id: string }>(
    'INSERT INTO users (email) VALUES ($1) RETURNING id',
    [ownerEmail],
  );
  const userId = userRow.rows[0]!.id;

  const flagged = await fixturePool.query<{ id: string }>(
    `INSERT INTO projects (owner_user_id, name, slug, public_status_enabled)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [userId, `${marker}-flagged`, `${marker}-flagged`],
  );
  flaggedProjectId = flagged.rows[0]!.id;

  // `public_status_enabled` defaults to false (0011_project_public_status.sql) -
  // left unset here on purpose, so this project proves the default itself
  // gates the endpoint, not just an explicit `false`.
  const unflagged = await fixturePool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [userId, `${marker}-unflagged`, `${marker}-unflagged`],
  );
  unflaggedProjectId = unflagged.rows[0]!.id;

  // Four registered applications, only three of which ever write `uptime.ok` -
  // `fuwwy-platform` mirrors the real gap organizational/uptime-sources.md
  // measured, and must never appear in the response at all. All four are
  // opted in (`public_status_visible = true`, finding 2) so exclusion in the
  // tests below is attributable to what each test actually names (no
  // samples, the project flag), not to the new per-application gate - that
  // gate gets its own dedicated test further down.
  await fixturePool.query(
    `INSERT INTO applications (project_id, key, display_name, public_status_visible) VALUES
       ($1, 'netviz', 'Network Visualizer', true),
       ($1, 'nutrilens', 'NutriLens', true),
       ($1, 'ml-visualizer', 'ML Visualizer', true),
       ($1, 'fuwwy-platform', 'Fuwwy Platform', true)`,
    [flaggedProjectId],
  );
  await fixturePool.query(
    `INSERT INTO applications (project_id, key, display_name, public_status_visible) VALUES ($1, 'netviz', 'Network Visualizer', true)`,
    [unflaggedProjectId],
  );

  const now = Date.now();

  // netviz: two `uptime.ok` samples inside the last 24h, one 5 days back
  // (inside d7, outside h24) - all "up", plus a fringe metric type on the
  // very same resource to prove the response never carries it. One
  // `uptime.latency` sample gives `latencyMs`/`lastSampleAt` something real
  // to read back.
  await insertMetric(flaggedProjectId, 'netviz', 'uptime.ok', 1, new Date(now - 30 * 60 * 1000));
  await insertMetric(flaggedProjectId, 'netviz', 'uptime.ok', 1, new Date(now - 2 * HOUR_MS));
  await insertMetric(flaggedProjectId, 'netviz', 'uptime.ok', 1, new Date(now - 5 * DAY_MS));
  await insertMetric(
    flaggedProjectId,
    'netviz',
    'uptime.latency',
    42,
    new Date(now - 30 * 60 * 1000),
    'ms',
  );
  // Deliberately distinctive values - unlikely to collide with any
  // timestamp/uuid fragment elsewhere in the response, so a raw substring
  // check on the response body is a meaningful leak proof, not a coin flip.
  await insertMetric(
    flaggedProjectId,
    'netviz',
    'cpu.usage',
    87654321,
    new Date(now - 30 * 60 * 1000),
    'percent',
  );
  await insertMetric(
    flaggedProjectId,
    'netviz',
    'memory.used',
    999888777,
    new Date(now - 30 * 60 * 1000),
    'megabytes',
  );

  // nutrilens: exactly one sample, 10 days old - inside neither h24 nor d7.
  // This is the "no samples in this window" fixture.
  await insertMetric(flaggedProjectId, 'nutrilens', 'uptime.ok', 1, new Date(now - 10 * DAY_MS));

  // ml-visualizer: one recent "up" sample (keeps it in the applications list
  // and gives h24/d7 something real), plus one "down" sample 20 days back -
  // inside d30's window, outside h24/d7's. The 20-day-old row is deleted
  // from the raw table in the "full shape" test below, AFTER the continuous
  // aggregate has materialized it - so by the time `d30` is read, `metrics`
  // itself no longer has any record of it and only `metrics_hourly` does.
  // `avg(uptime.ok)` over "up, up" is indistinguishable from "up" alone
  // (both 100%); "up, down" is not - a `d30` that only a hourly-sourced
  // query can still compute correctly is a real proof of the source, not
  // just a coincidence of timing.
  await insertMetric(
    flaggedProjectId,
    'ml-visualizer',
    'uptime.ok',
    1,
    new Date(now - 10 * 60 * 1000),
  );
  await insertMetric(
    flaggedProjectId,
    'ml-visualizer',
    'uptime.ok',
    0,
    new Date(now - 20 * DAY_MS),
  );

  // unflagged project: real uptime data too, so the 404 is proven to be
  // about the flag, not about an absence of anything to show.
  await insertMetric(unflaggedProjectId, 'netviz', 'uptime.ok', 1, new Date(now - 30 * 60 * 1000));
});

after(async () => {
  await fixturePool.query('DELETE FROM metrics WHERE project_id = ANY($1)', [
    [flaggedProjectId, unflaggedProjectId],
  ]);
  await fixturePool.query(
    'DELETE FROM projects WHERE owner_user_id = (SELECT id FROM users WHERE email = $1)',
    [ownerEmail],
  );
  await fixturePool.query('DELETE FROM users WHERE email = $1', [ownerEmail]);
  await fixturePool.end();
  await new Promise((resolve) => server.close(resolve));
});

test('GET .../uptime: needs no session - an anonymous request (no cookie at all) is answered', async () => {
  const response = await getUptime(flaggedProjectId);
  assert.equal(response.status, 200);
});

test('GET .../uptime: a nonexistent project id 404s', async () => {
  const response = await getUptime('00000000-0000-0000-0000-000000000000');
  assert.equal(response.status, 404);
  const body = (await response.json()) as { message: string };
  assert.equal(body.message, 'Project not found.');
});

test('GET .../uptime: an existing project without the flag 404s to an anonymous caller, same body as a nonexistent one', async () => {
  const response = await getUptime(unflaggedProjectId);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { message: string };
  assert.equal(body.message, 'Project not found.');
});

test('GET .../uptime: a malformed id is a 404, never a 500', async () => {
  const response = await getUptime('not-a-uuid');
  assert.equal(response.status, 404);
});

test('GET .../uptime: fuwwy-platform (registered, zero uptime.ok samples) is omitted entirely', async () => {
  const body = (await (await getUptime(flaggedProjectId)).json()) as UptimeBody;
  assert.equal(
    body.applications.some((application) => application.key === 'fuwwy-platform'),
    false,
  );
});

test('GET .../uptime: no-samples reads back null, not 100', async () => {
  // Deliberately read BEFORE this file's own `refreshMetricsHourly()` call
  // (only in the last test below) - `d30` is not asserted here at all,
  // because `metrics_hourly` is one continuous aggregate shared with every
  // other test file `node --test` runs concurrently
  // (`tests/ingest.test.ts` refreshes the same one), so whether it has
  // already been materialized at this exact instant is inherently racy.
  // `h24`/`d7` have no such dependency - they read `metrics` directly, with
  // an explicit time bound - so they are asserted here.
  const body = (await (await getUptime(flaggedProjectId)).json()) as UptimeBody;
  const nutrilens = body.applications.find((application) => application.key === 'nutrilens');
  assert.ok(nutrilens, 'nutrilens must be present - it has one uptime.ok sample, 10 days old');
  assert.equal(nutrilens.uptime.h24, null, 'no sample in the last 24h');
  assert.equal(nutrilens.uptime.d7, null, 'no sample in the last 7 days');
  assert.equal(
    nutrilens.latencyMs,
    null,
    'no uptime.latency sample was ever written for nutrilens',
  );
  assert.ok(nutrilens.lastSampleAt, 'the one uptime.ok sample it does have must still be reported');
});

test('GET .../uptime: response contains only uptime-derived fields - never the cpu/memory metrics stored on the same resource', async () => {
  const response = await getUptime(flaggedProjectId);
  const raw = await response.text();
  assert.equal(raw.includes('cpu.usage'), false);
  assert.equal(raw.includes('memory.used'), false);
  assert.equal(raw.includes('87654321'), false, "cpu.usage's own value must not leak either");
  assert.equal(raw.includes('999888777'), false, "memory.used's own value must not leak either");
  assert.equal(raw.includes('docker'), false);

  const body = JSON.parse(raw) as UptimeBody;
  for (const application of body.applications) {
    assert.deepEqual(Object.keys(application).sort(), [
      'displayName',
      'history',
      'key',
      'lastSampleAt',
      'latencyMs',
      'uptime',
    ]);
    assert.deepEqual(Object.keys(application.uptime).sort(), ['d30', 'd7', 'h24']);
    for (const entry of application.history) {
      assert.deepEqual(Object.keys(entry).sort(), ['day', 'samples', 'upPct']);
    }
  }
});

test('GET .../uptime: full shape for a flagged project, after the continuous aggregate is refreshed', async () => {
  // Continuous aggregates refresh on a schedule/policy, not on INSERT -
  // metrics_hourly must be told to catch up before d30/history can see any
  // of the fixture rows above (same requirement tests/ingest.test.ts's own
  // wide-range assertions would have).
  await refreshMetricsHourly();
  // Earlier tests in this file already populated the 60s cache with pre-refresh data.
  clearPublicUptimeCache();

  // Now that metrics_hourly has materialized ml-visualizer's 20-day-old
  // "down" sample, remove it from the raw table - the source-of-truth proof
  // below (d30 still reflecting it) is only meaningful once `metrics` itself
  // can no longer answer the query.
  await fixturePool.query(
    'DELETE FROM metrics WHERE project_id = $1 AND resource = $2 AND time < $3',
    [flaggedProjectId, 'ml-visualizer', new Date(Date.now() - DAY_MS).toISOString()],
  );

  const response = await getUptime(flaggedProjectId);
  assert.equal(response.status, 200);
  const body = (await response.json()) as UptimeBody;

  assert.equal(body.projectId, flaggedProjectId);
  assert.ok(!Number.isNaN(Date.parse(body.generatedAt)));
  assert.equal(
    body.applications.length,
    3,
    'ml-visualizer, netviz and nutrilens - fuwwy-platform stays excluded',
  );
  assert.deepEqual(
    body.applications.map((application) => application.key),
    ['ml-visualizer', 'netviz', 'nutrilens'],
    'alphabetical by key, same ORDER BY as every other applications listing',
  );

  const mlVisualizer = body.applications[0]!;
  assert.ok(mlVisualizer.uptime.h24 !== null && Math.abs(mlVisualizer.uptime.h24 - 100) < 0.01);
  assert.ok(mlVisualizer.uptime.d7 !== null && Math.abs(mlVisualizer.uptime.d7 - 100) < 0.01);
  assert.ok(
    mlVisualizer.uptime.d30 !== null && Math.abs(mlVisualizer.uptime.d30 - 50) < 0.01,
    "d30 must average in the 20-day-old 'down' sample even though `metrics` no longer has that row - " +
      'it can only have come from metrics_hourly, proving the wide-range path really is the hourly rollup, not raw',
  );

  const netviz = body.applications[1]!;
  assert.equal(netviz.displayName, 'Network Visualizer');
  assert.ok(netviz.uptime.h24 !== null && Math.abs(netviz.uptime.h24 - 100) < 0.01);
  assert.ok(netviz.uptime.d7 !== null && Math.abs(netviz.uptime.d7 - 100) < 0.01);
  assert.ok(netviz.uptime.d30 !== null && Math.abs(netviz.uptime.d30 - 100) < 0.01);
  assert.equal(netviz.latencyMs, 42);
  assert.ok(netviz.lastSampleAt);
  assert.ok(
    Math.abs(Date.parse(netviz.lastSampleAt) - (Date.now() - 30 * 60 * 1000)) < 5 * 60 * 1000,
    'lastSampleAt must be the newest uptime.ok sample, not the uptime.latency one or an older one',
  );

  assert.equal(netviz.history.length, 90, 'exactly 90 daily entries');
  assert.ok(
    netviz.history.every(
      (entry, i) => i === 0 || Date.parse(entry.day) > Date.parse(netviz.history[i - 1]!.day),
    ),
    'oldest first, strictly increasing',
  );
  const todayDay = new Date(netviz.history[89]!.day);
  assert.equal(todayDay.getUTCHours(), 0, "each day's bucket is UTC-midnight-aligned");
  assert.equal(
    Math.floor((Date.now() - todayDay.getTime()) / DAY_MS),
    0,
    'the last entry is today - less than a day has elapsed since its UTC midnight',
  );

  // The 5-day-back sample landed in exactly one daily bucket - everything
  // else in the 90-day window (bar "today") was never sampled at all, and
  // must read back as null/0, never a manufactured 100.
  const fiveDaysAgoIndex = 89 - 5;
  const fiveDaysAgoEntry = netviz.history[fiveDaysAgoIndex]!;
  assert.equal(fiveDaysAgoEntry.samples, 1);
  assert.ok(fiveDaysAgoEntry.upPct !== null && Math.abs(fiveDaysAgoEntry.upPct - 100) < 0.01);

  const untouchedEntry = netviz.history[0]!;
  assert.equal(untouchedEntry.samples, 0);
  assert.equal(untouchedEntry.upPct, null, 'a day with zero samples is null, never 100');

  const nutrilens = body.applications[2]!;
  assert.ok(
    nutrilens.uptime.d30 !== null && Math.abs(nutrilens.uptime.d30 - 100) < 0.01,
    'now that metrics_hourly has been refreshed, the 10-day-old sample is visible through it',
  );
  assert.equal(nutrilens.uptime.h24, null);
  assert.equal(nutrilens.uptime.d7, null);
});

test('GET .../uptime: sub_resource never reaches the response, not even as the newest uptime.ok sample for a resource', async () => {
  // `container:<name>` / `requests:<hostname>` is this project's real
  // convention for sub_resource (applications/agent/src/lib/to-metric-
  // envelopes.ts) - inserted here as the NEWEST uptime.ok row for netviz, so
  // it is the exact row `queryLatestSamples`' `DISTINCT ON (resource, name)
  // ... ORDER BY time DESC` would have picked, proving this isn't just an
  // untested code path.
  await insertMetric(
    flaggedProjectId,
    'netviz',
    'uptime.ok',
    1,
    new Date(),
    'bool',
    'container:test-leak-canary-1',
  );

  clearPublicUptimeCache(); // else a cached pre-insert response would make this vacuous
  const response = await getUptime(flaggedProjectId);
  const raw = await response.text();
  assert.equal(raw.includes('test-leak-canary-1'), false);
  assert.equal(raw.includes('container:'), false);
});

test('GET .../uptime: a second request within 60s is served from cache without touching the DB, and carries Cache-Control', async () => {
  clearPublicUptimeCache();
  const first = await getUptime(flaggedProjectId);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'public, max-age=60');

  // Flip the flag: a DB read would now 404, so a 200 can only be a cache hit.
  await fixturePool.query('UPDATE projects SET public_status_enabled = false WHERE id = $1', [
    flaggedProjectId,
  ]);
  try {
    const second = await getUptime(flaggedProjectId);
    assert.equal(second.status, 200, 'a DB read would now 404 - a 200 proves a cache hit');
  } finally {
    await fixturePool.query('UPDATE projects SET public_status_enabled = true WHERE id = $1', [
      flaggedProjectId,
    ]);
  }

  // Negative results are never cached: unflag, clear, 404, reflag, 200 at once.
  clearPublicUptimeCache();
  await fixturePool.query('UPDATE projects SET public_status_enabled = false WHERE id = $1', [
    flaggedProjectId,
  ]);
  assert.equal((await getUptime(flaggedProjectId)).status, 404);
  await fixturePool.query('UPDATE projects SET public_status_enabled = true WHERE id = $1', [
    flaggedProjectId,
  ]);
  assert.equal((await getUptime(flaggedProjectId)).status, 200);
});

test('GET .../uptime: an application not opted in (public_status_visible default false) is absent even with real recent samples, and appears once toggled true (finding 2)', async () => {
  // Mirrors what `registerResources` (ingest.handlers.ts) does for real: any
  // resource name a key sends gets an `applications` row auto-created, with
  // no visibility opt-in. Before finding 2 this endpoint listed anything
  // with a sample; a leaked key could forge a public "service" this way.
  await fixturePool.query(
    `INSERT INTO applications (project_id, key, display_name) VALUES ($1, $2, 'Not Opted In')`,
    [flaggedProjectId, 'not-opted-in'],
  );
  await insertMetric(flaggedProjectId, 'not-opted-in', 'uptime.ok', 1, new Date());

  clearPublicUptimeCache();
  const before = (await (await getUptime(flaggedProjectId)).json()) as UptimeBody;
  assert.equal(
    before.applications.some((application) => application.key === 'not-opted-in'),
    false,
    'an application with public_status_visible = false (the default) must not appear, sample or not',
  );

  await fixturePool.query(
    'UPDATE applications SET public_status_visible = true WHERE project_id = $1 AND key = $2',
    [flaggedProjectId, 'not-opted-in'],
  );
  clearPublicUptimeCache();
  const after = (await (await getUptime(flaggedProjectId)).json()) as UptimeBody;
  assert.equal(
    after.applications.some((application) => application.key === 'not-opted-in'),
    true,
    'toggling public_status_visible true must make it appear',
  );
});
