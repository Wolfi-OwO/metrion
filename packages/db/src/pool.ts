import { Pool } from 'pg';

// Matches the `db` service credentials in docker-compose.dev.yml exactly -
// the fallback for local dev only, so `npm run migrate` works against a
// freshly `docker compose up`'d container with no separate .env step.
// Production always sets a real DATABASE_URL.
const LOCAL_DEV_DATABASE_URL = 'postgres://metrion:metrion@localhost:5432/metrion';

/**
 * One pool for the process. `pg.Pool` already does connection reuse and
 * queueing - wrapping it in anything more is the "config for a value that
 * never changes" ladder rung. Everything else (pool size, timeouts) is a
 * `pg` default until a real workload proves a default wrong.
 */
export function createPool(
  connectionString = process.env['DATABASE_URL'] ?? LOCAL_DEV_DATABASE_URL,
  options: { statementTimeoutMs?: number } = {},
): Pool {
  // The server-side statement cap is opt-in per consumer, never a default:
  // this factory is shared by the migration runner, which runs long DDL and
  // backfills (index builds, compression, continuous aggregates WITH DATA)
  // on the metrics hypertable and must never be killed mid-statement, and by
  // the viewer/evaluator, whose aggregate queries have no decided cap. pg has
  // no default timeout, so leaving it unset keeps that behaviour.
  const { statementTimeoutMs } = options;
  return new Pool({
    connectionString,
    ...(statementTimeoutMs && statementTimeoutMs > 0
      ? { statement_timeout: statementTimeoutMs }
      : {}),
  });
}
