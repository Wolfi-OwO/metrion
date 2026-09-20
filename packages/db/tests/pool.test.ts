import assert from 'node:assert/strict';
import test from 'node:test';
import { createPool } from '../dist/pool.js';

// pg.Pool keeps its constructor options on `pool.options`; no connection is
// opened until a query runs, so these need no database.
test('createPool: no statement_timeout by default (migrations must never be capped)', async () => {
  const pool = createPool('postgres://x');
  assert.equal(pool.options.statement_timeout, undefined);
  await pool.end();
});

test('createPool: statementTimeoutMs opts in to statement_timeout', async () => {
  const pool = createPool('postgres://x', { statementTimeoutMs: 5000 });
  assert.equal(pool.options.statement_timeout, 5000);
  await pool.end();
});

test('createPool: non-positive statementTimeoutMs is ignored', async () => {
  const pool = createPool('postgres://x', { statementTimeoutMs: 0 });
  assert.equal(pool.options.statement_timeout, undefined);
  await pool.end();
});
