import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Pool } from 'pg';

/**
 * Matches `docker-compose.dev.yml` / `@metrion/db`'s own local-dev default.
 * Requires `docker compose -f docker-compose.dev.yml up -d` beforehand, same
 * as `packages/db/tests/migrate.test.ts`.
 */
const REAL_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

// Set to an address nothing answers on, BEFORE main.ts is ever imported. This
// is what makes the liveness check inside `before()` below a real proof
// rather than an assumption: `getPool()` (lib/db.ts) is lazy, so as long as
// liveness truly touches no database, it answers 200 even though any real
// query against this URL would hang/fail.
process.env['DATABASE_URL'] = 'postgres://bogus:bogus@127.0.0.1:1/bogus';

const { app } = await import('../dist/main.js');
const { createPool } = await import('@metrion/db/dist/pool.js');

let server: Server;
let baseUrl: string;
let fixturePool: Pool;

const marker = `ingest_test_${Date.now()}`;
const ownerEmail = `${marker}@example.test`;

let projectId: string;
let otherProjectId: string;
let otherProjectResource: string;
let validPrefix: string;
let validSecret: string;
let revokedPrefix: string;
let revokedSecret: string;
let applicationId: string;
let applicationKey: string;
let applicationBoundPrefix: string;
let applicationBoundSecret: string;

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function bearer(prefix: string, secret: string): string {
  return `Bearer mtr_${prefix}_${secret}`;
}

function post(body: unknown, authorization?: string) {
  return fetch(`${baseUrl}/api/v1/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: JSON.stringify(body),
  });
}

function envelope(name: string, overrides: Record<string, unknown> = {}) {
  return {
    resource: 'vps-contabo-01',
    metrics: [
      {
        name,
        value: 12.5,
        unit: 'percent',
        intervalSeconds: 60,
        timestamp: new Date().toISOString(),
        ...overrides,
      },
    ],
  };
}

before(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // The acceptance criterion under test, not incidental setup: liveness must
  // answer 200 while DATABASE_URL still points nowhere real.
  const liveness = await fetch(`${baseUrl}/api/v1/health/liveness`);
  assert.equal(liveness.status, 200, 'liveness must not require a database connection');
  assert.deepEqual(await liveness.json(), { status: 'ok' });

  // Only now does anything in this process touch a real database - both the
  // app's own lazily-created pool (from this point on) and the fixture pool
  // seeding the rows the rest of the tests need.
  process.env['DATABASE_URL'] = REAL_DATABASE_URL;
  fixturePool = createPool(REAL_DATABASE_URL);

  const userRow = await fixturePool.query<{ id: string }>(
    'INSERT INTO users (email) VALUES ($1) RETURNING id',
    [ownerEmail],
  );
  const userId = userRow.rows[0]!.id;

  const projectRow = await fixturePool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug, default_resource) VALUES ($1, $2, $3, $4) RETURNING id',
    [userId, marker, marker, 'vps-test-01'],
  );
  projectId = projectRow.rows[0]!.id;

  // A second, unrelated project whose `default_resource` is used as the
  // `resource` value in the "cross-project resource" test below - it must
  // never cause a row to land under this project's id.
  const otherProjectRow = await fixturePool.query<{ id: string; default_resource: string }>(
    'INSERT INTO projects (owner_user_id, name, slug, default_resource) VALUES ($1, $2, $3, $4) RETURNING id, default_resource',
    [userId, `${marker}-other`, `${marker}-other`, 'someone-elses-host'],
  );
  otherProjectId = otherProjectRow.rows[0]!.id;
  otherProjectResource = otherProjectRow.rows[0]!.default_resource;

  // `key_prefix` must contain no underscore: the `mtr_<prefix>_<secret>`
  // parser (`middlewares/api-key.ts`) splits on the FIRST underscore to find
  // the prefix boundary, exactly because a real prefix is a short opaque id
  // with no internal structure - `marker` itself has underscores, so it is
  // stripped of them here rather than used as-is.
  const noUnderscoreMarker = marker.replace(/_/g, '');
  validPrefix = `${noUnderscoreMarker}v`;
  validSecret = randomBytes(24).toString('hex');
  await fixturePool.query(
    'INSERT INTO api_keys (project_id, key_prefix, key_hash) VALUES ($1, $2, $3)',
    [projectId, validPrefix, hashSecret(validSecret)],
  );

  revokedPrefix = `${noUnderscoreMarker}r`;
  revokedSecret = randomBytes(24).toString('hex');
  await fixturePool.query(
    'INSERT INTO api_keys (project_id, key_prefix, key_hash, revoked_at) VALUES ($1, $2, $3, now())',
    [projectId, revokedPrefix, hashSecret(revokedSecret)],
  );

  applicationKey = `${marker}-app`;
  const applicationRow = await fixturePool.query<{ id: string }>(
    'INSERT INTO applications (project_id, key) VALUES ($1, $2) RETURNING id',
    [projectId, applicationKey],
  );
  applicationId = applicationRow.rows[0]!.id;

  applicationBoundPrefix = `${noUnderscoreMarker}a`;
  applicationBoundSecret = randomBytes(24).toString('hex');
  await fixturePool.query(
    'INSERT INTO api_keys (project_id, key_prefix, key_hash, application_id) VALUES ($1, $2, $3, $4)',
    [projectId, applicationBoundPrefix, hashSecret(applicationBoundSecret), applicationId],
  );
});

after(async () => {
  await fixturePool.query('DELETE FROM metrics WHERE project_id = $1', [projectId]);
  await fixturePool.query('DELETE FROM api_keys WHERE project_id = $1', [projectId]);
  await fixturePool.query(
    'DELETE FROM projects WHERE owner_user_id = (SELECT id FROM users WHERE email = $1)',
    [ownerEmail],
  );
  await fixturePool.query('DELETE FROM users WHERE email = $1', [ownerEmail]);
  await fixturePool.end();
  await new Promise((resolve) => server.close(resolve));
});

test('POST /api/v1/ingest: an unknown API key is 401', async () => {
  const response = await post(envelope('auth.unknown'), bearer('doesnotexist', 'whatever'));
  assert.equal(response.status, 401);

  const noHeader = await post(envelope('auth.missing'));
  assert.equal(noHeader.status, 401);

  const malformed = await post(envelope('auth.malformed'), 'Bearer not-the-right-shape');
  assert.equal(malformed.status, 401);
});

test('POST /api/v1/ingest: a revoked API key is 401', async () => {
  const response = await post(envelope('auth.revoked'), bearer(revokedPrefix, revokedSecret));
  assert.equal(response.status, 401);
});

test("POST /api/v1/ingest: the enveloped shape is 202 and the row lands under the key's project", async () => {
  const response = await post(envelope('shape.envelope'), bearer(validPrefix, validSecret));
  assert.equal(response.status, 202);
  const body = (await response.json()) as { accepted: number; points: number };
  assert.equal(body.accepted, 1);
  assert.equal(body.points, 1);

  const { rows } = await fixturePool.query(
    'SELECT project_id, resource, name, value, unit, interval_seconds FROM metrics WHERE project_id = $1 AND name = $2',
    [projectId, 'shape.envelope'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_id, projectId);
  assert.equal(rows[0].resource, 'vps-contabo-01');
  assert.equal(Number(rows[0].value), 12.5);
  assert.equal(rows[0].interval_seconds, 60);
});

test('POST /api/v1/ingest: an array of envelopes is 202', async () => {
  const response = await post(
    [envelope('shape.array.1'), envelope('shape.array.2')],
    bearer(validPrefix, validSecret),
  );
  assert.equal(response.status, 202);
  const body = (await response.json()) as { accepted: number; points: number };
  assert.equal(body.accepted, 2);
  assert.equal(body.points, 2);
});

test('POST /api/v1/ingest: a bare array of metric points is 202, falls back to default_resource, and accepts "interval"', async () => {
  const response = await post(
    [
      {
        name: 'shape.bare',
        value: 42,
        unit: 'percent',
        interval: 60,
        timestamp: new Date().toISOString(),
      },
    ],
    bearer(validPrefix, validSecret),
  );
  assert.equal(response.status, 202);

  const { rows } = await fixturePool.query(
    'SELECT resource, interval_seconds FROM metrics WHERE project_id = $1 AND name = $2',
    [projectId, 'shape.bare'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].resource, 'vps-test-01', "must fall back to the project's default_resource");
  assert.equal(rows[0].interval_seconds, 60, '"interval" must alias intervalSeconds');
});

test("POST /api/v1/ingest: a resource naming another project still writes under the key's own project_id", async () => {
  // `resource` set to the OTHER project's own default_resource - the body
  // controls `resource` freely, it must never control `project_id`.
  const crossProjectBody = {
    resource: otherProjectResource,
    metrics: envelope('shape.cross-project').metrics,
  };
  const crossResponse = await post(crossProjectBody, bearer(validPrefix, validSecret));
  assert.equal(crossResponse.status, 202);

  const { rows } = await fixturePool.query(
    'SELECT project_id, resource FROM metrics WHERE project_id = $1 AND name = $2 AND resource = $3',
    [projectId, 'shape.cross-project', otherProjectResource],
  );
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0].project_id,
    projectId,
    "the row must be attributed to the KEY's project, not the project the resource string names",
  );
});

test("POST /api/v1/ingest: an application-bound key forces resource to the application's key, ignoring the body", async () => {
  const response = await post(
    envelope('shape.application-bound', { name: 'shape.application-bound' }),
    bearer(applicationBoundPrefix, applicationBoundSecret),
  );
  assert.equal(response.status, 202);

  const { rows } = await fixturePool.query(
    'SELECT project_id, resource FROM metrics WHERE project_id = $1 AND name = $2',
    [projectId, 'shape.application-bound'],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].project_id, projectId);
  assert.equal(
    rows[0].resource,
    applicationKey,
    'an application-bound key must force resource to the application\'s own key, not the body\'s "vps-contabo-01"',
  );
});

test('POST /api/v1/ingest: an unseen resource auto-registers exactly one applications row, a repeat creates none', async () => {
  const resource = `${marker}-autoreg`;

  const countRows = async () =>
    (
      await fixturePool.query('SELECT 1 FROM applications WHERE project_id = $1 AND key = $2', [
        projectId,
        resource,
      ])
    ).rowCount;

  assert.equal(await countRows(), 0, 'must not already exist before the first request');

  const first = await post(
    { resource, metrics: envelope('shape.autoreg.1').metrics },
    bearer(validPrefix, validSecret),
  );
  assert.equal(first.status, 202);
  assert.equal(
    await countRows(),
    1,
    'the first request for an unseen resource must create one row',
  );

  const second = await post(
    { resource, metrics: envelope('shape.autoreg.2').metrics },
    bearer(validPrefix, validSecret),
  );
  assert.equal(second.status, 202);
  assert.equal(
    await countRows(),
    1,
    'a repeat request for the same resource must create no new row',
  );
});

test("a key bound to another project's application is rejected by the database", async () => {
  await assert.rejects(
    fixturePool.query(
      'INSERT INTO api_keys (project_id, key_prefix, key_hash, application_id) VALUES ($1, $2, $3, $4)',
      [
        otherProjectId,
        `${marker.replace(/_/g, '')}x`,
        hashSecret(randomBytes(24).toString('hex')),
        applicationId,
      ],
    ),
    /foreign key|violat/i,
    "a key whose project_id does not match its bound application's project_id must be rejected by the composite FK, not accepted",
  );
});

test('POST /api/v1/ingest: a timestamp 48 hours old is 400', async () => {
  const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const response = await post(
    envelope('shape.ancient', { timestamp: ancient }),
    bearer(validPrefix, validSecret),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { issues: { path: string; message: string }[] };
  assert.ok(
    body.issues.some((issue) => issue.path.endsWith('timestamp')),
    `expected an issue naming "timestamp", got ${JSON.stringify(body.issues)}`,
  );
});
