import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationKeyError,
  projectNameError,
  thresholdFormErrors,
  type ThresholdFormFields,
} from '../src/lib/validate.ts';

test('an empty or whitespace-only name is rejected', () => {
  assert.ok(projectNameError('') !== null);
  assert.ok(projectNameError('   ') !== null);
});

test('a name over 200 characters is rejected', () => {
  assert.ok(projectNameError('a'.repeat(200)) === null);
  assert.ok(projectNameError('a'.repeat(201)) !== null);
});

test('an ordinary name passes', () => {
  assert.equal(projectNameError('vps-contabo-01'), null);
});

test('an application key rejects characters outside the ingest charset', () => {
  assert.ok(applicationKeyError('checkout api') !== null); // space
  assert.equal(applicationKeyError('checkout-api.v2:prod'), null);
});

function fields(overrides: Partial<ThresholdFormFields>): ThresholdFormFields {
  return {
    metricName: 'http.5xx.rate',
    direction: 'above',
    warningValue: '5',
    criticalValue: '10',
    consecutiveBreaches: '2',
    windowSeconds: '300',
    ...overrides,
  };
}

test('a below threshold with only a warning value is exactly as valid as an above one', () => {
  const below = fields({ direction: 'below', warningValue: '512', criticalValue: '' });
  assert.deepEqual(thresholdFormErrors(below), {});
});

test('neither bound set is rejected on the critical field, mirroring the server', () => {
  const errors = thresholdFormErrors(fields({ warningValue: '', criticalValue: '' }));
  assert.ok(errors.criticalValue);
});

test('an "above" threshold rejects critical below warning; "below" rejects the opposite', () => {
  assert.ok(thresholdFormErrors(fields({ warningValue: '10', criticalValue: '5' })).criticalValue);
  assert.equal(
    thresholdFormErrors(fields({ direction: 'below', warningValue: '10', criticalValue: '5' }))
      .criticalValue,
    undefined,
  );
  assert.ok(
    thresholdFormErrors(fields({ direction: 'below', warningValue: '5', criticalValue: '10' }))
      .criticalValue,
  );
});

test('window and consecutive-breach bounds match the server schema (60-86400, 1-10)', () => {
  assert.ok(thresholdFormErrors(fields({ windowSeconds: '59' })).windowSeconds);
  assert.equal(thresholdFormErrors(fields({ windowSeconds: '60' })).windowSeconds, undefined);
  assert.ok(thresholdFormErrors(fields({ consecutiveBreaches: '11' })).consecutiveBreaches);
  assert.equal(
    thresholdFormErrors(fields({ consecutiveBreaches: '1' })).consecutiveBreaches,
    undefined,
  );
});
