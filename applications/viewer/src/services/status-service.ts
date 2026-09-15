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
  readonly key: string;
  readonly displayName: string | null;
  readonly status: Status;
  readonly effectiveStatus: Status;
  readonly causedBy: { readonly id: string; readonly key: string } | null;
  readonly thresholds: ThresholdStatusEntry[];
}

interface ApplicationRow {
  id: string;
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
    `SELECT id, key, display_name
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
      key: app.key,
      displayName: app.display_name,
      status,
      effectiveStatus,
      causedBy,
      thresholds: thresholdsByApp.get(app.id) ?? [],
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

/**
 * `GET /api/v1/public/projects/:id/uptime` - the one thing a session-less
 * caller can read, gated on `projects.public_status_enabled`
 * (`packages/db/migrations/0011_project_public_status.sql`), not on
 * ownership. Everything below reads only `uptime.ok`/`uptime.latency`
 * (organizational/uptime-sources.md's measured writers) - never `cpu.*`,
 * `memory.*`, or the project's resource inventory - and never `sub_resource`
 * either: by this project's own convention it carries infrastructure naming
 * (container names, hostnames - `applications/agent/src/lib/to-metric-
 * envelopes.ts`), so it is never selected here, let alone placed on the
 * response. A flagged project can leak nothing beyond the two metric names
 * and the application `key`s it already registered, no matter what else it
 * has stored.
 */

const UPTIME_OK_NAME = 'uptime.ok';
const UPTIME_LATENCY_NAME = 'uptime.latency';
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const H24_MS = DAY_MS;
const D7_MS = 7 * DAY_MS;
const D30_MS = 30 * DAY_MS;
const HISTORY_DAYS = 90;

/** Same shape zod's `z.uuid()` accepts. Checked before the id ever reaches a
 * query: `projects.id` is a `uuid` column, and a malformed value cast against
 * it throws a raw pg error - which `errorHandler` has no reason to know is a
 * 404, and would otherwise answer 500 for what is, to a public caller, just
 * another "not found". */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PublicUptimeHistoryEntry {
  readonly day: string;
  readonly upPct: number | null;
  readonly samples: number;
}

export interface PublicUptimeApplication {
  readonly key: string;
  readonly displayName: string | null;
  readonly uptime: {
    readonly h24: number | null;
    readonly d7: number | null;
    readonly d30: number | null;
  };
  readonly latencyMs: number | null;
  readonly lastSampleAt: string | null;
  readonly history: PublicUptimeHistoryEntry[];
}

export interface PublicUptime {
  readonly applications: PublicUptimeApplication[];
}

interface RawWindowRow {
  resource: string;
  h24_avg: number | null;
  d7_avg: number | null;
}

/** `h24`/`d7` are both within `pickSource`'s raw-table boundary (24h and
 * exactly 7 days are never "wider than 7 days"), so one query against
 * `metrics` answers both, `avg(...) FILTER (...)` per window - a null
 * average IS "no samples in that window", nothing separate to compute. */
async function queryRawWindows(
  projectId: string,
  keys: readonly string[],
  now: Date,
): Promise<Map<string, { h24: number | null; d7: number | null }>> {
  const h24Start = new Date(now.getTime() - H24_MS);
  const d7Start = new Date(now.getTime() - D7_MS);

  const { rows } = await getPool().query<RawWindowRow>(
    `SELECT resource,
            avg(value) FILTER (WHERE time >= $4) AS h24_avg,
            avg(value) AS d7_avg
       FROM metrics
      WHERE project_id = $1 AND resource = ANY($2) AND name = $3 AND time >= $5
      GROUP BY resource`,
    [projectId, keys, UPTIME_OK_NAME, h24Start, d7Start],
  );

  const byResource = new Map<string, { h24: number | null; d7: number | null }>();
  for (const row of rows) {
    byResource.set(row.resource, {
      h24: row.h24_avg === null ? null : row.h24_avg * 100,
      d7: row.d7_avg === null ? null : row.d7_avg * 100,
    });
  }
  return byResource;
}

interface HourlyWindowRow {
  resource: string;
  avg_value: number | null;
}

/** `d30` is wider than 7 days, so - same `pickSource` rule a chart range
 * follows - it reads `metrics_hourly`, recombined weighted by each hour's
 * own sample count (`metrics-service.ts#queryHourlyBuckets`'s reasoning
 * applies unchanged: a plain average of hourly averages would weight a
 * sparse hour the same as a full one). */
async function queryHourlyWindow(
  projectId: string,
  keys: readonly string[],
  start: Date,
): Promise<Map<string, number | null>> {
  const { rows } = await getPool().query<HourlyWindowRow>(
    `SELECT resource,
            sum(avg_value * sample_count) / nullif(sum(sample_count), 0) AS avg_value
       FROM metrics_hourly
      WHERE project_id = $1 AND resource = ANY($2) AND name = $3
        AND bucket >= time_bucket('1 hour', $4::timestamptz)
      GROUP BY resource`,
    [projectId, keys, UPTIME_OK_NAME, start],
  );

  const byResource = new Map<string, number | null>();
  for (const row of rows) {
    byResource.set(row.resource, row.avg_value === null ? null : row.avg_value * 100);
  }
  return byResource;
}

interface HistoryRow {
  resource: string;
  day: Date;
  avg_value: number | null;
  sample_count: number | string;
}

/**
 * One row per (resource, day) over the last 90 days, from `metrics_hourly`
 * (the same wide-range source `d30` uses - 90 days is wider still). Days with
 * no bucket at all are filled in afterwards, oldest first, `upPct: null` /
 * `samples: 0` - never a day silently missing from the 90-entry array, and
 * never a manufactured 100 for a day nothing was sampled.
 */
async function queryHistory(
  projectId: string,
  keys: readonly string[],
  start: Date,
): Promise<Map<string, Map<number, { upPct: number; samples: number }>>> {
  const { rows } = await getPool().query<HistoryRow>(
    `SELECT resource,
            time_bucket('1 day', bucket) AS day,
            sum(avg_value * sample_count) / nullif(sum(sample_count), 0) AS avg_value,
            sum(sample_count) AS sample_count
       FROM metrics_hourly
      WHERE project_id = $1 AND resource = ANY($2) AND name = $3
        AND bucket >= time_bucket('1 hour', $4::timestamptz)
      GROUP BY resource, day
      ORDER BY resource, day`,
    [projectId, keys, UPTIME_OK_NAME, start],
  );

  const byResource = new Map<string, Map<number, { upPct: number; samples: number }>>();
  for (const row of rows) {
    if (row.avg_value === null) continue;
    let byDay = byResource.get(row.resource);
    if (!byDay) {
      byDay = new Map();
      byResource.set(row.resource, byDay);
    }
    byDay.set(row.day.getTime(), { upPct: row.avg_value * 100, samples: Number(row.sample_count) });
  }
  return byResource;
}

interface LatestSampleRow {
  resource: string;
  name: string;
  value: number;
  time: Date;
}

/**
 * The newest `uptime.ok` and `uptime.latency` row per resource, no time
 * bound: `metrics`' own 90-day retention policy
 * (`packages/db/migrations/0004_rollups_and_retention.sql`) already bounds
 * how far back "newest" can reach, so a second cap here would only add a
 * second place for that number to drift from the real one.
 */
async function queryLatestSamples(
  projectId: string,
  keys: readonly string[],
): Promise<Map<string, { latencyMs: number | null; lastSampleAt: string | null }>> {
  const { rows } = await getPool().query<LatestSampleRow>(
    `SELECT DISTINCT ON (resource, name) resource, name, value, time
       FROM metrics
      WHERE project_id = $1 AND resource = ANY($2) AND name = ANY($3)
      ORDER BY resource, name, time DESC`,
    [projectId, keys, [UPTIME_OK_NAME, UPTIME_LATENCY_NAME]],
  );

  const byResource = new Map<string, { latencyMs: number | null; lastSampleAt: string | null }>();
  for (const row of rows) {
    const entry = byResource.get(row.resource) ?? {
      latencyMs: null,
      lastSampleAt: null,
    };
    if (row.name === UPTIME_OK_NAME) {
      entry.lastSampleAt = row.time.toISOString();
    } else {
      entry.latencyMs = row.value;
    }
    byResource.set(row.resource, entry);
  }
  return byResource;
}

/** UTC-midnight-aligned, so "today" is a whole bucket and the array always
 * covers exactly `HISTORY_DAYS` calendar days - the same alignment
 * `status-checker.js#buildDailyHistory` uses, for the same reason: two
 * requests a few seconds apart must not shimmer the day boundary. */
function historyStart(now: Date): number {
  const todayUtcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return todayUtcMidnight - (HISTORY_DAYS - 1) * DAY_MS;
}

/**
 * `null` (not the applications list) means "this id is not a public
 * project" - either it does not exist, or it exists with
 * `public_status_enabled = false`. Both take the exact same path (one row
 * lookup, one branch) so the two cases cost the same query and return the
 * same result to a caller with no session, rather than one being a fast
 * "not found" and the other a slower "found, but no").
 */
export async function getPublicUptime(projectId: string): Promise<PublicUptime | null> {
  if (!UUID_RE.test(projectId)) return null;

  const pool = getPool();
  const { rows: projectRows } = await pool.query<{ public_status_enabled: boolean }>(
    'SELECT public_status_enabled FROM projects WHERE id = $1',
    [projectId],
  );
  if (projectRows.length === 0 || !projectRows[0]!.public_status_enabled) return null;

  // Only keys that have ever written an `uptime.ok` sample - an application
  // with no uptime instrumentation at all (organizational/uptime-sources.md's
  // `fuwwy-platform` gap) has nothing this endpoint can show, not even a
  // "no data" row.
  const { rows: appRows } = await pool.query<{ key: string; display_name: string | null }>(
    `SELECT a.key, a.display_name
       FROM applications a
      WHERE a.project_id = $1
        AND EXISTS (
          SELECT 1 FROM metrics m
           WHERE m.project_id = a.project_id AND m.resource = a.key AND m.name = $2
        )
      ORDER BY a.key`,
    [projectId, UPTIME_OK_NAME],
  );
  if (appRows.length === 0) return { applications: [] };

  const keys = appRows.map((row) => row.key);
  const now = new Date();
  const historyStartMs = historyStart(now);

  const [windows, d30, history, latest] = await Promise.all([
    queryRawWindows(projectId, keys, now),
    queryHourlyWindow(projectId, keys, new Date(now.getTime() - D30_MS)),
    queryHistory(projectId, keys, new Date(historyStartMs)),
    queryLatestSamples(projectId, keys),
  ]);

  const applications = appRows.map((row): PublicUptimeApplication => {
    const window = windows.get(row.key);
    const byDay = history.get(row.key);
    const sample = latest.get(row.key);

    const entries: PublicUptimeHistoryEntry[] = Array.from({ length: HISTORY_DAYS }, (_, i) => {
      const dayMs = historyStartMs + i * DAY_MS;
      const bucket = byDay?.get(dayMs);
      return {
        day: new Date(dayMs).toISOString(),
        upPct: bucket?.upPct ?? null,
        samples: bucket?.samples ?? 0,
      };
    });

    return {
      key: row.key,
      displayName: row.display_name,
      uptime: {
        h24: window?.h24 ?? null,
        d7: window?.d7 ?? null,
        d30: d30.get(row.key) ?? null,
      },
      latencyMs: sample?.latencyMs ?? null,
      lastSampleAt: sample?.lastSampleAt ?? null,
      history: entries,
    };
  });

  return { applications };
}
