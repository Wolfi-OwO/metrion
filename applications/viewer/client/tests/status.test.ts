import assert from 'node:assert/strict';
import test from 'node:test';
import { cyclePathFromMessage, summariseApplications, worseStatus } from '../src/lib/status.ts';

test('a cycle 409 message is parsed into its path', () => {
  assert.deepEqual(
    cyclePathFromMessage(
      'Dependency cycle detected: checkout-api -> postgres-primary -> checkout-api',
    ),
    ['checkout-api', 'postgres-primary', 'checkout-api'],
  );
});

test('a non-cycle message is not mistaken for one', () => {
  assert.equal(cyclePathFromMessage('Application not found.'), null);
});

test('worseStatus ranks critical > warning > ok, matching the server', () => {
  assert.equal(worseStatus('ok', 'warning'), 'warning');
  assert.equal(worseStatus('critical', 'warning'), 'critical');
  assert.equal(worseStatus('ok', 'ok'), 'ok');
});

test('summariseApplications names the root cause and counts what it drags down', () => {
  const app = (
    key: string,
    status: 'ok' | 'warning' | 'critical',
    effectiveStatus: 'ok' | 'warning' | 'critical',
    causedBy: { id: string; key: string } | null,
  ) => ({
    id: key,
    key,
    displayName: null,
    status,
    effectiveStatus,
    causedBy,
    thresholds: [],
    lastCheck: null,
  });
  const summary = summariseApplications([
    app('postgres', 'critical', 'critical', null),
    app('auth', 'ok', 'critical', { id: 'postgres', key: 'postgres' }),
    app('web', 'ok', 'warning', { id: 'postgres', key: 'postgres' }),
    app('redis', 'ok', 'ok', null),
  ]);
  assert.equal(summary.worst, 'critical');
  assert.equal(summary.headline, 'postgres');
  assert.equal(summary.detail, '2 downstream affected');
  assert.deepEqual(summary.counts, { ok: 1, warning: 1, critical: 2 });
});

test('summariseApplications on a healthy project says so', () => {
  const summary = summariseApplications([
    {
      id: 'a',
      key: 'a',
      displayName: null,
      status: 'ok',
      effectiveStatus: 'ok',
      causedBy: null,
      thresholds: [],
      lastCheck: null,
    },
  ]);
  assert.equal(summary.headline, '1 application healthy');
  assert.equal(summary.detail, null);
});
