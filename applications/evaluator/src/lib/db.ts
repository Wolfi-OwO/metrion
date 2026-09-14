import { createPool } from '@metrion/db/dist/pool.js';
import type { Pool } from 'pg';

/**
 * One pool for the process, same lazy-singleton wrapper
 * `applications/ingest/src/lib/db.ts` uses - `@metrion/db` exports
 * `createPool()`, not an instance, so every consumer gets exactly one.
 */
let pool: Pool | null = null;

export function getPool(): Pool {
  pool ??= createPool();
  return pool;
}
