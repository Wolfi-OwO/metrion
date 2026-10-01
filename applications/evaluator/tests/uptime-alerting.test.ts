import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { CommittedEvent } from '../dist/evaluate.js';
import { runEvaluationCycle } from '../dist/evaluate.js';
import { createTestTransport, sendDigests } from '../dist/mailer.js';
import { createApplication, createThreshold, seedProject, testPool } from './seed.ts';
import type { Pool } from 'pg';

// Proves the faster-detection `uptime.ok` values (2026-10-01, user-accepted
// trade-off; see organizational/uptime-alerting.md and
// scripts/seed-thresholds.mjs's uptime.ok block for the full reasoning
// history, including the original 900/0.9/0.8/2 version this superseded):
//   (a) a single failed check among otherwise-passing samples sends 0
//       emails, holding across the 4/5/6-sample jitter a 300s window
//       actually sees at the real 1/minute cadence
//   (b) two failed checks inside the window commits 'critical' in ONE
//       evaluator cycle (consecutive_breaches=1, no second-cycle
//       confirmation) with exactly one email; a continued outage sends no
//       more; recovery to one-or-zero failures commits 'ok' in one cycle
//       with exactly one email
//
// window_seconds=300, critical=0.7, warning=null (no intermediate state),
// consecutive_breaches=1.

const WINDOW_SECONDS = 300;
const WARNING = null;
const CRITICAL = 0.7;
const CONSECUTIVE_BREACHES = 1;

/**
 * Replaces every `uptime.ok` sample for this resource with exactly
 * `sampleCount` rows - `successCount` passing (value 1), the rest failing
 * (value 0) - spaced one minute apart and all inside the window. `avg()`
 * over a window doesn't care about spacing, only which rows are present at
 * call time, so this is the deterministic stand-in for "one more minute of
 * real samples arrived" the no_data test in evaluate.test.ts already
 * documents as this package's answer to not waiting on the wall clock.
 *
 * `spacingMs` defaults to the real 60s cadence; the window-boundary
 * robustness case below passes a smaller one. At the real cadence the
 * oldest of 6 samples sits exactly `5 * 60_000 = 300_000`ms back - the
 * literal edge of a 300s window - which the query's own `now()` (evaluated
 * a few ms after these rows were inserted, by SQL execution time) then
 * reliably excludes: not real-world jitter, an artifact of this synthetic
 * helper reusing "now" as both the insert anchor and the query's own
 * `now()`. Real sample/evaluator-cycle phase drift is what actually
 * produces 4-6 samples in production; tightening the spacing here
 * reproduces that outcome (several samples safely inside the window)
 * without needing to race the SQL clock.
 */
async function replaceSamples(
  pool: Pool,
  projectId: string,
  resource: string,
  successCount: number,
  sampleCount: number,
  spacingMs = 60_000,
): Promise<void> {
  await pool.query(
    `DELETE FROM metrics WHERE project_id = $1 AND resource = $2 AND name = 'uptime.ok'`,
    [projectId, resource],
  );
  const rows: Array<{ value: number; at: Date }> = [];
  for (let i = 0; i < sampleCount; i += 1) {
    rows.push({ value: i < successCount ? 1 : 0, at: new Date(Date.now() - i * spacingMs) });
  }
  for (const row of rows) {
    await pool.query(
      `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
       VALUES ($1, $2, $3, NULL, 'uptime.ok', $4, 'boolean', 60)`,
      [row.at, projectId, resource, row.value],
    );
  }
}

test('uptime.ok alerting: one flapped check sends no email; two failed checks commit critical in one cycle; recovery in one cycle', async () => {
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
  const cycle = async (
    successCount: number,
    sampleCount = 5,
    spacingMs = 60_000,
  ): Promise<CommittedEvent[]> => {
    await replaceSamples(pool, seed.projectId, 'netviz', successCount, sampleCount, spacingMs);
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
    // --- (a) a single failed check among 4 passing ones: never leaves 'ok'. ---
    let events = await cycle(4); // 1/5 failed, avg=0.8 > critical 0.7
    assert.equal(events.length, 0, 'one flapped check must not commit a state change');
    assert.equal(sendMail.mock.calls.length, 0, 'and therefore must send no email');

    // --- (b) two failed checks: commits critical in the very next cycle, no confirmation cycle needed. ---
    events = await cycle(3); // 2/5 failed, avg=0.6 <= critical 0.7
    assert.equal(
      events.length,
      1,
      'consecutive_breaches=1 commits on the first cycle the candidate differs',
    );
    assert.equal(events[0]!.fromState, 'ok');
    assert.equal(events[0]!.toState, 'critical');
    assert.equal(sendMail.mock.calls.length, 1, 'commit to critical sends exactly one email');
    assert.equal(
      (sendMail.mock.calls[0]!.arguments[0] as { subject: string }).subject,
      'Metrion alert: ' + marker,
    );

    // Outage continues - candidate stays critical, matches the
    // already-committed state, so no further events and no further email
    // while it remains ongoing.
    events = await cycle(0); // 5/5 failed, avg=0
    assert.equal(events.length, 0, 'a sustained outage must not re-commit or re-notify');
    assert.equal(
      sendMail.mock.calls.length,
      1,
      'still exactly one email while the outage continues',
    );

    events = await cycle(0);
    assert.equal(events.length, 0);
    assert.equal(sendMail.mock.calls.length, 1, 'a second sustained-outage cycle changes nothing');

    // --- recovery: commits straight back to 'ok' in one cycle, no intermediate state. ---
    events = await cycle(3); // 2/5 still failed, avg=0.6: matches stored critical, no change
    assert.equal(events.length, 0, 'recovery still inside the critical bound stays critical');
    assert.equal(sendMail.mock.calls.length, 1);

    events = await cycle(4); // 1/5 failed, avg=0.8 > 0.7: ok candidate, commits immediately
    assert.equal(
      events.length,
      1,
      'recovery commits in the first cycle the candidate differs, straight from critical to ok',
    );
    assert.equal(events[0]!.fromState, 'critical');
    assert.equal(events[0]!.toState, 'ok');
    assert.equal(sendMail.mock.calls.length, 2, 'exactly one recovery email');

    events = await cycle(5); // fully recovered
    assert.equal(events.length, 0, 'a clean window after recovery must not re-notify');
    assert.equal(
      sendMail.mock.calls.length,
      2,
      'final count: one outage email, one recovery email',
    );

    // --- robustness: the one-flap-silent / two-flaps-critical boundary
    // holds regardless of how many samples actually land in the 300s
    // window (4, 5, or 6 - real cadence jitter against the evaluator's
    // cycle timing, not always exactly 5). One failure stays 'ok' at every
    // size; two failures commit 'critical' at every size, each in one
    // cycle since consecutive_breaches=1. 40s spacing (not the real 60s)
    // keeps even 6 samples (oldest at 5*40=200s) safely inside the 300s
    // window with margin to spare - avg() only reads which rows are
    // present, not their spacing (see replaceSamples' own doc comment), so
    // this does not change what the test proves.
    const JITTER_SPACING_MS = 40_000;
    for (const sampleCount of [4, 5, 6]) {
      events = await cycle(sampleCount - 1, sampleCount, JITTER_SPACING_MS); // 1 failed
      assert.equal(
        events.length,
        0,
        `one failed check out of ${sampleCount} (avg=${((sampleCount - 1) / sampleCount).toFixed(4)}) must stay ok`,
      );

      events = await cycle(sampleCount - 2, sampleCount, JITTER_SPACING_MS); // 2 failed
      assert.equal(
        events.length,
        1,
        `two failed checks out of ${sampleCount} (avg=${((sampleCount - 2) / sampleCount).toFixed(4)}) must commit critical in one cycle`,
      );
      assert.equal(events[0]!.toState, 'critical');

      // Recover before the next size's "1 failed" case re-measures ok from a clean baseline.
      events = await cycle(sampleCount, sampleCount, JITTER_SPACING_MS);
      assert.equal(events.length, 1, 'full recovery after the boundary check commits back to ok');
      assert.equal(events[0]!.toState, 'ok');
    }
  } finally {
    await pool.query(
      `DELETE FROM metrics WHERE project_id = $1 AND resource = 'netviz' AND name = 'uptime.ok'`,
      [seed.projectId],
    );
    await seed.cleanup();
    await pool.end();
  }
});
