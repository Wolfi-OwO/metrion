import assert from 'node:assert/strict';
import test from 'node:test';
import { cyclePathFromMessage, worseStatus } from '../src/lib/status.ts';

test('a cycle 409 message is parsed into its path', () => {
  assert.deepEqual(
    cyclePathFromMessage('Dependency cycle detected: checkout-api -> postgres-primary -> checkout-api'),
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
