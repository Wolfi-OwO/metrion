import assert from 'node:assert/strict';
import test from 'node:test';

// Same local-dev database every other DB-backed test file here uses.
process.env['DATABASE_URL'] = 'postgres://metrion:metrion@localhost:5432/metrion';

const { getResources, getSeries } = await import('../dist/services/metrics-service.js');
const { createPool } = await import('@metrion/db/dist/pool.js');

// A blue/green app (and scaled pods) must read as ONE service whose value is
// the mean of its pods - two dashboards for blue and green was the bug.
test('blue/green containers collapse into one service; average by default, per pod on request', async () => {
  const pool = createPool();
  const marker = `svc_group_${Date.now()}`;
  const {
    rows: [user],
  } = await pool.query('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `${marker}@example.test`,
  ]);
  const {
    rows: [project],
  } = await pool.query(
    'INSERT INTO projects (owner_user_id, name, slug) VALUES ($1, $2, $2) RETURNING id',
    [user.id, marker],
  );
  const at = new Date(Date.now() - 5 * 60_000);
  try {
    for (const [sub, value] of [
      ['container:web-blue-1', 10],
      ['container:web-green-1', 30],
      ['container:db-1', 5],
    ] as const) {
      await pool.query(
        `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
         VALUES ($1, $2, 'app', $3, 'container.cpu', $4, 'percent', 60)`,
        [at, project.id, sub, value],
      );
    }
    const from = new Date(Date.now() - 3600_000);
    const to = new Date();

    const { resources } = await getResources([project.id], from, to);
    assert.deepEqual(resources[0]!.subResources, ['container:db', 'container:web']);
    assert.deepEqual(resources[0]!.instances['container:web'], [
      'container:web-blue-1',
      'container:web-green-1',
    ]);

    const base = {
      projectIds: [project.id],
      resource: 'app',
      subResource: 'container:web',
      names: ['container.cpu'],
      from,
      to,
      stepSeconds: 3600,
    };
    const averaged = await getSeries(base);
    assert.equal(averaged.series.length, 1);
    assert.equal(averaged.series[0]!.points[0]!.value, 20, 'mean of both colours');

    const perPod = await getSeries({ ...base, perInstance: true });
    assert.deepEqual(
      perPod.series.map((s) => [s.subResource, s.points[0]!.value]),
      [
        ['container:web-blue-1', 10],
        ['container:web-green-1', 30],
      ],
    );
  } finally {
    await pool.query('DELETE FROM metrics WHERE project_id = $1', [project.id]);
    await pool.query('DELETE FROM projects WHERE id = $1', [project.id]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    await pool.end();
  }
});
