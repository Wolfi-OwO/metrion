import { getPool } from '../lib/db.js';
import { getApplicationStatuses, type Status } from './status-service.js';

export interface ProjectSummary {
  projectId: string;
  applicationCount: number;
  status: { critical: number; warning: number; ok: number; unknown: number };
  worst: Status | 'unknown';
  lastSampleAt: string | null;
  activity24h: number[];
}

const HOUR_MS = 3_600_000;
const BUCKETS = 24;
const LAST_SAMPLE_WINDOW = '30 days';

/**
 * One row per owned project for the dashboard list, in a constant number of
 * queries (3 status + 1 activity + 1 last-sample = 5 at most, however many
 * projects): everything is batched on `project_id = ANY($1)`, and ownership
 * is enforced solely by the caller-supplied, session-derived `projectIds`.
 *
 * Status counts reuse `getApplicationStatuses`, so they are the Status
 * screen's dependency-folded `effectiveStatus`. That service never emits a
 * fourth "no data" state (an application nothing has evaluated is `ok`), so
 * `unknown` stays in the shape for the client but is 0 today; `worst` is
 * `unknown` only for a project with no applications.
 *
 * `activity24h` counts every raw `metrics` row regardless of name. Buckets
 * are the 24 whole UTC hours ending with the current one, oldest first; the
 * oldest is a full hour, not a partial 24h-ago slice. Bucket indexes are
 * epoch-hours computed in SQL and JS alike, so DB session time zone cannot
 * shift them.
 */
export async function getProjectsSummary(projectIds: readonly string[]): Promise<ProjectSummary[]> {
  if (projectIds.length === 0) return [];
  const pool = getPool();

  const currentHour = Math.floor(Date.now() / HOUR_MS);
  const firstHour = currentHour - (BUCKETS - 1);

  const [statuses, activity, lastSamples] = await Promise.all([
    getApplicationStatuses(projectIds),
    pool.query<{ project_id: string; hour: string; n: string }>(
      `SELECT project_id, floor(extract(epoch FROM time) / 3600)::bigint AS hour, count(*) AS n
         FROM metrics
        WHERE project_id = ANY($1) AND time >= to_timestamp($2::bigint * 3600)
        GROUP BY project_id, hour`,
      [projectIds, firstHour],
    ),
    // A per-project subselect walks (project_id, time DESC) for one row,
    // where a GROUP BY max() over 30 days would read every sample in it.
    pool.query<{ project_id: string; last_at: Date | null }>(
      `SELECT p.id AS project_id,
              (SELECT max(m.time) FROM metrics m
                WHERE m.project_id = p.id AND m.time >= now() - $2::interval) AS last_at
         FROM unnest($1::uuid[]) AS p(id)`,
      [projectIds, LAST_SAMPLE_WINDOW],
    ),
  ]);

  const summaries = new Map<string, ProjectSummary>();
  for (const id of projectIds) {
    summaries.set(id, {
      projectId: id,
      applicationCount: 0,
      status: { critical: 0, warning: 0, ok: 0, unknown: 0 },
      worst: 'unknown',
      lastSampleAt: null,
      activity24h: new Array<number>(BUCKETS).fill(0),
    });
  }

  for (const app of statuses) {
    const summary = summaries.get(app.projectId);
    if (!summary) continue;
    summary.status[app.effectiveStatus] += 1;
  }
  for (const summary of summaries.values()) {
    const { critical, warning, ok } = summary.status;
    const count = critical + warning + ok;
    summary.applicationCount = count;
    summary.worst =
      critical > 0 ? 'critical' : warning > 0 ? 'warning' : count > 0 ? 'ok' : 'unknown';
  }

  for (const row of activity.rows) {
    const index = Number(row.hour) - firstHour;
    // A sample stamped after "now" (clock skew) falls outside the 24 slots.
    if (index >= 0 && index < BUCKETS)
      summaries.get(row.project_id)!.activity24h[index] = Number(row.n);
  }
  for (const row of lastSamples.rows) {
    summaries.get(row.project_id)!.lastSampleAt = row.last_at?.toISOString() ?? null;
  }

  return [...summaries.values()];
}
