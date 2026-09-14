import { createPool } from '@metrion/db/dist/pool.js';
import type { Pool } from 'pg';

/**
 * Shared seeding for the integration tests in this package. Runs against a
 * real Postgres - `createPool()`'s local-dev default, matching
 * `docker-compose.dev.yml`, same convention `packages/db/tests/migrate.test.ts`
 * already uses. Requires `docker compose -f docker-compose.dev.yml up -d`
 * and migrations applied (`npm run migrate --workspace=packages/db`)
 * beforehand.
 */
export function testPool(): Pool {
  return createPool();
}

export interface SeededProject {
  projectId: string;
  userId: string;
  cleanup(): Promise<void>;
}

export async function seedProject(
  pool: Pool,
  marker: string,
  alertsEnabled = true,
): Promise<SeededProject> {
  const {
    rows: [user],
  } = await pool.query<{ id: string }>('INSERT INTO users (email) VALUES ($1) RETURNING id', [
    `${marker}@example.test`,
  ]);
  const {
    rows: [project],
  } = await pool.query<{ id: string }>(
    'INSERT INTO projects (owner_user_id, name, slug, alerts_enabled) VALUES ($1, $2, $3, $4) RETURNING id',
    [user!.id, marker, marker, alertsEnabled],
  );

  return {
    projectId: project!.id,
    userId: user!.id,
    async cleanup() {
      await pool.query('DELETE FROM status_events WHERE project_id = $1', [project!.id]);
      await pool.query(
        'DELETE FROM threshold_status WHERE threshold_id IN (SELECT id FROM thresholds WHERE project_id = $1)',
        [project!.id],
      );
      await pool.query('DELETE FROM thresholds WHERE project_id = $1', [project!.id]);
      await pool.query('DELETE FROM application_dependencies WHERE project_id = $1', [project!.id]);
      await pool.query('DELETE FROM applications WHERE project_id = $1', [project!.id]);
      await pool.query('DELETE FROM metrics WHERE project_id = $1', [project!.id]);
      await pool.query('DELETE FROM api_keys WHERE project_id = $1', [project!.id]);
      await pool.query('DELETE FROM projects WHERE id = $1', [project!.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [user!.id]);
    },
  };
}

export async function createApplication(
  pool: Pool,
  projectId: string,
  key: string,
  displayName: string | null = null,
): Promise<string> {
  const {
    rows: [app],
  } = await pool.query<{ id: string }>(
    'INSERT INTO applications (project_id, key, display_name) VALUES ($1, $2, $3) RETURNING id',
    [projectId, key, displayName],
  );
  return app!.id;
}

export async function addDependency(
  pool: Pool,
  projectId: string,
  dependentId: string,
  dependsOnId: string,
): Promise<void> {
  await pool.query(
    'INSERT INTO application_dependencies (project_id, dependent_id, depends_on_id) VALUES ($1, $2, $3)',
    [projectId, dependentId, dependsOnId],
  );
}

export async function createThreshold(
  pool: Pool,
  params: {
    projectId: string;
    applicationId?: string | null;
    subResource?: string | null;
    metricName: string;
    direction: 'above' | 'below';
    warningValue?: number | null;
    criticalValue?: number | null;
    consecutiveBreaches?: number;
    windowSeconds?: number;
  },
): Promise<string> {
  const {
    rows: [threshold],
  } = await pool.query<{ id: string }>(
    `INSERT INTO thresholds
       (project_id, application_id, sub_resource, metric_name, direction, warning_value, critical_value, consecutive_breaches, window_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      params.projectId,
      params.applicationId ?? null,
      params.subResource ?? null,
      params.metricName,
      params.direction,
      params.warningValue ?? null,
      params.criticalValue ?? null,
      params.consecutiveBreaches ?? 2,
      params.windowSeconds ?? 300,
    ],
  );
  return threshold!.id;
}

export async function insertMetric(
  pool: Pool,
  params: {
    projectId: string;
    resource: string;
    subResource?: string | null;
    name: string;
    value: number;
    at?: Date;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      params.at ?? new Date(),
      params.projectId,
      params.resource,
      params.subResource ?? null,
      params.name,
      params.value,
      'percent',
      60,
    ],
  );
}
