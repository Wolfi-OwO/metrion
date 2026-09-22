import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

/**
 * `GET /api/v1/public/projects/:id/uptime/range`. Real TimescaleDB required
 * (`docker compose -f docker-compose.dev.yml up -d`). Fixtures are written to
 * `uptime_samples` directly and rolled up with the real
 * `refresh_uptime_rollup`, so what is asserted is what production computes.
 */
const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';
process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';

const { app } = await import('../dist/main.js');
const { getPool } = await import('../dist/lib/db.js');
const {
  clearPublicRangeCache,
  publicRangeCacheSize,
  getPublicUptimeRange,
  pickGranularity,
  rangeMaxAgeSeconds,
  MAX_BUCKETS,
} = await import('../dist/services/public-uptime-range-service.js');
const { createPool } = await import('@metrion/db/dist/pool.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `range_test_${Date.now()}`;
const ownerEmail = `${marker}@example.test`;
let flaggedProjectId: string;
let unflaggedProjectId: string;

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;

interface Bucket {
  t: string;
  upPct: number | null;
  samples: number;
}
interface Incident {
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number;
  downSamples: number;
}
interface AppEntry {
  key: string;
  displayName: string | null;
  firstSampleAt: string;
  lastSampleAt: string;
  uptimePct: number | null;
  coverage: number | null;
  latency: { p50: number | null; p95: number | null; approximate: boolean };
  idlePct: number | null;
  buckets: Bucket[];
  incidents: Incident[];
  truncated: boolean;
  totalIncidents: number;
}
interface RangeBody {
  projectId: string;
  generatedAt: string;
  range: { from: string; to: string; granularity: string; bucketCount: number };
  applications: AppEntry[];
}

function getRange(projectId: string, query = ''): Promise<Response> {
  return fetch(`${baseUrl}/api/v1/public/projects/${projectId}/uptime/range${query}`);
}

async function okBody(query: string): Promise<RangeBody> {
  const response = await getRange(flaggedProjectId, query);
  assert.equal(response.status, 200, `GET ${query}`);
  return (await response.json()) as RangeBody;
}

const appOf = (body: RangeBody, key: string): AppEntry => {
  const found = body.applications.find((a) => a.key === key);
  assert.ok(found, `application ${key} present`);
  return found;
};

/** Test-only SQL fragments, never request input. */
async function seed(
  projectId: string,
  resource: string,
  name: string,
  from: string,
  to: string,
  valueSql: string,
  skipSql = 'false',
  intervalSeconds = 60,
  step = '1 minute',
): Promise<void> {
  await fixturePool.query(
    `INSERT INTO uptime_samples (time, project_id, resource, name, value, unit, interval_seconds)
     SELECT g, $1, $2, $3, (${valueSql})::double precision, 'x', $6
       FROM generate_series($4::timestamptz, $5::timestamptz, $7::interval) g
      WHERE NOT (${skipSql})
     ON CONFLICT DO NOTHING`,
    [projectId, resource, name, from, to, intervalSeconds, step],
  );
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

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
  const unflagged = await fixturePool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [userId, `${marker}-unflagged`, `${marker}-unflagged`],
  );
  unflaggedProjectId = unflagged.rows[0]!.id;

  // All opted in (`public_status_visible = true`, finding 2) - this file
  // exercises the project-level flag and the data itself, not the
  // per-application opt-in, which gets its own dedicated test below.
  await fixturePool.query(
    `INSERT INTO applications (project_id, key, display_name, public_status_visible) VALUES
       ($1, 'alpha', 'Alpha', true), ($1, 'beta', 'Beta', true), ($1, 'flappy', 'Flappy', true),
       ($1, 'live', 'Live', true), ($1, 'silent', 'Silent', true)`,
    [flaggedProjectId],
  );
  await fixturePool.query(
    `INSERT INTO applications (project_id, key, display_name, public_status_visible) VALUES ($1, 'alpha', 'Alpha', true)`,
    [unflaggedProjectId],
  );

  // alpha: 2026-08-03 .. 2026-08-10, minute cadence, except
  //  - 08-05 10:00-10:04 down (5 down samples: one incident),
  //  - 08-05 12:00-12:29 no samples at all (a data hole inside a day),
  //  - 08-07 no samples at all (a whole hole day, monitor still running after).
  const alphaSkip = `(g >= '2026-08-07Z' AND g < '2026-08-08Z')
    OR (g >= '2026-08-05T12:00Z' AND g < '2026-08-05T12:30Z')`;
  await seed(
    flaggedProjectId,
    'alpha',
    'uptime.ok',
    '2026-08-03T00:00Z',
    '2026-08-10T23:59Z',
    `CASE WHEN g >= '2026-08-05T10:00Z' AND g < '2026-08-05T10:05Z' THEN 0 ELSE 1 END`,
    alphaSkip,
  );
  await seed(
    flaggedProjectId,
    'alpha',
    'uptime.latency',
    '2026-08-03T00:00Z',
    '2026-08-10T23:59Z',
    `CASE WHEN g < '2026-08-06Z' THEN 100 ELSE 200 END`,
    alphaSkip,
  );
  await seed(
    flaggedProjectId,
    'alpha',
    'uptime.idle',
    '2026-08-03T00:00Z',
    '2026-08-10T23:59Z',
    `CASE WHEN extract(minute FROM g)::int % 10 = 0 THEN 1 ELSE 0 END`,
    alphaSkip,
  );
  // The VPS vantage (300 s) says "down" and "9999 ms" all through 08-04. It
  // must count for nothing.
  await seed(
    flaggedProjectId,
    'alpha',
    'uptime.ok',
    '2026-08-04T00:00:30Z',
    '2026-08-04T23:59:30Z',
    '0',
    'false',
    300,
    '5 minutes',
  );
  await seed(
    flaggedProjectId,
    'alpha',
    'uptime.latency',
    '2026-08-04T00:00:30Z',
    '2026-08-04T23:59:30Z',
    '9999',
    'false',
    300,
    '5 minutes',
  );

  // beta starts 2026-08-20: everything before is "before the first sample".
  await seed(flaggedProjectId, 'beta', 'uptime.ok', '2026-08-20T00:00Z', '2026-08-20T23:59Z', '1');

  // flappy: 120 isolated down samples (every 10th minute) = 120 incidents.
  await seed(
    flaggedProjectId,
    'flappy',
    'uptime.ok',
    '2026-08-11T00:00Z',
    '2026-08-11T19:59Z',
    `CASE WHEN extract(minute FROM g)::int % 10 = 0 THEN 0 ELSE 1 END`,
  );

  // live: the last 3 hours with a 30 minute hole starting 2 h ago.
  const liveTo = new Date(Math.floor(Date.now() / MIN_MS) * MIN_MS).toISOString();
  const liveFrom = new Date(Math.floor(Date.now() / MIN_MS) * MIN_MS - 180 * MIN_MS).toISOString();
  const holeFrom = new Date(Math.floor(Date.now() / MIN_MS) * MIN_MS - 120 * MIN_MS).toISOString();
  const holeTo = new Date(Math.floor(Date.now() / MIN_MS) * MIN_MS - 90 * MIN_MS).toISOString();
  await seed(
    flaggedProjectId,
    'live',
    'uptime.ok',
    liveFrom,
    liveTo,
    '1',
    `g >= '${holeFrom}' AND g < '${holeTo}'`,
  );

  // The unflagged project holds data too; it must never surface anywhere.
  await seed(
    unflaggedProjectId,
    'alpha',
    'uptime.ok',
    '2026-08-03T00:00Z',
    '2026-08-03T23:59Z',
    '0',
  );

  await fixturePool.query("SELECT refresh_uptime_rollup('2026-08-01T00:00Z', '2026-09-01T00:00Z')");
  await fixturePool.query("SELECT refresh_uptime_rollup(now() - interval '3 days', now())");
});

after(async () => {
  const ids = [flaggedProjectId, unflaggedProjectId];
  for (const table of ['uptime_samples', 'uptime_daily', 'uptime_incidents']) {
    await fixturePool.query(`DELETE FROM ${table} WHERE project_id = ANY($1)`, [ids]);
  }
  await fixturePool.query(
    'DELETE FROM projects WHERE owner_user_id = (SELECT id FROM users WHERE email = $1)',
    [ownerEmail],
  );
  await fixturePool.query('DELETE FROM users WHERE email = $1', [ownerEmail]);
  await fixturePool.end();
  await new Promise((resolve) => server.close(resolve));
});

// ---- validation and gating ------------------------------------------------

test('range: malformed, reversed, too-early and future `from` are 400 with field detail', async () => {
  for (const query of [
    '?from=not-a-date',
    '?from=2026-08-02&to=2026-08-01',
    '?from=2026-08-05T10:00:00Z&to=2026-08-05T10:00:00Z',
    '?from=1999-12-31',
    '?from=2999-01-01',
    '?to=2026-13-45',
    '?from=2026-08-01&from=2026-08-02',
  ]) {
    const response = await getRange(flaggedProjectId, query);
    assert.equal(response.status, 400, query);
    const body = (await response.json()) as { issues: { path: string }[] };
    assert.ok(body.issues.length > 0, query);
  }
});

test("range: unknown, unflagged and malformed ids all 404 with the sibling endpoint's body", async () => {
  const sibling = await fetch(
    `${baseUrl}/api/v1/public/projects/00000000-0000-0000-0000-000000000000/uptime`,
  );
  const expected = await sibling.text();
  for (const id of ['00000000-0000-0000-0000-000000000000', unflaggedProjectId, 'not-a-uuid']) {
    const response = await getRange(id, '?from=2026-08-01&to=2026-08-31');
    assert.equal(response.status, 404, id);
    assert.equal(await response.text(), expected, id);
  }
});

test('range: unknown query parameters are ignored, like the sibling endpoint', async () => {
  const response = await getRange(flaggedProjectId, '?from=2026-08-05&to=2026-08-05&_=123');
  assert.equal(response.status, 200);
});

test('range: `to` in the future is clamped, not an error', async () => {
  const body = await okBody('?from=2026-08-01&to=2999-01-01');
  assert.ok(Date.parse(body.range.to) <= Date.now());
});

test('range: a range before the first data is all null buckets; one over the cap is trimmed to the data or empty', async () => {
  const nulls = await okBody('?from=2001-01-01&to=2001-02-01');
  assert.equal(nulls.range.bucketCount, 32, 'Jan 1 .. Feb 1 inclusive');
  for (const a of nulls.applications) assert.ok(a.buckets.every((b) => b.upPct === null));
  // 2000-01-01 .. now is ~9,700 days: `from` is raised to the first day with data.
  const long = await okBody('?from=2000-01-01');
  assert.equal(long.range.from, '2026-08-03T00:00:00.000Z');
  assert.ok(long.range.bucketCount <= MAX_BUCKETS);
  // 2000 .. 2010 is over the cap and ends before the data: nothing left.
  const empty = await okBody('?from=2000-01-01&to=2010-01-01');
  assert.equal(empty.range.bucketCount, 0);
  for (const a of empty.applications) assert.deepEqual(a.buckets, []);
});

// ---- granularity and bucket caps -------------------------------------------

test('pickGranularity: smallest step under the cap, sub-daily only up to 7 days', () => {
  const H = 60 * MIN_MS;
  const cases: [number, string][] = [
    [MIN_MS, '1m'],
    [24 * H, '1m'],
    [33 * H, '1m'],
    [34 * H, '5m'],
    [2 * DAY_MS, '5m'],
    [7 * DAY_MS, '15m'],
    [7 * DAY_MS + MIN_MS, '1d'],
    [31 * DAY_MS, '1d'],
    [365 * DAY_MS, '1d'],
    [5 * 365 * DAY_MS, '1d'],
  ];
  for (const [span, expected] of cases) assert.equal(pickGranularity(span), expected, `${span}`);
  // Every sub-daily pick, aligned worst case, stays within the cap.
  for (let span = MIN_MS; span <= 7 * DAY_MS; span += 13 * MIN_MS) {
    const g = pickGranularity(span);
    const step = { '1m': MIN_MS, '5m': 5 * MIN_MS, '15m': 15 * MIN_MS, '1d': DAY_MS }[g];
    assert.ok(Math.ceil(span / step) + 1 <= MAX_BUCKETS, `${span} -> ${g}`);
  }
});

test('range: 24 h is 1m buckets (<= 1440); a hole is null with samples 0, never 0%', async () => {
  const now = Date.now();
  const from = new Date(now - DAY_MS).toISOString();
  const body = await okBody(`?from=${from}`);
  assert.equal(body.range.granularity, '1m');
  assert.ok(body.range.bucketCount <= 1440 + 1);
  const live = appOf(body, 'live');
  assert.equal(live.buckets.length, body.range.bucketCount);

  const minute = Math.floor(now / MIN_MS) * MIN_MS;
  const at = (offsetMin: number): Bucket =>
    live.buckets.find((b) => b.t === new Date(minute - offsetMin * MIN_MS).toISOString())!;
  assert.deepEqual(at(150), { t: at(150).t, upPct: 100, samples: 1 });
  assert.deepEqual(at(100), { t: at(100).t, upPct: null, samples: 0 }, 'hole is null');
  assert.deepEqual(at(600), { t: at(600).t, upPct: null, samples: 0 }, 'before start is null');
  // A hole must not drag the range figure down: only sampled minutes count.
  assert.equal(live.uptimePct, 100);
  assert.ok(live.coverage! > 0 && live.coverage! < 1, 'the hole shows up as coverage < 1');
});

test('range: caps hold for 2 days, 7 days, 8 days, 31 days, 1 year, 5 years and the whole period', async () => {
  const now = Date.now();
  const expectations: [string, string][] = [
    [`?from=${new Date(now - 2 * DAY_MS).toISOString()}`, '5m'],
    [`?from=${new Date(now - 7 * DAY_MS).toISOString()}`, '15m'],
    [`?from=${new Date(now - 8 * DAY_MS).toISOString()}`, '1d'],
    ['?from=2026-08-01&to=2026-08-31', '1d'],
    [`?from=${new Date(now - 365 * DAY_MS).toISOString()}`, '1d'],
    [`?from=${new Date(now - 5 * 365 * DAY_MS).toISOString()}`, '1d'],
    ['', '1d'],
  ];
  for (const [query, granularity] of expectations) {
    const body = await okBody(query);
    assert.equal(body.range.granularity, granularity, query);
    assert.ok(body.range.bucketCount <= MAX_BUCKETS, query);
    for (const a of body.applications)
      assert.equal(a.buckets.length, body.range.bucketCount, query);
  }
  // Whole period starts at the first UTC day with data across the applications.
  const whole = await okBody('');
  assert.equal(whole.range.from, '2026-08-03T00:00:00.000Z');
});

// ---- daily buckets, null semantics, rollup agreement ------------------------

test('range: Aug 1-31 gives exactly 31 UTC day buckets, null before an application starts, equal to uptime_daily', async () => {
  const body = await okBody('?from=2026-08-01&to=2026-08-31');
  assert.equal(body.range.granularity, '1d');
  assert.equal(body.range.bucketCount, 31);
  assert.equal(body.range.from, '2026-08-01T00:00:00.000Z');
  assert.equal(body.range.to, '2026-09-01T00:00:00.000Z', 'a bare `to` is inclusive of its day');

  const alpha = appOf(body, 'alpha');
  assert.equal(alpha.buckets.length, 31);
  assert.equal(alpha.buckets[0]!.t, '2026-08-01T00:00:00.000Z');
  assert.equal(alpha.buckets[30]!.t, '2026-08-31T00:00:00.000Z');
  assert.equal(alpha.buckets[0]!.upPct, null, 'before the first sample');
  assert.equal(alpha.buckets[1]!.upPct, null);
  assert.equal(alpha.buckets[2]!.upPct, 100, '08-03');
  assert.deepEqual(alpha.buckets[6], { t: '2026-08-07T00:00:00.000Z', upPct: null, samples: 0 });
  assert.equal(alpha.buckets[3]!.samples, 1440, '08-04: the 300 s rows are not counted');
  assert.equal(alpha.buckets[3]!.upPct, 100, '08-04: nor are their "down" values');

  const beta = appOf(body, 'beta');
  assert.equal(beta.buckets.filter((b) => b.upPct !== null).length, 1);
  assert.equal(beta.buckets[19]!.upPct, 100);
  assert.equal(beta.buckets[0]!.upPct, null);

  const daily = await fixturePool.query<{ day: string; up: number; total: number }>(
    `SELECT day::text, up_samples AS up, total_samples AS total FROM uptime_daily
      WHERE project_id = $1 AND resource = 'alpha' AND day BETWEEN '2026-08-01' AND '2026-08-31'`,
    [flaggedProjectId],
  );
  assert.ok(daily.rows.length > 0);
  for (const row of daily.rows) {
    const bucket = alpha.buckets.find((b) => b.t.startsWith(row.day))!;
    assert.equal(bucket.samples, row.total, row.day);
    assert.ok(Math.abs(bucket.upPct! - (row.up / row.total) * 100) < 1e-3, row.day);
  }
  // 08-05: 5 down samples of 1410 present.
  assert.ok(Math.abs(alpha.buckets[4]!.upPct! - (1405 / 1410) * 100) < 1e-3);

  // Aggregates over the range: weighted by samples, coverage over the span.
  const total = 7 * 1440 - 30;
  assert.ok(Math.abs(alpha.uptimePct! - ((total - 5) / total) * 100) < 1e-3);
  const spanMinutes =
    (Date.parse('2026-09-01T00:00:00Z') - Date.parse('2026-08-03T00:00:00Z')) / MIN_MS;
  assert.ok(Math.abs(alpha.coverage! - total / spanMinutes) < 1e-3);
  assert.equal(alpha.firstSampleAt, '2026-08-03T00:00:00.000Z');
  assert.equal(alpha.lastSampleAt, '2026-08-10T23:59:00.000Z');
  assert.equal(alpha.latency.approximate, true);
  assert.ok(alpha.idlePct !== null && Math.abs(alpha.idlePct - 10) < 0.1);
  assert.equal(alpha.displayName, 'Alpha');
});

test('range: a sub-daily range reads samples exactly: down minutes are 0, the hole is null, 300 s rows ignored', async () => {
  const body = await okBody('?from=2026-08-05&to=2026-08-05');
  assert.equal(body.range.granularity, '1m');
  assert.equal(body.range.bucketCount, 1440);
  const alpha = appOf(body, 'alpha');
  const at = (hhmm: string): Bucket =>
    alpha.buckets.find((b) => b.t === `2026-08-05T${hhmm}:00.000Z`)!;
  assert.equal(at('09:59').upPct, 100);
  for (const m of ['10:00', '10:01', '10:04']) assert.equal(at(m).upPct, 0, m);
  assert.equal(at('10:05').upPct, 100);
  for (const m of ['12:00', '12:15', '12:29']) {
    assert.deepEqual(at(m), { t: at(m).t, upPct: null, samples: 0 }, `${m} is a hole, not 0%`);
  }
  assert.equal(at('12:30').upPct, 100);
  assert.equal(alpha.latency.p50, 100);
  assert.equal(alpha.latency.p95, 100);
  assert.equal(alpha.latency.approximate, false);
  assert.ok(alpha.idlePct !== null && Math.abs(alpha.idlePct - (141 / 1410) * 100) < 0.01);

  const day4 = appOf(await okBody('?from=2026-08-04&to=2026-08-04'), 'alpha');
  assert.ok(
    day4.buckets.every((b) => b.samples === 1 && b.upPct === 100),
    '300 s rows ignored',
  );
  assert.equal(day4.latency.p95, 100, '9999 ms from the 300 s vantage is ignored');
});

test('range: a whole hole day inside the monitored span is null, never downtime', async () => {
  const body = await okBody('?from=2026-08-07&to=2026-08-07');
  const alpha = appOf(body, 'alpha');
  assert.ok(alpha.buckets.every((b) => b.upPct === null && b.samples === 0));
  assert.equal(alpha.uptimePct, null);
  assert.equal(alpha.idlePct, null);
});

// ---- incidents -----------------------------------------------------------

test('range: incidents overlapping the range, open ones with endedAt null', async () => {
  const body = await okBody('?from=2026-08-05&to=2026-08-05');
  const alpha = appOf(body, 'alpha');
  assert.equal(alpha.totalIncidents, 1);
  assert.equal(alpha.truncated, false);
  assert.equal(alpha.incidents[0]!.startedAt, '2026-08-05T10:00:00.000Z');
  assert.equal(alpha.incidents[0]!.downSamples, 5);
  assert.equal(alpha.incidents[0]!.durationSeconds, 300);
  assert.equal(alpha.incidents[0]!.endedAt, '2026-08-05T10:05:00.000Z');

  const elsewhere = appOf(await okBody('?from=2026-08-06&to=2026-08-06'), 'alpha');
  assert.equal(elsewhere.totalIncidents, 0);

  await fixturePool.query(
    `INSERT INTO uptime_incidents (project_id, resource, started_at, ended_at, down_samples)
     VALUES ($1, 'beta', '2026-08-20T23:00Z', NULL, 7)`,
    [flaggedProjectId],
  );
  clearPublicRangeCache();
  const open = appOf(await okBody('?from=2026-08-20&to=2026-08-20'), 'beta');
  assert.equal(open.incidents[0]!.endedAt, null);
  assert.ok(open.incidents[0]!.durationSeconds > 0);
});

test('range: incidents are capped at 100, newest first, with truncated and the true total', async () => {
  const flappy = appOf(await okBody('?from=2026-08-11&to=2026-08-11'), 'flappy');
  assert.equal(flappy.totalIncidents, 120);
  assert.equal(flappy.incidents.length, 100);
  assert.equal(flappy.truncated, true);
  const starts = flappy.incidents.map((i) => i.startedAt);
  assert.deepEqual([...starts].sort().reverse(), starts, 'newest first');
  assert.equal(starts[0], '2026-08-11T19:50:00.000Z');
});

// ---- privacy ---------------------------------------------------------------

test('range: no sub_resource, no unflagged data, no application without uptime samples', async () => {
  const response = await getRange(flaggedProjectId, '?from=2026-08-01&to=2026-08-31');
  const text = await response.text();
  assert.ok(!/sub_?resource/i.test(text));
  const body = JSON.parse(text) as RangeBody;
  assert.deepEqual(
    body.applications.map((a) => a.key),
    ['alpha', 'beta', 'flappy', 'live'],
    "'silent' has no uptime samples",
  );
  // The unflagged project's alpha is all "down"; the flagged one's is not.
  assert.equal(appOf(body, 'alpha').buckets[2]!.upPct, 100);
  assert.equal(body.projectId, flaggedProjectId);
});

test('range: an application not opted in (public_status_visible default false) is absent even with real samples, and appears once toggled true (finding 2)', async () => {
  // Mirrors an auto-registered resource: real ingest never sets
  // public_status_visible, so it defaults false (packages/db/migrations,
  // finding 2 - a leaked key could otherwise forge a public entry).
  await fixturePool.query(
    `INSERT INTO applications (project_id, key, display_name) VALUES ($1, $2, 'Not Opted In')`,
    [flaggedProjectId, 'not-opted-in'],
  );
  await seed(
    flaggedProjectId,
    'not-opted-in',
    'uptime.ok',
    '2026-08-03T00:00Z',
    '2026-08-10T23:59Z',
    '1',
  );
  await fixturePool.query("SELECT refresh_uptime_rollup('2026-08-01T00:00Z', '2026-09-01T00:00Z')");

  clearPublicRangeCache();
  const before = JSON.parse(
    await (await getRange(flaggedProjectId, '?from=2026-08-01&to=2026-08-31')).text(),
  ) as RangeBody;
  assert.equal(
    before.applications.some((a) => a.key === 'not-opted-in'),
    false,
    'public_status_visible = false (the default) must hide it, sample or not',
  );

  await fixturePool.query(
    'UPDATE applications SET public_status_visible = true WHERE project_id = $1 AND key = $2',
    [flaggedProjectId, 'not-opted-in'],
  );
  clearPublicRangeCache();
  const after = JSON.parse(
    await (await getRange(flaggedProjectId, '?from=2026-08-01&to=2026-08-31')).text(),
  ) as RangeBody;
  assert.equal(
    after.applications.some((a) => a.key === 'not-opted-in'),
    true,
    'toggling public_status_visible true must make it appear',
  );
});

// ---- cache -----------------------------------------------------------------

async function countQueries<T>(fn: () => Promise<T>): Promise<{ value: T; queries: number }> {
  const pool = getPool();
  const original = pool.query.bind(pool);
  let queries = 0;
  (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
    queries += 1;
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  try {
    return { value: await fn(), queries };
  } finally {
    (pool as unknown as { query: unknown }).query = original;
  }
}

const NOW = new Date('2026-09-21T12:00:30Z');

test('range cache: equal requests share an entry; from/to are normalised to the minute', async () => {
  clearPublicRangeCache();
  const first = await countQueries(() =>
    getPublicUptimeRange(
      flaggedProjectId,
      { from: Date.parse('2026-08-05'), to: Date.parse('2026-08-06') },
      NOW,
    ),
  );
  assert.ok(first.queries > 0);
  const second = await countQueries(() =>
    getPublicUptimeRange(
      flaggedProjectId,
      { from: Date.parse('2026-08-05T00:00:41Z'), to: Date.parse('2026-08-06T00:00:12Z') },
      NOW,
    ),
  );
  assert.equal(second.queries, 0, 'same minute, same key');
  assert.equal(publicRangeCacheSize(), 1);
  // `to` beyond now and an absent `to` normalise to the same minute.
  const a = await countQueries(() =>
    getPublicUptimeRange(flaggedProjectId, { from: Date.parse('2026-09-20'), to: undefined }, NOW),
  );
  const b = await countQueries(() =>
    getPublicUptimeRange(
      flaggedProjectId,
      { from: Date.parse('2026-09-20'), to: Date.parse('2999-01-01') },
      new Date(NOW.getTime() + 20_000),
    ),
  );
  assert.ok(a.queries > 0);
  assert.equal(b.queries, 0);
});

test('range cache: past ranges live 1 h, live ranges 60 s, misses are 404s and errors are not kept', async () => {
  assert.equal(rangeMaxAgeSeconds(Date.parse('2026-09-21T00:00:00Z'), NOW.getTime()), 3600);
  assert.equal(rangeMaxAgeSeconds(NOW.getTime(), NOW.getTime()), 60);

  clearPublicRangeCache();
  const past = { from: Date.parse('2026-08-05'), to: Date.parse('2026-08-05') };
  await getPublicUptimeRange(flaggedProjectId, past, NOW);
  const cached = await countQueries(() =>
    getPublicUptimeRange(flaggedProjectId, past, new Date(NOW.getTime() + 59 * MIN_MS)),
  );
  assert.equal(cached.queries, 0, 'still cached after 59 min');
  const expired = await countQueries(() =>
    getPublicUptimeRange(flaggedProjectId, past, new Date(NOW.getTime() + 61 * MIN_MS)),
  );
  assert.ok(expired.queries > 0, 'recomputed after 61 min');

  clearPublicRangeCache();
  assert.equal(await getPublicUptimeRange(unflaggedProjectId, past, NOW), null);
  assert.equal(await getPublicUptimeRange('nope', past, NOW), null);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(publicRangeCacheSize(), 0, 'null results are evicted');

  await assert.rejects(
    getPublicUptimeRange(flaggedProjectId, { from: Date.now() + DAY_MS, to: undefined }),
  );
  assert.equal(publicRangeCacheSize(), 0, 'a rejected request never reaches the cache');
});

test('range cache: varying from/to cannot grow past the entry bound; the oldest entry is evicted', async () => {
  clearPublicRangeCache();
  const base = Date.parse('2026-08-05T00:00:00Z');
  const request = (i: number) =>
    getPublicUptimeRange(
      flaggedProjectId,
      { from: base + i * MIN_MS, to: base + i * MIN_MS + 30 * MIN_MS },
      NOW,
    );
  for (let i = 0; i < 300; i++) await request(i);
  assert.ok(publicRangeCacheSize() <= 256, `size ${publicRangeCacheSize()}`);
  const recent = await countQueries(() => request(299));
  assert.equal(recent.queries, 0, 'newest entry kept');
  const oldest = await countQueries(() => request(0));
  assert.ok(oldest.queries > 0, 'oldest entry was evicted and recomputed');
});

test('range: concurrent callers with different ranges each get only their own data', async () => {
  clearPublicRangeCache();
  const [a, b, c] = await Promise.all([
    okBody('?from=2026-08-05&to=2026-08-05'),
    okBody('?from=2026-08-11&to=2026-08-11'),
    okBody('?from=2026-08-20&to=2026-08-20'),
  ]);
  assert.equal(a.range.from, '2026-08-05T00:00:00.000Z');
  assert.equal(b.range.from, '2026-08-11T00:00:00.000Z');
  assert.equal(c.range.from, '2026-08-20T00:00:00.000Z');
  assert.equal(appOf(a, 'alpha').totalIncidents, 1);
  assert.equal(appOf(a, 'flappy').totalIncidents, 0);
  assert.equal(appOf(b, 'flappy').totalIncidents, 120);
  assert.equal(appOf(b, 'alpha').totalIncidents, 0);
  assert.equal(appOf(c, 'beta').buckets.filter((x) => x.upPct !== null).length, 1440);
  assert.equal(appOf(a, 'beta').buckets.filter((x) => x.upPct !== null).length, 0);
});

test('range: Cache-Control is 3600 for a range ending before today, 60 otherwise', async () => {
  const past = await getRange(flaggedProjectId, '?from=2026-08-01&to=2026-08-31');
  assert.equal(past.headers.get('cache-control'), 'public, max-age=3600');
  const live = await getRange(flaggedProjectId, '');
  assert.equal(live.headers.get('cache-control'), 'public, max-age=60');
});
