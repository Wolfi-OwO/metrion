import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { runMigrations } from '../dist/migrate.js';
import { createPool } from '../dist/pool.js';

/**
 * Runs against a real Postgres - `createPool()`'s local-dev default, which
 * matches `docker-compose.dev.yml` - not a mock connection. A migration
 * runner's only interesting behaviour is "applies each file once, then
 * applies nothing," and that is not something a mock can prove; it needs a
 * real `schema_migrations` table to actually be written to and read back.
 * Requires `docker compose -f docker-compose.dev.yml up -d` beforehand.
 */
test('runMigrations: applies each file once, in filename order, then applies nothing on re-run', async () => {
  const pool = createPool();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrion-db-migrate-test-'));
  const marker = `migrate_test_${Date.now()}`;

  fs.writeFileSync(
    path.join(dir, '0001_create.sql'),
    `CREATE TABLE ${marker} (id integer PRIMARY KEY);`,
  );
  fs.writeFileSync(path.join(dir, '0002_alter.sql'), `ALTER TABLE ${marker} ADD COLUMN note text;`);

  try {
    const firstRun = await runMigrations(pool, dir);
    assert.deepEqual(firstRun, ['0001_create.sql', '0002_alter.sql']);

    const secondRun = await runMigrations(pool, dir);
    assert.deepEqual(secondRun, []);

    const { rows } = await pool.query<{ column_name: string }>(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY column_name',
      [marker],
    );
    assert.deepEqual(
      rows.map((row) => row.column_name),
      ['id', 'note'],
    );
  } finally {
    await pool.query(`DROP TABLE IF EXISTS ${marker}`);
    await pool.query('DELETE FROM schema_migrations WHERE name IN ($1, $2)', [
      '0001_create.sql',
      '0002_alter.sql',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
    await pool.end();
  }
});

/**
 * Constraint-rejection tests for the applications/dependency-graph/
 * thresholds schema (migrations 0006, 0007). Each one proves a specific
 * cross-tenant or business-rule guarantee is enforced by the database
 * itself, not just by inspection of the DDL.
 *
 * Runs against the same real Postgres as the migration test above - the
 * schema already has to be at 0007 for these to mean anything, and only a
 * real database actually evaluates a composite FK or a CHECK constraint.
 */
async function seedTwoProjectsWithApps(pool: Pool) {
  const marker = `threshold_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const {
    rows: [user],
  } = await pool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `${marker}@example.test`,
  ]);

  const {
    rows: [projectA],
  } = await pool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [user.id, `${marker}-a`, `${marker}-a`],
  );
  const {
    rows: [projectB],
  } = await pool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug) VALUES ($1, $2, $3) RETURNING id',
    [user.id, `${marker}-b`, `${marker}-b`],
  );

  const {
    rows: [appA],
  } = await pool.query<{ id: string }>(
    'INSERT INTO applications (project_id, key) VALUES ($1, $2) RETURNING id',
    [projectA.id, 'app-a'],
  );
  const {
    rows: [appB],
  } = await pool.query<{ id: string }>(
    'INSERT INTO applications (project_id, key) VALUES ($1, $2) RETURNING id',
    [projectB.id, 'app-b'],
  );

  return {
    projectAId: projectA.id,
    projectBId: projectB.id,
    appAId: appA.id,
    appBId: appB.id,
    async cleanup() {
      // api_keys.project_id has no ON DELETE CASCADE (0002_accounts.sql) -
      // clear it first so the project deletes cascade through
      // applications/application_dependencies/thresholds/... cleanly.
      await pool.query('DELETE FROM api_keys WHERE project_id IN ($1, $2)', [
        projectA.id,
        projectB.id,
      ]);
      await pool.query('DELETE FROM projects WHERE id IN ($1, $2)', [projectA.id, projectB.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    },
  };
}

test('application_dependencies: a cross-project dependency edge is rejected', async () => {
  const pool = createPool();
  const seed = await seedTwoProjectsWithApps(pool);
  try {
    await assert.rejects(
      pool.query(
        'INSERT INTO application_dependencies (project_id, dependent_id, depends_on_id) VALUES ($1, $2, $3)',
        [seed.projectAId, seed.appAId, seed.appBId],
      ),
      (err: NodeJS.ErrnoException) => err.code === '23503',
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test("api_keys: a key bound to another project's application is rejected", async () => {
  const pool = createPool();
  const seed = await seedTwoProjectsWithApps(pool);
  try {
    await assert.rejects(
      pool.query(
        'INSERT INTO api_keys (project_id, key_prefix, key_hash, application_id) VALUES ($1, $2, $3, $4)',
        [seed.projectAId, `mk_test_${Date.now()}`, Buffer.from('test'), seed.appBId],
      ),
      (err: NodeJS.ErrnoException) => err.code === '23503',
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('application_dependencies: a self-edge is rejected', async () => {
  const pool = createPool();
  const seed = await seedTwoProjectsWithApps(pool);
  try {
    await assert.rejects(
      pool.query(
        'INSERT INTO application_dependencies (project_id, dependent_id, depends_on_id) VALUES ($1, $2, $2)',
        [seed.projectAId, seed.appAId],
      ),
      (err: NodeJS.ErrnoException) => err.code === '23514',
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test("thresholds: direction='above' with critical_value < warning_value is rejected", async () => {
  const pool = createPool();
  const seed = await seedTwoProjectsWithApps(pool);
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO thresholds (project_id, metric_name, direction, warning_value, critical_value)
         VALUES ($1, 'cpu_percent', 'above', 90, 50)`,
        [seed.projectAId],
      ),
      (err: NodeJS.ErrnoException) => err.code === '23514',
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});

test('thresholds: a threshold with both warning_value and critical_value null is rejected', async () => {
  const pool = createPool();
  const seed = await seedTwoProjectsWithApps(pool);
  try {
    await assert.rejects(
      pool.query(
        `INSERT INTO thresholds (project_id, metric_name, direction, warning_value, critical_value)
         VALUES ($1, 'cpu_percent', 'above', NULL, NULL)`,
        [seed.projectAId],
      ),
      (err: NodeJS.ErrnoException) => err.code === '23514',
    );
  } finally {
    await seed.cleanup();
    await pool.end();
  }
});
