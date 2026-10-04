import assert from 'node:assert/strict';
import test from 'node:test';
import { runEvaluationCycle } from '../dist/evaluate.js';
import { createApplication, createThreshold, insertMetric, seedProject, testPool } from './seed.ts';

// Regression: fuwwy-platform sat at Critical for a day because the idle
// colour of a blue/green deploy (`preussen-dashboard-green-1`) stopped
// reporting and got its own critical/no_data status row. The idle colour is
// expected to be silent - one live pod must keep the service healthy, and two
// pods must be judged on their average.

test('blue/green: an idle colour never turns the service critical, and pods are averaged', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `blue_green_${Date.now()}`);
  const appId = await createApplication(pool, seed.projectId, 'bg-app');
  const thresholdId = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'container.cpu',
    direction: 'above',
    warningValue: 50,
    criticalValue: 80,
    consecutiveBreaches: 1,
    windowSeconds: 900,
  });
  const sample = (sub: string, value: number) =>
    insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'bg-app',
      subResource: `container:${sub}`,
      name: 'container.cpu',
      value,
    });
  const statuses = async () =>
    (
      await pool.query(
        'SELECT sub_resource_key, state, reason, value FROM threshold_status WHERE threshold_id = $1',
        [thresholdId],
      )
    ).rows;

  try {
    // Both colours live: 10 and 30 average to 20, ONE row for the service.
    await sample('dash-blue-1', 10);
    await sample('dash-green-1', 30);
    await runEvaluationCycle(pool);
    let rows = await statuses();
    assert.equal(rows.length, 1, 'blue and green share one status row');
    assert.equal(rows[0].sub_resource_key, 'container:dash');
    assert.equal(rows[0].state, 'ok');
    assert.equal(rows[0].value, 20, 'mean of the two pods, not a sum');

    // Swap done: green goes silent. Blue alone keeps the service ok.
    await pool.query(
      `DELETE FROM metrics WHERE project_id = $1 AND sub_resource = 'container:dash-green-1'`,
      [seed.projectId],
    );
    await runEvaluationCycle(pool);
    rows = await statuses();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, 'ok');
    assert.equal(rows[0].reason, 'threshold', 'a silent idle colour is not no_data');
    assert.equal(rows[0].value, 10);
  } finally {
    await pool.query('DELETE FROM metrics WHERE project_id = $1', [seed.projectId]);
    await seed.cleanup();
    await pool.end();
  }
});
