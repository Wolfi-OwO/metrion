import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project } from '../src/api/client.ts';
import {
  buildRows,
  filterRows,
  formatRelative,
  freshnessOf,
  lastCheckLabel,
  sortRows,
  totalsOf,
  verdictOf,
} from '../src/lib/dashboard.ts';
import { parseProjectsSummary, type ProjectSummary } from '../src/lib/summary.ts';

const project = (id: string, name: string, createdAt = '2026-09-01T00:00:00Z'): Project => ({
  id,
  name,
  slug: name.toLowerCase().replace(/\s+/g, '-'),
  defaultResource: null,
  createdAt,
});

const summary = (
  projectId: string,
  worst: ProjectSummary['worst'],
  lastSampleAt: string | null,
  counts = { ok: 1, warning: 0, critical: 0 },
): ProjectSummary => ({
  projectId,
  applicationCount: counts.ok + counts.warning + counts.critical,
  counts,
  worst,
  lastSampleAt,
  activity24h: Array<number>(24).fill(0),
});

test('rows sort worst status first, then by name within a rank', () => {
  const projects = [
    project('a', 'Alpha'),
    project('b', 'Beta'),
    project('c', 'Gamma'),
    project('d', 'Delta'),
  ];
  const rows = buildRows(projects, [
    summary('a', 'ok', '2026-09-20T10:00:00Z'),
    summary('b', 'ok', '2026-09-20T12:00:00Z'),
    summary('c', 'critical', '2026-09-19T00:00:00Z', { ok: 0, warning: 0, critical: 1 }),
    summary('d', 'warning', '2026-09-20T09:00:00Z', { ok: 0, warning: 1, critical: 0 }),
  ]);
  assert.deepEqual(
    sortRows(rows).map((r) => r.project.id),
    ['c', 'd', 'a', 'b'],
  );
});

test('two same-status rows keep their order when lastSampleAt swaps on refresh', () => {
  const projects = [project('a', 'Alpha'), project('b', 'Beta')];
  const before = sortRows(
    buildRows(projects, [
      summary('a', 'ok', '2026-09-20T10:00:00Z'),
      summary('b', 'ok', '2026-09-20T09:00:00Z'),
    ]),
  ).map((r) => r.project.id);
  // A minute later the poll lands for b first, so b's sample is now the newer
  // one - the exact value that used to decide the order.
  const after = sortRows(
    buildRows(projects, [
      summary('a', 'ok', '2026-09-20T10:00:00Z'),
      summary('b', 'ok', '2026-09-20T10:01:00Z'),
    ]),
  ).map((r) => r.project.id);
  assert.deepEqual(before, after);
});

test('a project with no summary or no samples sorts last within its rank and never throws', () => {
  const rows = buildRows(
    [project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma')],
    [summary('a', 'ok', null), summary('b', 'ok', '2026-09-20T10:00:00Z')],
  );
  assert.deepEqual(
    sortRows(rows).map((r) => r.project.id),
    ['b', 'a', 'c'],
  );
});

test('without any summary the API order is kept newest first', () => {
  const rows = buildRows(
    [project('a', 'Old', '2026-01-01T00:00:00Z'), project('b', 'New', '2026-09-01T00:00:00Z')],
    null,
  );
  assert.deepEqual(
    sortRows(rows).map((r) => r.project.id),
    ['b', 'a'],
  );
});

test('summary-to-row mapping joins by id and leaves unknown projects with null', () => {
  const rows = buildRows(
    [project('a', 'Alpha'), project('z', 'Zed')],
    [summary('a', 'ok', null), summary('ghost', 'ok', null)],
  );
  assert.equal(rows[0]!.summary?.projectId, 'a');
  assert.equal(rows[1]!.summary, null);
  assert.equal(rows.length, 2);
});

test('totals add up counts and find the newest sample', () => {
  const rows = buildRows(
    [project('a', 'Alpha'), project('b', 'Beta')],
    [
      summary('a', 'warning', '2026-09-20T10:00:00Z', { ok: 5, warning: 1, critical: 0 }),
      summary('b', 'ok', '2026-09-20T11:00:00Z', { ok: 1, warning: 0, critical: 0 }),
    ],
  );
  assert.deepEqual(totalsOf(rows), {
    projects: 2,
    applications: 7,
    ok: 6,
    warning: 1,
    critical: 0,
    lastSampleAt: Date.parse('2026-09-20T11:00:00Z'),
  });
});

test('the verdict names one project, counts several, and does not call silence healthy', () => {
  const p = [project('a', 'Alpha'), project('b', 'Beta')];
  const healthy = buildRows(p, [summary('a', 'ok', null), summary('b', 'ok', null)]);
  assert.equal(verdictOf(healthy).headline, 'All systems healthy');

  const one = buildRows(p, [
    summary('a', 'ok', null),
    summary('b', 'critical', null, { ok: 0, warning: 0, critical: 1 }),
  ]);
  assert.deepEqual(verdictOf(one), {
    tone: 'critical',
    headline: '1 project needs attention: Beta',
  });

  const two = buildRows(p, [
    summary('a', 'warning', null, { ok: 0, warning: 1, critical: 0 }),
    summary('b', 'warning', null, { ok: 0, warning: 1, critical: 0 }),
  ]);
  assert.equal(verdictOf(two).headline, '2 projects need attention');
  assert.equal(verdictOf(two).tone, 'warning');

  const silent = buildRows(p, [summary('a', 'unknown', null, { ok: 0, warning: 0, critical: 0 })]);
  assert.equal(verdictOf(silent).tone, 'neutral');
});

test('freshness: two minutes is fresh, beyond is stale, no sample is none', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(freshnessOf(now - 120_000, now), 'fresh');
  assert.equal(freshnessOf(now - 120_001, now), 'stale');
  assert.equal(freshnessOf('2026-09-20T11:59:20Z', now), 'fresh');
  assert.equal(freshnessOf(null, now), 'none');
  assert.equal(freshnessOf('not a date', now), 'none');
});

test('relative time steps through seconds, minutes, hours and days', () => {
  assert.equal(formatRelative(40_000), '40 s ago');
  assert.equal(formatRelative(-5_000), '0 s ago');
  assert.equal(formatRelative(59_999), '59 s ago');
  assert.equal(formatRelative(60_000), '1 min ago');
  assert.equal(formatRelative(59 * 60_000), '59 min ago');
  assert.equal(formatRelative(3 * 3_600_000), '3 h ago');
  assert.equal(formatRelative(47 * 3_600_000), '47 h ago');
  assert.equal(formatRelative(72 * 3_600_000), '3 d ago');
});

test('last check label: up/down with age, stale past 3 minutes, null passes through', () => {
  const now = Date.parse('2026-09-20T12:00:00Z');
  assert.equal(
    lastCheckLabel({ ok: true, at: new Date(now - 40_000).toISOString() }, now),
    'Up · 40 s ago',
  );
  assert.equal(
    lastCheckLabel({ ok: false, at: new Date(now - 90_000).toISOString() }, now),
    'Down · 1 min ago',
  );
  assert.equal(
    lastCheckLabel({ ok: true, at: new Date(now - 180_001).toISOString() }, now),
    'No recent check',
  );
  assert.equal(lastCheckLabel(null, now), null);
  assert.equal(lastCheckLabel({ ok: true, at: 'not a date' }, now), null);
});

test('filter matches name or slug case-insensitively', () => {
  const rows = buildRows([project('a', 'Production Fleet'), project('b', 'Staging')], null);
  assert.deepEqual(
    filterRows(rows, 'FLEET').map((r) => r.project.id),
    ['a'],
  );
  assert.deepEqual(
    filterRows(rows, 'staging').map((r) => r.project.id),
    ['b'],
  );
  assert.equal(filterRows(rows, '  ').length, 2);
  assert.equal(filterRows(rows, 'nope').length, 0);
});

test('the parser tolerates missing, mistyped and short fields', () => {
  assert.deepEqual(parseProjectsSummary(null), []);
  assert.deepEqual(parseProjectsSummary({ projects: 'nope' }), []);
  const [row, ...rest] = parseProjectsSummary({
    projects: [
      {
        projectId: 'a',
        applicationCount: 3,
        status: { ok: 2, warning: 1, critical: 0, unknown: 0 },
        worst: 'bogus',
        lastSampleAt: 'garbage',
        activity24h: [1, 2, 'x', -4],
      },
      { applicationCount: 1 },
    ],
  });
  assert.equal(rest.length, 0);
  assert.equal(row!.worst, 'warning');
  assert.equal(row!.lastSampleAt, null);
  assert.equal(row!.activity24h.length, 24);
  assert.deepEqual(row!.activity24h.slice(-4), [1, 2, 0, 0]);
});

test('a project with no applications parses as unknown', () => {
  const [row] = parseProjectsSummary({
    projects: [
      {
        projectId: 'a',
        applicationCount: 0,
        status: { critical: 0, warning: 0, ok: 0, unknown: 0 },
        worst: 'unknown',
        lastSampleAt: null,
        activity24h: [],
      },
    ],
  });
  assert.equal(row!.worst, 'unknown');
  assert.equal(row!.applicationCount, 0);
});
