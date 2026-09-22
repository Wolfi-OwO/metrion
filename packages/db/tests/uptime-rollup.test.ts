import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createPool } from '../dist/pool.js';

/**
 * Runs against the real dev/CI database with migrations 0014/0015 applied
 * (`npm run migrate`), like the other db tests. Uses a random project id and
 * dates in 2001 so it cannot collide with real data, and removes only its own
 * rows afterwards.
 */
test('refresh_uptime_rollup: idempotent, one incident per down run, ignores 300 s, no row for empty days', async () => {
  const pool = createPool();
  const project = randomUUID();
  const base = Date.parse('2001-01-01T00:00:00Z');
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();

  const insert = async (
    resource: string,
    name: string,
    minutes: number,
    value: number,
    interval: number,
  ) => {
    await pool.query(
      `INSERT INTO uptime_samples (time, project_id, resource, name, value, unit, interval_seconds)
       VALUES ($1, $2, $3, $4, $5, 'x', $6)`,
      [at(minutes), project, resource, name, value, interval],
    );
  };

  const snapshot = async () => {
    const daily = await pool.query(
      'SELECT *, day::text AS day_text FROM uptime_daily WHERE project_id = $1 ORDER BY resource, day',
      [project],
    );
    const incidents = await pool.query(
      `SELECT resource, started_at, ended_at, down_samples FROM uptime_incidents
        WHERE project_id = $1 ORDER BY resource, started_at`,
      [project],
    );
    return { daily: daily.rows, incidents: incidents.rows };
  };

  try {
    // 60 s series: 20 checks on 2001-01-01, minutes 10-12 down.
    for (let m = 0; m < 20; m++) {
      await insert('app', 'uptime.ok', m, m >= 10 && m <= 12 ? 0 : 1, 60);
      await insert('app', 'uptime.latency', m, 100 + m, 60);
    }
    // 300 s VPS vantage, all down: must be ignored entirely.
    for (let m = 0; m < 20; m += 5) await insert('vps-only', 'uptime.ok', m, 0, 300);
    // Nothing at all on 2001-01-02; a sample on 2001-01-03 proves days are independent.
    await insert('app', 'uptime.ok', 2 * 1440, 1, 60);

    const from = '2001-01-01T00:00:00Z';
    const to = '2001-01-04T00:00:00Z';
    await pool.query('SELECT refresh_uptime_rollup($1, $2)', [from, to]);
    const first = await snapshot();
    await pool.query('SELECT refresh_uptime_rollup($1, $2)', [from, to]);
    assert.deepEqual(await snapshot(), first, 'a second run must change nothing');

    assert.deepEqual(
      first.daily.map((r) => [r.resource, r.day_text]),
      [
        ['app', '2001-01-01'],
        ['app', '2001-01-03'],
      ],
      'no row for the empty day, none for the 300 s series',
    );
    const day1 = first.daily[0];
    assert.equal(day1.total_samples, 20);
    assert.equal(day1.up_samples, 17);
    assert.equal(Number(day1.down_ms), 3 * 60_000);

    assert.equal(first.incidents.length, 1);
    assert.equal(first.incidents[0].down_samples, 3);
    assert.equal(first.incidents[0].started_at.toISOString(), at(10));
    assert.equal(first.incidents[0].ended_at.toISOString(), at(13));
  } finally {
    await pool.query('DELETE FROM uptime_incidents WHERE project_id = $1', [project]);
    await pool.query('DELETE FROM uptime_daily WHERE project_id = $1', [project]);
    await pool.query('DELETE FROM uptime_samples WHERE project_id = $1', [project]);
    await pool.end();
  }
});

test('refresh_uptime_rollup: an incident open 60 days back is left untouched by a normal-window run (finding 4)', async () => {
  const pool = createPool();
  const project = randomUUID();

  // A different base year than the file's other test (2001) so the two
  // cannot collide even though both use fixed, non-"now" dates - dates
  // picked, not `now()`, so this test is deterministic and cannot be made
  // flaky by whatever real fixtures other test files write into "now".
  const to = Date.parse('2010-06-01T00:00:00Z');
  const from = to - 2 * 24 * 60 * 60 * 1000; // mimics the routine job's own 2-day default window
  const startedAt = new Date(to - 60 * 24 * 60 * 60 * 1000); // 60 days before `to`, well past the 30-day floor

  try {
    // A monitor that went down and never reported again (decommissioned/
    // dead) - `ended_at` stays NULL forever. Inserted directly: no
    // `uptime_samples` back it, so if the floor did not hold this row would
    // be DELETEd by the incidents recompute and never re-inserted (nothing
    // in `uptime_samples` to derive it from), not just "rewritten".
    await pool.query(
      `INSERT INTO uptime_incidents (project_id, resource, started_at, ended_at, down_samples)
       VALUES ($1, 'stale-monitor', $2, NULL, 5)`,
      [project, startedAt.toISOString()],
    );

    await pool.query('SELECT refresh_uptime_rollup($1, $2)', [
      new Date(from).toISOString(),
      new Date(to).toISOString(),
    ]);

    const { rows } = await pool.query<{
      started_at: Date;
      ended_at: Date | null;
      down_samples: number;
    }>('SELECT started_at, ended_at, down_samples FROM uptime_incidents WHERE project_id = $1', [
      project,
    ]);
    assert.equal(rows.length, 1, 'the 60-day-old open incident must survive, not be deleted');
    assert.equal(rows[0]!.started_at.toISOString(), startedAt.toISOString());
    assert.equal(rows[0]!.ended_at, null);
    assert.equal(rows[0]!.down_samples, 5);
  } finally {
    await pool.query('DELETE FROM uptime_incidents WHERE project_id = $1', [project]);
    await pool.end();
  }
});

test('migration 0014: metrion_ingest can append but never delete uptime history', async () => {
  const pool = createPool();
  try {
    const { rows } = await pool.query(
      `SELECT has_table_privilege('metrion_ingest', 'uptime_samples', 'INSERT') AS ins,
              has_table_privilege('metrion_ingest', 'uptime_samples', 'DELETE') AS del,
              has_table_privilege('metrion_ingest', 'uptime_samples', 'UPDATE') AS upd,
              (SELECT count(*) FROM timescaledb_information.jobs
                WHERE hypertable_name = 'uptime_samples' AND proc_name LIKE 'policy_retention%')::int AS retention`,
    );
    assert.deepEqual(rows[0], { ins: true, del: false, upd: false, retention: 0 });
  } finally {
    await pool.end();
  }
});
