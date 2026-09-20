import { createPool } from '@metrion/db/dist/pool.js';
import type { Pool } from 'pg';

/**
 * One pool for the process, built lazily on first use.
 *
 * `@metrion/db` exports `createPool()`, not a pool instance, precisely so
 * every consumer gets exactly one - hand-rolling a second `pg.Pool` here
 * would be a second thing to keep sized and torn down. Lazy, not built at
 * import time: `GET /api/v1/health/liveness` must answer 200 with no
 * database connection at all, and importing `routes/index.ts` must not
 * change that - only a request that actually needs a row touches this.
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  // 10s cap: the unauthenticated public-status reads share this pool with the
  // API-key-authenticated write path, so one slow aggregate must not be able
  // to pin a connection indefinitely.
  pool ??= createPool(undefined, { statementTimeoutMs: 10_000 });
  return pool;
}
