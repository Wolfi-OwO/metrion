import assert from 'node:assert/strict';
import test from 'node:test';
import { describeActivity, sparklinePaths } from '../src/lib/sparkline.ts';

test('a rising series maps 0 to the baseline and the peak to the top pad', () => {
  const { line, max, total } = sparklinePaths([0, 5, 10], 20, 24);
  assert.equal(line, 'M0 22 L10 12 L20 2');
  assert.equal(max, 10);
  assert.equal(total, 15);
});

test('the area closes down to the bottom edge and the tail is the last segment only', () => {
  const { area, tail } = sparklinePaths([0, 5, 10], 20, 24);
  assert.equal(area, 'M0 22 L10 12 L20 2 L20 24 L0 24 Z');
  assert.equal(tail, 'M10 12 L20 2');
});

test('all zeros is a flat line on the baseline, not a divide by zero', () => {
  const { line, max } = sparklinePaths([0, 0, 0], 20, 24);
  assert.equal(line, 'M0 22 L10 22 L20 22');
  assert.equal(max, 0);
});

test('24 buckets span the full width', () => {
  const { line } = sparklinePaths(
    Array.from({ length: 24 }, (_, i) => i),
    92,
    24,
  );
  assert.ok(line.startsWith('M0 '));
  assert.ok(line.endsWith('L92 2'));
  assert.equal(line.split('L').length, 24);
});

test('empty and single-value input do not throw', () => {
  assert.equal(sparklinePaths([], 20, 24).line, '');
  assert.equal(sparklinePaths([7], 20, 24).line, 'M0 2');
});

test('the text description states total and peak, or says there is nothing', () => {
  assert.equal(describeActivity([0, 0]), 'No samples in the last 24 hours');
  assert.equal(
    describeActivity([1000, 340, 60]),
    '1,400 samples in the last 24 hours, peak 1,000 an hour',
  );
  assert.equal(describeActivity([1]), '1 sample in the last 24 hours, peak 1 an hour');
});
