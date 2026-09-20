import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAxisValue, niceAxis } from '../src/lib/format.ts';

test('a bytes/s axis steps in round binary units, not thirds of the maximum', () => {
  // 24.3 MiB/s peak used to give ticks 8.1M / 16.2M / 24.3M.
  const { max, ticks } = niceAxis('bytes/s', 24.3 * 1024 * 1024);
  const inMiB = ticks.map((tick) => tick / 1024 / 1024);
  assert.deepEqual(inMiB, [0, 10, 20, 30]);
  assert.equal(max, 30 * 1024 * 1024);
});

test('percent stays pinned to 0-100 with quarter landmarks', () => {
  assert.deepEqual(niceAxis('percent', 83), { max: 100, ticks: [0, 25, 50, 75, 100] });
});

test('a plain count axis lands on 1-2-5 steps', () => {
  const { ticks } = niceAxis('count', 4.8);
  assert.deepEqual(ticks, [0, 2, 4, 6]);
});

test('an empty or non-positive maximum still yields a usable axis', () => {
  assert.deepEqual(niceAxis('count', 0), { max: 1, ticks: [0, 1] });
});

test('axis labels carry the binary suffix for bytes', () => {
  assert.equal(formatAxisValue(8 * 1024 * 1024, 'bytes/s'), '8 MiB');
});
