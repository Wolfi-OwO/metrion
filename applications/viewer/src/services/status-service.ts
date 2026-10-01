import { getPool } from '../lib/db.js';

/**
 * Reads `thresholds`, `threshold_status`, `status_events` and
 * `application_dependencies` to answer `GET .../status` and
 * `.../status/events`.
 *
 * `threshold_status`/`status_events` are populated by the evaluator - a
 * separate, later task (#22) that polls metrics every minute and writes
 * these rows. It does not exist yet, so on a fresh project this reads back
 * no rows at all: every application answers `ok` (never a fourth "no data"
 * status - the wire format only ever carries `ok`/`warning`/`critical`, `ok`
 * is the correct value for "nothing has ever evaluated this", exactly the
 * same value a genuinely healthy application would answer once the
 * evaluator exists). This is expected, not a bug - see issue #20.
 */

export type Status = 'ok' | 'warning' | 'critical';

const RANK: Record<Status, number> = { ok: 0, warning: 1, critical: 2 };

function worse(a: Status, b: Status): Status {
  return RANK[b] > RANK[a] ? b : a;
}

export interface ThresholdStatusEntry {
  readonly id: string;
  readonly metricName: string;
  readonly state: Status;
  readonly reason: 'threshold' | 'no_data';
  readonly value: number | null;
  readonly since: string;
}

export interface ApplicationStatus {
  readonly id: string;
  /** Internal grouping key for the batched callers (the projects summary);
   * `getProjectStatus` strips it so the public wire format is unchanged. */
  readonly projectId: string;
  readonly key: string;
  readonly displayName: string | null;
  readonly status: Status;
  readonly effectiveStatus: Status;
  readonly causedBy: { readonly id: string; readonly key: string } | null;
  readonly thresholds: ThresholdStatusEntry[];
  /** The single newest raw `uptime.ok` sample, independent of `status` -
   * which is the averaged/thresholded evaluator state. `null` when the
   * application has never had an `uptime.ok` sample (e.g. a host like
   * `vmi3556446` that only ever reports `cpu.*`/`memory.*`). */
  readonly lastCheck: { readonly ok: boolean; readonly at: string } | null;
}

interface ApplicationRow {
  id: string;
  project_id: string;
  key: string;
  display_name: string | null;
}

interface ThresholdStatusRow {
  application_id: string;
  threshold_id: string;
  metric_name: string;
  state: Status;
  reason: 'threshold' | 'no_data';
  value: number | null;
  since: Date;
}

interface DependencyRow {
  root_id: string;
  dep_id: string;
}

interface LastCheckRow {
  application_id: string;
  value: number;
  at: Date;
}

/**
 * Everything `GET /projects/:id/status` needs, one project (or the caller's
 * whole `projectIds` list) at a time.
 *
 * `effectiveStatus` is the worse of an application's own status and the
 * worst OWN status among everything it transitively depends on -
 * `application_dependencies`' closure computed by one recursive CTE
 * (`UNION`, not `UNION ALL`, so a row can never repeat and the recursion
 * always terminates even if a cycle somehow existed despite
 * `replaceDependencies`' own check). `causedBy` is set only when a
 * dependency's own status is STRICTLY worse than the application's own -
 * a tie means the application's own status already accounts for the
 * severity, so nothing is attributed to the dependency.
 *
 * ponytail: one CTE over the whole project's edges, O(edges) - fine at the
 * scale `packages/db/migrations/0006_applications.sql` was designed for
 * (~1k applications per project); materialise a closure table if a project
 * ever exceeds that.
 */
export async function getApplicationStatuses(
  projectIds: readonly string[],
): Promise<ApplicationStatus[]> {
  if (projectIds.length === 0) return [];
  const pool = getPool();

  const { rows: appRows } = await pool.query<ApplicationRow>(
    `SELECT id, project_id, key, display_name
       FROM applications
      WHERE project_id = ANY($1)
      ORDER BY key`,
    [projectIds],
  );
  if (appRows.length === 0) return [];

  // A threshold with a null application_id applies to every application in
  // its project (packages/db/migrations/0007's own column comment) - joined
  // in here rather than filtered out, so a project-wide threshold's state
  // counts toward every application's own status, same as one scoped to it.
  const { rows: statusRows } = await pool.query<ThresholdStatusRow>(
    `SELECT a.id AS application_id, t.id AS threshold_id, t.metric_name,
            ts.state, ts.reason, ts.value, ts.since
       FROM applications a
       JOIN thresholds t
         ON t.project_id = a.project_id AND (t.application_id = a.id OR t.application_id IS NULL)
       JOIN threshold_status ts ON ts.threshold_id = t.id
      WHERE a.project_id = ANY($1)`,
    [projectIds],
  );

  // Newest raw `uptime.ok` sample per application, served by `metrics_latest_idx`
  // (project_id, resource, name, time DESC) - the same index 0020 added for
  // `queryLatestSamples`' identical "latest per group" shape. `CROSS JOIN
  // LATERAL` rather than `LEFT JOIN LATERAL`: an application with no
  // `uptime.ok` row simply produces no row here, which is exactly `null` once
  // mapped below - no need to carry a row of nulls through.
  const { rows: lastCheckRows } = await pool.query<LastCheckRow>(
    `SELECT a.id AS application_id, latest.value, latest.time AS at
       FROM applications a
       CROSS JOIN LATERAL (
         SELECT value, time FROM metrics m
          WHERE m.project_id = a.project_id AND m.resource = a.key AND m.name = 'uptime.ok'
          ORDER BY time DESC LIMIT 1
       ) latest
      WHERE a.project_id = ANY($1)`,
    [projectIds],
  );
  const lastCheckByApp = new Map(
    lastCheckRows.map((row) => [
      row.application_id,
      { ok: row.value > 0, at: row.at.toISOString() },
    ]),
  );

  const { rows: depRows } = await pool.query<DependencyRow>(
    `WITH RECURSIVE deps AS (
       SELECT dependent_id AS root_id, depends_on_id AS dep_id
         FROM application_dependencies
        WHERE project_id = ANY($1)
       UNION
       SELECT d.root_id, ad.depends_on_id
         FROM deps d
         JOIN application_dependencies ad ON ad.dependent_id = d.dep_id AND ad.project_id = ANY($1)
     )
     SELECT root_id, dep_id FROM deps`,
    [projectIds],
  );

  const thresholdsByApp = new Map<string, ThresholdStatusEntry[]>();
  const ownStatus = new Map<string, Status>();
  for (const row of statusRows) {
    const list = thresholdsByApp.get(row.application_id);
    const entry: ThresholdStatusEntry = {
      id: row.threshold_id,
      metricName: row.metric_name,
      state: row.state,
      reason: row.reason,
      value: row.value,
      since: row.since.toISOString(),
    };
    if (list) list.push(entry);
    else thresholdsByApp.set(row.application_id, [entry]);

    ownStatus.set(row.application_id, worse(ownStatus.get(row.application_id) ?? 'ok', row.state));
  }

  const depsByApp = new Map<string, string[]>();
  for (const row of depRows) {
    const list = depsByApp.get(row.root_id);
    if (list) list.push(row.dep_id);
    else depsByApp.set(row.root_id, [row.dep_id]);
  }

  const appById = new Map(appRows.map((row) => [row.id, row]));

  return appRows.map((app) => {
    const status = ownStatus.get(app.id) ?? 'ok';
    let effectiveStatus = status;
    let causedBy: { id: string; key: string } | null = null;

    for (const depId of depsByApp.get(app.id) ?? []) {
      const depStatus = ownStatus.get(depId) ?? 'ok';
      if (RANK[depStatus] > RANK[effectiveStatus]) {
        effectiveStatus = depStatus;
        causedBy = { id: depId, key: appById.get(depId)?.key ?? depId };
      }
    }

    return {
      id: app.id,
      projectId: app.project_id,
      key: app.key,
      displayName: app.display_name,
      status,
      effectiveStatus,
      causedBy,
      thresholds: thresholdsByApp.get(app.id) ?? [],
      lastCheck: lastCheckByApp.get(app.id) ?? null,
    };
  });
}

export interface StatusEvent {
  readonly id: string;
  readonly applicationId: string | null;
  readonly thresholdId: string;
  readonly metricName: string;
  readonly fromState: string;
  readonly toState: string;
  readonly value: number | null;
  readonly at: string;
}

interface StatusEventRow {
  id: string | number;
  application_id: string | null;
  threshold_id: string;
  metric_name: string;
  from_state: string;
  to_state: string;
  value: number | null;
  at: Date;
}

/** Recent transitions, newest first, for the history panel `GET
 * .../status/events?limit=` backs. Reads `status_events` as-is - the
 * evaluator (a later task) is what appends to it. */
export async function getStatusEvents(
  projectIds: readonly string[],
  limit: number,
): Promise<StatusEvent[]> {
  if (projectIds.length === 0) return [];

  const { rows } = await getPool().query<StatusEventRow>(
    `SELECT se.id, t.application_id, se.threshold_id, t.metric_name,
            se.from_state, se.to_state, se.value, se.at
       FROM status_events se
       JOIN thresholds t ON t.id = se.threshold_id
      WHERE se.project_id = ANY($1)
      ORDER BY se.at DESC
      LIMIT $2`,
    [projectIds, limit],
  );

  return rows.map((row) => ({
    id: String(row.id),
    applicationId: row.application_id,
    thresholdId: row.threshold_id,
    metricName: row.metric_name,
    fromState: row.from_state,
    toState: row.to_state,
    value: row.value,
    at: row.at.toISOString(),
  }));
}
