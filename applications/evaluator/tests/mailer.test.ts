import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import type { CommittedEvent } from '../dist/evaluate.js';
import {
  buildDigestEmail,
  createTestTransport,
  escapeHtml,
  sendDigests,
  stripCrLf,
} from '../dist/mailer.js';
import { createApplication, createThreshold, insertMetric, seedProject, testPool } from './seed.ts';

function fakeEvent(overrides: Partial<CommittedEvent>): CommittedEvent {
  return {
    eventId: 1,
    projectId: 'p1',
    projectName: 'Proj',
    ownerEmail: 'owner@example.test',
    alertsEnabled: true,
    thresholdId: 't1',
    subResourceKey: '',
    applicationId: 'app-a',
    applicationLabel: 'api',
    metricName: 'cpu_percent',
    fromState: 'ok',
    toState: 'critical',
    reason: 'threshold',
    value: 95,
    at: new Date(),
    rootCause: true,
    causedByApplicationId: null,
    causedByLabel: null,
    ...overrides,
  };
}

// --- Pure helpers and the email builder. ---

test('escapeHtml: escapes the five HTML-significant characters', () => {
  assert.equal(
    escapeHtml(`<script>alert("x")&'y'</script>`),
    '&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;',
  );
});

test('stripCrLf: removes CR and LF so nothing can inject a second header', () => {
  assert.equal(
    stripCrLf('my project\r\nBcc: attacker@evil.test'),
    'my project Bcc: attacker@evil.test',
  );
});

test('buildDigestEmail: subject is fixed text + project name only, CR/LF stripped, never the raw metric/app name', () => {
  const mail = buildDigestEmail({
    from: 'alerts@example.test',
    to: 'owner@example.test',
    projectName: 'My Project\r\nBcc: attacker@evil.test',
    events: [
      {
        applicationLabel: '<img src=x onerror=alert(1)>',
        metricName: 'cpu_percent',
        subResourceKey: '',
        fromState: 'ok',
        toState: 'critical',
        reason: 'threshold',
        value: 95,
      },
    ],
    suppressedUntil: null,
  });

  assert.equal(mail.subject, 'Metrion alert: My Project Bcc: attacker@evil.test');
  assert.ok(!mail.subject.includes('\n') && !mail.subject.includes('\r'));
  // The malicious application name is escaped in the body, never used verbatim.
  assert.ok(!mail.html.includes('<img src=x'));
  assert.match(mail.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('buildDigestEmail: appends a suppression notice only when suppressedUntil is set', () => {
  const base = {
    from: 'alerts@example.test',
    to: 'owner@example.test',
    projectName: 'Proj',
    events: [],
  };
  const normal = buildDigestEmail({ ...base, suppressedUntil: null });
  assert.ok(!normal.html.includes('daily alert cap'));

  const capped = buildDigestEmail({ ...base, suppressedUntil: new Date('2026-09-15T00:00:00Z') });
  assert.match(capped.html, /daily alert cap/);
  assert.match(capped.html, /2026-09-15T00:00:00\.000Z/);
});

// --- sendDigests: cooldown, daily cap, alerts_enabled - a real seeded Postgres. ---

test('sendDigests: alerts_enabled=false skips email entirely', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `mail_disabled_${Date.now()}`, false);
  try {
    const transport = createTestTransport();
    const sendMail = mock.method(transport, 'sendMail');
    await sendDigests(
      pool,
      transport,
      { from: 'alerts@example.test', dailyEmailCap: 50, cooldownMinutes: 60 },
      [
        fakeEvent({
          projectId: seed.projectId,
          projectName: seed.projectId,
          ownerEmail: 'x@example.test',
          alertsEnabled: false,
        }),
      ],
    );
    assert.equal(sendMail.mock.calls.length, 0);
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('sendDigests: a 60-minute cooldown suppresses a repeat notification for the same (threshold, state)', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `mail_cooldown_${Date.now()}`);
  const appId = await createApplication(pool, seed.projectId, 'api');
  const thresholdId = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'cpu_percent',
    direction: 'above',
    criticalValue: 90,
    consecutiveBreaches: 1,
  });
  // Simulate "already notified about critical 5 minutes ago".
  await pool.query(
    `INSERT INTO threshold_status (threshold_id, sub_resource_key, state, reason, value, breach_count, since, updated_at, last_notified_at, last_notified_state)
     VALUES ($1, '', 'critical', 'threshold', 95, 0, now(), now(), now() - interval '5 minutes', 'critical')`,
    [thresholdId],
  );

  try {
    const transport = createTestTransport();
    const sendMail = mock.method(transport, 'sendMail');
    await sendDigests(
      pool,
      transport,
      { from: 'alerts@example.test', dailyEmailCap: 50, cooldownMinutes: 60 },
      [
        fakeEvent({
          projectId: seed.projectId,
          projectName: seed.projectId,
          ownerEmail: 'owner@example.test',
          alertsEnabled: true,
          thresholdId,
          subResourceKey: '',
          toState: 'critical',
        }),
      ],
    );
    assert.equal(
      sendMail.mock.calls.length,
      0,
      'still inside the 60-minute cooldown for this (threshold, state)',
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('sendDigests: reaching the daily cap sends one suppression notice, then nothing further', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `mail_cap_${Date.now()}`);
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
    // 49 already-notified events today - one short of a cap of 50.
    for (let i = 0; i < 49; i += 1) {
      await pool.query(
        `INSERT INTO status_events (project_id, threshold_id, sub_resource_key, from_state, to_state, notified, at)
         VALUES ($1, $2, $3, 'ok', 'critical', true, now())`,
        [seed.projectId, thresholdId, `sub-${i}`],
      );
    }

    const transport = createTestTransport();
    const sendMail = mock.method(transport, 'sendMail');

    // sendDigests marks a sent event notified via a real `UPDATE status_events
    // ... WHERE id = $1`, so the fake events below need real rows to update -
    // otherwise the daily count sendDigests recomputes before its next call
    // would never actually move past 49.
    const {
      rows: [row50],
    } = await pool.query<{ id: number }>(
      `INSERT INTO status_events (project_id, threshold_id, sub_resource_key, from_state, to_state, at)
       VALUES ($1, $2, 'the-50th', 'ok', 'critical', now()) RETURNING id`,
      [seed.projectId, thresholdId],
    );
    const {
      rows: [row51],
    } = await pool.query<{ id: number }>(
      `INSERT INTO status_events (project_id, threshold_id, sub_resource_key, from_state, to_state, at)
       VALUES ($1, $2, 'the-51st', 'ok', 'critical', now()) RETURNING id`,
      [seed.projectId, thresholdId],
    );

    // The 50th notified event this day - crosses the cap, so the digest
    // that carries it also carries the suppression notice.
    await sendDigests(
      pool,
      transport,
      { from: 'alerts@example.test', dailyEmailCap: 50, cooldownMinutes: 60 },
      [
        fakeEvent({
          eventId: row50!.id,
          projectId: seed.projectId,
          projectName: seed.projectId,
          ownerEmail: 'owner@example.test',
          thresholdId,
          subResourceKey: 'the-50th',
          toState: 'critical',
        }),
      ],
    );
    assert.equal(sendMail.mock.calls.length, 1);
    const firstMail = sendMail.mock.calls[0]!.arguments[0] as { html: string };
    assert.match(firstMail.html, /daily alert cap/);

    // A further event the same day: capacity is now 0 - fully silent, no further mail.
    await sendDigests(
      pool,
      transport,
      { from: 'alerts@example.test', dailyEmailCap: 50, cooldownMinutes: 60 },
      [
        fakeEvent({
          eventId: row51!.id,
          projectId: seed.projectId,
          projectName: seed.projectId,
          ownerEmail: 'owner@example.test',
          thresholdId,
          subResourceKey: 'the-51st',
          toState: 'critical',
        }),
      ],
    );
    assert.equal(
      sendMail.mock.calls.length,
      1,
      'no further mail once the project is at its daily cap',
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('runEvaluationCycle + sendDigests end to end: consecutive_breaches cycles produce one event and one email; one cycle alone produces neither', async () => {
  const { runEvaluationCycle } = await import('../dist/evaluate.js');
  const pool = testPool();
  const seed = await seedProject(pool, `mail_e2e_${Date.now()}`);
  const appId = await createApplication(pool, seed.projectId, 'api', 'API');
  await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appId,
    metricName: 'cpu_percent',
    direction: 'above',
    criticalValue: 90,
    consecutiveBreaches: 2,
  });

  try {
    const transport = createTestTransport();
    const sendMail = mock.method(transport, 'sendMail');
    const send = async (events: CommittedEvent[]) =>
      sendDigests(
        pool,
        transport,
        { from: 'alerts@example.test', dailyEmailCap: 50, cooldownMinutes: 60 },
        events,
      );

    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'api',
      name: 'cpu_percent',
      value: 95,
    });
    let events = await runEvaluationCycle(pool);
    await send(events);
    assert.equal(events.length, 0, 'one breaching cycle alone produces no event');
    assert.equal(sendMail.mock.calls.length, 0, 'and therefore no email');

    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'api',
      name: 'cpu_percent',
      value: 96,
    });
    events = await runEvaluationCycle(pool);
    await send(events);
    assert.equal(events.length, 1, 'the consecutive_breaches-th cycle produces exactly one event');
    assert.equal(sendMail.mock.calls.length, 1, 'and exactly one email');
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});
