#!/usr/bin/env node
// Superuser tool: deletes one (project, resource)'s uptime.* history from
// `uptime_samples` and `metrics`, then rebuilds `uptime_daily`/
// `uptime_incidents` for the affected window. Exists because finding 1
// (security review of migrations 0014/0015, 2026-09-21) noted that
// `metrion_ingest` can INSERT into `uptime_samples` but never DELETE
// (`packages/db/migrations/0014_uptime_permanent_store.sql`) - a key that
// abused the ingest endpoint, or a monitor that wrote garbage, had no cleanup
// path at all. This is that path: run by a human, as the `metrion` superuser,
// never wired into any service.
//
// Usage:
//   DATABASE_URL=<superuser DSN> node scripts/purge-uptime.mjs \
//     <project_id> <resource> <from_iso> <to_iso> [--yes]
//
// DATABASE_URL MUST be the `metrion` superuser DSN. Refuses to run against
// any other role - `uptime_samples` and `metrics` have no DELETE grant for
// `metrion_app` or `metrion_ingest` by design (0014's own comment: "Ingest
// appends samples ... it never rewrites or deletes history").
//
// Defaults to a dry run: prints the row counts that WOULD be deleted and
// changes nothing. Pass --yes to actually delete and rebuild the rollup.
import pg from 'pg';

const [projectId, resource, fromIso, toIso, ...rest] = process.argv.slice(2);
const yes = rest.includes('--yes');

if (!projectId || !resource || !fromIso || !toIso) {
  console.error(
    'usage: DATABASE_URL=<superuser DSN> node scripts/purge-uptime.mjs ' +
      '<project_id> <resource> <from_iso> <to_iso> [--yes]',
  );
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set - it must be the metrion superuser DSN.');
  process.exit(2);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

async function main() {
  const { rows: roleRows } = await pool.query(
    'SELECT current_user AS role, rolsuper FROM pg_roles WHERE rolname = current_user',
  );
  if (!roleRows[0]?.rolsuper) {
    throw new Error(
      `current_user ("${roleRows[0]?.role ?? 'unknown'}") is not a superuser - refusing to run. ` +
        'uptime_samples/metrics grant no DELETE to metrion_app or metrion_ingest by design; ' +
        'DATABASE_URL must be the metrion superuser DSN.',
    );
  }

  const params = [projectId, resource, fromIso, toIso];
  const countUptime = async () =>
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM uptime_samples
          WHERE project_id = $1 AND resource = $2 AND time >= $3 AND time < $4`,
        params,
      )
    ).rows[0].n;
  // Only the uptime.* rows for this resource - `metrics` also holds
  // container/host metrics under the same (project, resource) that this tool
  // has no business touching.
  const countMetrics = async () =>
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM metrics
          WHERE project_id = $1 AND resource = $2 AND time >= $3 AND time < $4 AND name LIKE 'uptime.%'`,
        params,
      )
    ).rows[0].n;

  const uptimeBefore = await countUptime();
  const metricsBefore = await countMetrics();
  console.log(
    `project ${projectId}, resource "${resource}", [${fromIso}, ${toIso}):\n` +
      `  before: uptime_samples ${uptimeBefore}, metrics (uptime.* rows) ${metricsBefore}`,
  );

  if (!yes) {
    console.log('dry run - nothing deleted. Pass --yes to delete and rebuild the rollup.');
    return;
  }
  if (uptimeBefore === 0 && metricsBefore === 0) {
    console.log('nothing to delete.');
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const del = async (table, extra = '') =>
      (
        await client.query(
          `DELETE FROM ${table}
            WHERE project_id = $1 AND resource = $2 AND time >= $3 AND time < $4${extra}`,
          params,
        )
      ).rowCount;
    const deletedUptime = await del('uptime_samples');
    const deletedMetrics = await del('metrics', " AND name LIKE 'uptime.%'");
    await client.query('SELECT refresh_uptime_rollup($1::timestamptz, $2::timestamptz)', [
      fromIso,
      toIso,
    ]);
    await client.query('COMMIT');
    console.log(`  deleted: uptime_samples ${deletedUptime}, metrics ${deletedMetrics}`);
    console.log('  uptime_daily/uptime_incidents rebuilt for this window.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  console.log(
    `  after: uptime_samples ${await countUptime()}, metrics (uptime.* rows) ${await countMetrics()}`,
  );
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
