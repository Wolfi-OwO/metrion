import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { CommittedEvent } from '../dist/evaluate.js';
import { runEvaluationCycle } from '../dist/evaluate.js';
import { createTestTransport, sendDigests } from '../dist/mailer.js';
import { createApplication, createThreshold, seedProject, testPool } from './seed.ts';
import type { Pool } from 'pg';

// Proves GitHub issue #28's two requirements for `uptime.ok` thresholds,
// tuned against the real cadence Task 6 measured (1 sample/minute, not the
// 5-minute cadence the original seed assumed):
//   (a) a single failed check among otherwise-passing samples sends 0 emails
//   (b) an outage that outlasts the window sends exactly 1 email while
//       ongoing (not one per warning-then-critical step), and recovery
//       sends exactly 1 recovery email.
//
// window_seconds=900 at 1/minute is 15 samples/window. warning=0.9,
// critical=0.8, consecutive_breaches=2 (the schema's own default) - see
// scripts/seed-thresholds.mjs for why these specific numbers, not the
// previously-seeded 0.995/0.8 (one flap already reads ~0.93, below 0.995)
// or the GitHub issue's own suggested 300s/0.99 (same problem at 5 samples).

const WINDOW_SECONDS = 900;
const SAMPLE_COUNT = 15; // 900s at 1 sample/minute
const WARNING = 0.9;
const CRITICAL = 0.8;
const CONSECUTIVE_BREACHES = 2;

/**
 * Replaces every `uptime.ok` sample for this resource with exactly
 * `SAMPLE_COUNT` rows - `successCount` passing (value 1), the rest failing
 * (value 0) - spaced one minute apart and all inside the window. `avg()`
 * over a window doesn't care about spacing, only which rows are present at
 * call time, so this is the deterministic stand-in for "one more minute of
 * real samples arrived" the no_data test in evaluate.test.ts already
 * documents as this package's answer to not waiting on the wall clock.
 */
async function replaceSamples(
  pool: Pool,
  projectId: string,
  resource: string,
  successCount: number,
): Promise<void> {
  await pool.query(
    `DELETE FROM metrics WHERE project_id = $1 AND resource = $2 AND name = 'uptime.ok'`,
    [projectId, resource],
  );
  const rows: Array<{ value: number; at: Date }> = [];
  for (let i = 0; i < SAMPLE_COUNT; i += 1) {
    rows.push({ value: i < successCount ? 1 : 0, at: new Date(Date.now() - i * 60_000) });
  }
  for (const row of rows) {
    await pool.query(
      `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
       VALUES ($1, $2, $3, NULL, 'uptime.ok', $4, 'boolean', 60)`,
      [row.at, projectId, resource, row.value],
    );
  }
}

test('uptime.ok alerting: one flapped check sends no email; a sustained outage sends exactly one, and recovery exactly one', async () => {
  const pool = testPool();
  const marker = `uptime_alert_${Date.now()}`;
  const seed = await seedProject(pool, marker);
  const appId = await createApplication(pool, seed.projectId, 'netviz', 'Network Visualizer');
  await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'uptime.ok',
    direction: 'below',
    warningValue: WARNING,
    criticalValue: CRITICAL,
    consecutiveBreaches: CONSECUTIVE_BREACHES,
    windowSeconds: WINDOW_SECONDS,
  });

  const transport = createTestTransport();
  const sendMail = mock.method(transport, 'sendMail');
  const cycle = async (successCount: number): Promise<CommittedEvent[]> => {
    await replaceSamples(pool, seed.projectId, 'netviz', successCount);
    const events = await runEvaluationCycle(pool);
    await sendDigests(
      pool,
      transport,
      { from: 'alerts@example.test', dailyEmailCap: 50, cooldownMinutes: 60 },
      events,
    );
    return events;
  };

  try {
    // --- (a) a single failed check among 14 passing ones: never leaves 'ok'. ---
    let events = await cycle(14); // 1/15 failed, avg=0.9333 > warning 0.9
    assert.equal(events.length, 0, 'one flapped check must not commit a state change');
    assert.equal(sendMail.mock.calls.length, 0, 'and therefore must send no email');

    // --- (b) a growing outage: ok -> warning (not committed) -> critical (committed once). ---
    events = await cycle(13); // 2/15 failed, avg=0.8667: warning candidate, breach 0->1
    assert.equal(events.length, 0, 'the first differing cycle only starts the breach streak');
    assert.equal(sendMail.mock.calls.length, 0);

    events = await cycle(12); // 3/15 failed, avg=0.8: critical candidate, breach 1->2, commits
    assert.equal(events.length, 1, 'the consecutive_breaches-th cycle commits exactly once');
    assert.equal(events[0]!.toState, 'critical');
    assert.equal(sendMail.mock.calls.length, 1, 'commit to critical sends exactly one email');
    assert.equal(
      (sendMail.mock.calls[0]!.arguments[0] as { subject: string }).subject,
      'Metrion alert: ' + marker,
    );

    // Outage continues, now total - candidate stays critical, matches the
    // already-committed state, so no further events and no further email
    // while it remains ongoing (the issue's "exactly one while ongoing").
    events = await cycle(0); // 15/15 failed, avg=0
    assert.equal(events.length, 0, 'a sustained outage must not re-commit or re-notify');
    assert.equal(
      sendMail.mock.calls.length,
      1,
      'still exactly one email while the outage continues',
    );

    events = await cycle(0);
    assert.equal(events.length, 0);
    assert.equal(sendMail.mock.calls.length, 1, 'a second sustained-outage cycle changes nothing');

    // --- recovery: critical -> warning (not committed) -> ok (committed once). ---
    events = await cycle(12); // 3/15 still failed, avg=0.8: matches stored critical, no breach
    assert.equal(events.length, 0, 'recovery starting from the critical floor is still critical');
    assert.equal(sendMail.mock.calls.length, 1);

    events = await cycle(13); // 2/15 failed, avg=0.8667: warning candidate, breach 0->1
    assert.equal(events.length, 0, 'passing through warning on the way up must not itself commit');
    assert.equal(sendMail.mock.calls.length, 1);

    events = await cycle(14); // 1/15 failed, avg=0.9333: ok candidate, breach 1->2, commits straight to ok
    assert.equal(events.length, 1, 'recovery commits exactly once, straight from critical to ok');
    assert.equal(events[0]!.fromState, 'critical');
    assert.equal(events[0]!.toState, 'ok');
    assert.equal(
      sendMail.mock.calls.length,
      2,
      'exactly one recovery email, not one per state passed through',
    );

    events = await cycle(15); // fully recovered
    assert.equal(events.length, 0, 'a clean window after recovery must not re-notify');
    assert.equal(
      sendMail.mock.calls.length,
      2,
      'final count: one outage email, one recovery email',
    );
  } finally {
    await pool.query(
      `DELETE FROM metrics WHERE project_id = $1 AND resource = 'netviz' AND name = 'uptime.ok'`,
      [seed.projectId],
    );
    await seed.cleanup();
    await pool.end();
  }
});
