import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import {
  attributeRootCause,
  loadApplicationLabels,
  loadApplicationStatus,
  loadDependencyClosure,
} from '../dist/correlate.js';
import type { CommittedEvent } from '../dist/evaluate.js';
import { runEvaluationCycle } from '../dist/evaluate.js';
import { createTestTransport, sendDigests } from '../dist/mailer.js';
import {
  addDependency,
  createApplication,
  createThreshold,
  insertMetric,
  seedProject,
  testPool,
} from './seed.ts';

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
    applicationLabel: 'app-a',
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

// --- Pure: attributeRootCause, given fixtures instead of live queries. ---

test('attributeRootCause: no dependency edges recorded - every event stays its own root cause', () => {
  const events = [fakeEvent({ applicationId: 'app-a' })];
  const result = attributeRootCause(events, new Map(), new Map(), new Map());
  assert.equal(result[0]!.rootCause, true);
  assert.equal(result[0]!.causedByApplicationId, null);
});

test('attributeRootCause: a dependency currently non-ok makes the dependent not the root cause', () => {
  const events = [fakeEvent({ applicationId: 'app-a' })];
  const closure = new Map([['app-a', new Set(['app-b'])]]);
  const appStatus = new Map([['app-b', 'critical' as const]]);
  const labels = new Map([['app-b', 'Postgres Primary']]);

  const result = attributeRootCause(events, closure, appStatus, labels);
  assert.equal(result[0]!.rootCause, false);
  assert.equal(result[0]!.causedByApplicationId, 'app-b');
  assert.equal(result[0]!.causedByLabel, 'Postgres Primary');
});

test('attributeRootCause: a healthy dependency does not affect the dependent', () => {
  const events = [fakeEvent({ applicationId: 'app-a' })];
  const closure = new Map([['app-a', new Set(['app-b'])]]);
  const appStatus = new Map([['app-b', 'ok' as const]]);

  const result = attributeRootCause(events, closure, appStatus, new Map());
  assert.equal(result[0]!.rootCause, true);
});

test('attributeRootCause: a wildcard-application event (no single app to correlate) is always its own root cause', () => {
  const events = [fakeEvent({ applicationId: null })];
  const closure = new Map([['app-a', new Set(['app-b'])]]);
  const appStatus = new Map([['app-b', 'critical' as const]]);

  const result = attributeRootCause(events, closure, appStatus, new Map());
  assert.equal(result[0]!.rootCause, true);
  assert.equal(result[0]!.causedByApplicationId, null);
});

// --- Integration: a real dependency graph, real correlation, real (mock) email. ---

test('loadDependencyClosure/loadApplicationStatus + attributeRootCause: A depends on B, both critical, one email naming B', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `correlate_ab_${Date.now()}`);
  const appA = await createApplication(pool, seed.projectId, 'checkout-api', 'Checkout API');
  const appB = await createApplication(
    pool,
    seed.projectId,
    'postgres-primary',
    'Postgres Primary',
  );
  await addDependency(pool, seed.projectId, appA, appB);

  const thresholdA = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appA,
    metricName: 'error_rate',
    direction: 'above',
    criticalValue: 5,
    consecutiveBreaches: 1,
  });
  const thresholdB = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appB,
    metricName: 'connections_available',
    direction: 'below',
    criticalValue: 1,
    consecutiveBreaches: 1,
  });

  try {
    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'checkout-api',
      name: 'error_rate',
      value: 50,
    });
    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'postgres-primary',
      name: 'connections_available',
      value: 0,
    });

    const events = await runEvaluationCycle(pool);
    assert.equal(events.length, 2);

    const [closure, appStatus, labels] = await Promise.all([
      loadDependencyClosure(pool, seed.projectId),
      loadApplicationStatus(pool, seed.projectId),
      loadApplicationLabels(pool, seed.projectId),
    ]);
    const correlated = attributeRootCause(events, closure, appStatus, labels);

    const eventA = correlated.find((event) => event.thresholdId === thresholdA)!;
    const eventB = correlated.find((event) => event.thresholdId === thresholdB)!;
    assert.equal(eventA.rootCause, false);
    assert.equal(eventA.causedByApplicationId, appB);
    assert.equal(eventA.causedByLabel, 'Postgres Primary');
    assert.equal(eventB.rootCause, true);

    const transport = createTestTransport();
    const sendMail = mock.method(transport, 'sendMail');
    await sendDigests(
      pool,
      transport,
      { from: 'alerts@example.test', dailyEmailCap: 50, cooldownMinutes: 60 },
      correlated,
    );

    // Exactly one email for the whole project this cycle - A's event was
    // dropped by correlation before sendDigests ever saw it as a candidate,
    // so the digest never mentions checkout-api, only the real cause.
    assert.equal(sendMail.mock.calls.length, 1);
    const sentMail = sendMail.mock.calls[0]!.arguments[0] as { html: string };
    assert.match(sentMail.html, /Postgres Primary/);
    assert.doesNotMatch(sentMail.html, /Checkout API/);

    const notified = await pool.query(
      'SELECT count(*)::int AS n FROM status_events WHERE project_id = $1 AND notified = true',
      [seed.projectId],
    );
    assert.equal(notified.rows[0].n, 1);
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('with no dependency edges recorded, both A and B are their own root cause and both get notified', async () => {
  const pool = testPool();
  const seed = await seedProject(pool, `correlate_none_${Date.now()}`);
  const appA = await createApplication(pool, seed.projectId, 'checkout-api', 'Checkout API');
  const appB = await createApplication(
    pool,
    seed.projectId,
    'postgres-primary',
    'Postgres Primary',
  );
  // Deliberately no addDependency call - the degrade-to-no-graph case.

  const thresholdA = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appA,
    metricName: 'error_rate',
    direction: 'above',
    criticalValue: 5,
    consecutiveBreaches: 1,
  });
  const thresholdB = await createThreshold(pool, {
    projectId: seed.projectId,
    applicationId: appB,
    metricName: 'connections_available',
    direction: 'below',
    criticalValue: 1,
    consecutiveBreaches: 1,
  });

  try {
    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'checkout-api',
      name: 'error_rate',
      value: 50,
    });
    await insertMetric(pool, {
      projectId: seed.projectId,
      resource: 'postgres-primary',
      name: 'connections_available',
      value: 0,
    });

    const events = await runEvaluationCycle(pool);
    const [closure, appStatus, labels] = await Promise.all([
      loadDependencyClosure(pool, seed.projectId),
      loadApplicationStatus(pool, seed.projectId),
      loadApplicationLabels(pool, seed.projectId),
    ]);
    const correlated = attributeRootCause(events, closure, appStatus, labels);

    assert.ok(correlated.every((event) => event.rootCause));
    assert.equal(closure.size, 0);
    void thresholdA;
    void thresholdB;
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});
