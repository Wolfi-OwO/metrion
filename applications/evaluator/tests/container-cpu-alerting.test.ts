import assert from 'node:assert/strict';
import test from 'node:test';
import type { CommittedEvent } from '../dist/evaluate.js';
import { runEvaluationCycle } from '../dist/evaluate.js';
import { createApplication, createThreshold, seedProject, testPool } from './seed.ts';
import type { Pool } from 'pg';

// Proves the re-anchored container.cpu bounds (scripts/seed-thresholds.mjs)
// against a real 0.3-core container (nutrilens-nutrilens-blue-1):
// warning=15, critical=24 (50%/80% of the 0.3-core limit, expressed as
// %-of-one-host-core), window_seconds=900 (15 samples at 1/minute),
// consecutive_breaches=2 (schema default).
//
// Sample values below are measured production figures, not derived: p50
// 1.6, max single-minute overshoot 106.7 (both nutrilens-nutrilens-blue-1,
// container.cpu, 7-day window).

const WINDOW_SECONDS = 900;
const SAMPLE_COUNT = 15; // 900s at 1 sample/minute
const WARNING = 15;
const CRITICAL = 24;
const CONSECUTIVE_BREACHES = 2;
const RESOURCE = 'nutrilens';
const SUB_RESOURCE = 'container:nutrilens-nutrilens-blue-1';

/**
 * Replaces every container.cpu sample for this resource/sub_resource with
 * exactly `values.length` rows, one minute apart, `values[0]` the most
 * recent - the same "fake a fresh window" stand-in
 * tests/uptime-alerting.test.ts already uses, since `avg()` over the window
 * only cares which rows are present at call time, not real wall-clock
 * spacing.
 */
async function replaceSamples(pool: Pool, projectId: string, values: number[]): Promise<void> {
  await pool.query(
    `DELETE FROM metrics WHERE project_id = $1 AND resource = $2 AND sub_resource = $3 AND name = 'container.cpu'`,
    [projectId, RESOURCE, SUB_RESOURCE],
  );
  for (let i = 0; i < values.length; i += 1) {
    await pool.query(
      `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
       VALUES ($1, $2, $3, $4, 'container.cpu', $5, 'percent', 60)`,
      [new Date(Date.now() - i * 60_000), projectId, RESOURCE, SUB_RESOURCE, values[i]],
    );
  }
}

test('container.cpu alerting: new 50/80%-of-limit bounds hold normal load and commit exactly once per real transition', async () => {
  const pool = testPool();
  const marker = `container_cpu_alert_${Date.now()}`;
  const seed = await seedProject(pool, marker);
  const appId = await createApplication(pool, seed.projectId, RESOURCE, 'Nutrilens');
  const thresholdId = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    subResource: SUB_RESOURCE,
    metricName: 'container.cpu',
    direction: 'above',
    warningValue: WARNING,
    criticalValue: CRITICAL,
    consecutiveBreaches: CONSECUTIVE_BREACHES,
    windowSeconds: WINDOW_SECONDS,
  });

  const cycle = async (values: number[]): Promise<CommittedEvent[]> => {
    await replaceSamples(pool, seed.projectId, values);
    const events = await runEvaluationCycle(pool);
    return events.filter((e) => e.thresholdId === thresholdId);
  };

  // SAMPLE_COUNT - 1 samples at the measured p50 (1.6) plus one at the
  // measured max single-minute overshoot (106.7): mean 8.6, well under
  // warning (15).
  const baseline = [...Array(SAMPLE_COUNT - 1).fill(1.6), 106.7];
  // 10 of the SAMPLE_COUNT one-minute samples pinned at the limit (30 =
  // 100% of the 0.3-core quota, as %-of-one-host-core), the rest still the
  // old baseline (1.6) - models the window filling as a sustained load
  // starts.
  const tenMinutesAtLimit = [...Array(10).fill(30), ...Array(SAMPLE_COUNT - 10).fill(1.6)];
  // Full SAMPLE_COUNT-sample window pinned at the limit.
  const fullWindowAtLimit = Array(SAMPLE_COUNT).fill(30);

  try {
    // --- (a) normal load + one burst minute: never leaves 'ok', across 3 cycles. ---
    let events = await cycle(baseline); // mean 8.6 < warning 15
    assert.equal(events.length, 0, 'cycle 1: mean 8.6 is ok, no prior state to differ from');
    events = await cycle(baseline);
    assert.equal(events.length, 0, 'cycle 2: still ok, candidate matches stored state');
    events = await cycle(baseline);
    assert.equal(events.length, 0, 'cycle 3: still ok - 0 events over all 3 cycles');

    // --- (b) sustained load crossing into warning: commits once, on the 2nd cycle. ---
    events = await cycle(tenMinutesAtLimit); // mean 20.5: warning candidate, breach 0->1
    assert.equal(events.length, 0, 'first warning-range cycle only starts the breach streak');
    events = await cycle(tenMinutesAtLimit); // same composition: breach 1->2, commits
    assert.equal(events.length, 1, 'the consecutive_breaches-th cycle commits exactly once');
    assert.equal(events[0]!.fromState, 'ok');
    assert.equal(events[0]!.toState, 'warning');

    // --- (c) sustained load crossing into critical: commits once, on the 2nd cycle. ---
    events = await cycle(fullWindowAtLimit); // mean 30: critical candidate, breach 0->1
    assert.equal(events.length, 0, 'first critical-range cycle only starts the breach streak');
    events = await cycle(fullWindowAtLimit); // breach 1->2, commits
    assert.equal(events.length, 1, 'commits exactly one transition to critical');
    assert.equal(events[0]!.fromState, 'warning');
    assert.equal(events[0]!.toState, 'critical');

    // --- (d) return to baseline: commits exactly one transition back to ok. ---
    events = await cycle(baseline); // mean 8.6: ok candidate, breach 0->1
    assert.equal(events.length, 0, 'first recovery cycle only starts the breach streak');
    events = await cycle(baseline); // breach 1->2, commits
    assert.equal(events.length, 1, 'commits exactly one transition back to ok');
    assert.equal(events[0]!.fromState, 'critical');
    assert.equal(events[0]!.toState, 'ok');
  } finally {
    await pool.query(
      `DELETE FROM metrics WHERE project_id = $1 AND resource = $2 AND sub_resource = $3 AND name = 'container.cpu'`,
      [seed.projectId, RESOURCE, SUB_RESOURCE],
    );
    await seed.cleanup();
    await pool.end();
  }
});
