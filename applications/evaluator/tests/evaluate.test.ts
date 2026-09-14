import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyHysteresis,
  candidateState,
  pruneOldStatusEvents,
  runEvaluationCycle,
} from '../dist/evaluate.js';
import { createApplication, createThreshold, insertMetric, seedProject, testPool } from './seed.ts';

// --- Pure functions: no database, the fast/cheap part of this suite. ---

test('candidateState: direction=above, a null bound never matches', () => {
  const threshold = { direction: 'above' as const, warningValue: null, criticalValue: 90 };
  assert.equal(
    candidateState(threshold, { subResourceKey: '', avgValue: 50, sampleCount: 3 }, false).state,
    'ok',
  );
  assert.equal(
    candidateState(threshold, { subResourceKey: '', avgValue: 95, sampleCount: 3 }, false).state,
    'critical',
  );
});

test('candidateState: direction=below fires under the bound, not over it', () => {
  const threshold = { direction: 'below' as const, warningValue: 20, criticalValue: 10 };
  assert.equal(
    candidateState(threshold, { subResourceKey: '', avgValue: 50, sampleCount: 3 }, false).state,
    'ok',
  );
  assert.equal(
    candidateState(threshold, { subResourceKey: '', avgValue: 15, sampleCount: 3 }, false).state,
    'warning',
  );
  assert.equal(
    candidateState(threshold, { subResourceKey: '', avgValue: 5, sampleCount: 3 }, false).state,
    'critical',
  );
});

test('candidateState: zero samples is ok when there is no prior status (never seen data)', () => {
  const threshold = { direction: 'above' as const, warningValue: 80, criticalValue: 90 };
  const result = candidateState(threshold, null, false);
  assert.deepEqual(result, { state: 'ok', reason: 'threshold', value: null });
});

test('candidateState: zero samples is critical/no_data once a prior status exists', () => {
  const threshold = { direction: 'above' as const, warningValue: 80, criticalValue: 90 };
  const result = candidateState(
    threshold,
    { subResourceKey: '', avgValue: 0, sampleCount: 0 },
    true,
  );
  assert.deepEqual(result, { state: 'critical', reason: 'no_data', value: null });
});

test('applyHysteresis: a candidate matching the stored state resets breachCount and never commits', () => {
  const result = applyHysteresis('ok', 1, 'ok', 2);
  assert.deepEqual(result, { commit: false, nextState: 'ok', nextBreachCount: 0 });
});

test('applyHysteresis: commits only once breachCount reaches consecutiveBreaches, then resets it', () => {
  const first = applyHysteresis('ok', 0, 'critical', 2);
  assert.deepEqual(first, { commit: false, nextState: 'ok', nextBreachCount: 1 });

  const second = applyHysteresis('ok', 1, 'critical', 2);
  assert.deepEqual(second, { commit: true, nextState: 'critical', nextBreachCount: 0 });
});

// --- Integration: a real seeded Postgres, per the acceptance criteria. ---

test('runEvaluationCycle: a critical breach held for consecutive_breaches cycles commits exactly once', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `eval_commit_${Date.now()}`);
  const appId = await createApplication(pool, seed.projectId, 'api');
  const thresholdId = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'cpu_percent',
    direction: 'above',
    criticalValue: 90,
    consecutiveBreaches: 2,
    windowSeconds: 300,
  });

  try {
    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'api',
      name: 'cpu_percent',
      value: 95,
    });
    await runEvaluationCycle(pool); // cycle 1: candidate=critical, breachCount 0->1, not committed yet

    let events = (
      await pool.query('SELECT * FROM status_events WHERE threshold_id = $1', [thresholdId])
    ).rows;
    assert.equal(events.length, 0, 'one breaching cycle alone must not produce an event');

    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'api',
      name: 'cpu_percent',
      value: 96,
    });
    await runEvaluationCycle(pool); // cycle 2: breachCount 1->2, commits

    events = (
      await pool.query('SELECT * FROM status_events WHERE threshold_id = $1', [thresholdId])
    ).rows;
    assert.equal(
      events.length,
      1,
      'the consecutive_breaches-th cycle must produce exactly one event',
    );
    assert.equal(events[0].from_state, 'ok');
    assert.equal(events[0].to_state, 'critical');

    // A third cycle at the same reading must not add a second event - the
    // state is already committed to critical, so the candidate now matches
    // the stored state.
    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'api',
      name: 'cpu_percent',
      value: 97,
    });
    await runEvaluationCycle(pool);
    events = (
      await pool.query('SELECT * FROM status_events WHERE threshold_id = $1', [thresholdId])
    ).rows;
    assert.equal(events.length, 1, 'a stable critical reading must not add further events');
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('runEvaluationCycle: direction=below fires under its bound', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `eval_below_${Date.now()}`);
  const appId = await createApplication(pool, seed.projectId, 'db');
  const thresholdId = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'free_memory_mb',
    direction: 'below',
    criticalValue: 100,
    consecutiveBreaches: 1,
    windowSeconds: 300,
  });

  try {
    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'db',
      name: 'free_memory_mb',
      value: 50,
    });
    await runEvaluationCycle(pool);

    const status = (
      await pool.query('SELECT state FROM threshold_status WHERE threshold_id = $1', [thresholdId])
    ).rows[0];
    assert.equal(status.state, 'critical');
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('runEvaluationCycle: data that stops arriving flips to critical/no_data, not immediately if never seen', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `eval_nodata_${Date.now()}`);
  const appId = await createApplication(pool, seed.projectId, 'worker');
  const thresholdId = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'queue_depth',
    direction: 'above',
    criticalValue: 1000,
    consecutiveBreaches: 1,
    windowSeconds: 60,
  });

  try {
    // Before any metric ever arrives: no threshold_status row, cycle is a no-op.
    await runEvaluationCycle(pool);
    const beforeAnyData = (
      await pool.query('SELECT state FROM threshold_status WHERE threshold_id = $1', [thresholdId])
    ).rows;
    assert.equal(beforeAnyData.length, 0, 'a threshold that has never seen data must not alert');

    // Establish a prior "ok" threshold_status row directly, the same shape
    // a real cycle with in-window data would have left - `window_seconds`
    // has a 60s floor (thresholds' own CHECK constraint), so backdating a
    // real metric out of the window inside a fast test would need a real
    // wall-clock wait; this is the deterministic equivalent.
    await pool.query(
      `INSERT INTO threshold_status (threshold_id, sub_resource_key, state, reason, value, breach_count, since, updated_at)
       VALUES ($1, '', 'ok', 'threshold', 10, 0, now(), now())`,
      [thresholdId],
    );

    // Data stops - this cycle's window has zero samples for this threshold.
    await runEvaluationCycle(pool);
    const [row] = (
      await pool.query('SELECT state, reason FROM threshold_status WHERE threshold_id = $1', [
        thresholdId,
      ])
    ).rows;
    assert.equal(row.state, 'critical');
    assert.equal(row.reason, 'no_data');

    const events = (
      await pool.query(
        'SELECT to_state, value FROM status_events WHERE threshold_id = $1 ORDER BY at',
        [thresholdId],
      )
    ).rows;
    assert.equal(events.at(-1).to_state, 'critical');
    assert.equal(events.at(-1).value, null);
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('pruneOldStatusEvents: deletes only events older than the retention window', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `eval_prune_${Date.now()}`);
  const appId = await createApplication(pool, seed.projectId, 'api');
  const thresholdId = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'cpu_percent',
    direction: 'above',
    criticalValue: 90,
    consecutiveBreaches: 1,
  });

  try {
    await pool.query(
      `INSERT INTO status_events (project_id, threshold_id, sub_resource_key, from_state, to_state, at)
       VALUES ($1, $2, '', 'ok', 'critical', now() - interval '200 days'),
              ($1, $2, '', 'critical', 'ok', now() - interval '1 day')`,
      [seed.projectId, thresholdId],
    );

    await pruneOldStatusEvents(pool, 180);

    const remaining = (
      await pool.query('SELECT to_state FROM status_events WHERE threshold_id = $1', [thresholdId])
    ).rows;
    assert.deepEqual(
      remaining.map((row: { to_state: string }) => row.to_state),
      ['ok'],
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});
