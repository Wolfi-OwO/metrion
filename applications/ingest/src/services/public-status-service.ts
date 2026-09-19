import { getPool } from '../lib/db.js';

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
 *
 * Ported verbatim from `applications/viewer/src/services/status-service.ts`
 * (lines 235-531 at the time of the port) - this service now owns the public
 * uptime endpoint; the viewer's copy stays live until a later cutover task
 * removes it. Only the two `pickSource` references below were rewritten,
 * since that function now lives in a different service.
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

/** `h24`/`d7` are both within `applications/viewer/src/services/metrics-
 * service.ts#pickSource`'s raw-table boundary (24h and exactly 7 days are
 * never "wider than 7 days"), so one query against `metrics` answers both,
 * `avg(...) FILTER (...)` per window - a null average IS "no samples in that
 * window", nothing separate to compute. */
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

/** `d30` is wider than 7 days, so - same `applications/viewer/src/services/
 * metrics-service.ts#pickSource` rule a chart range follows - it reads
 * `metrics_hourly`, recombined weighted by each hour's own sample count
 * (`metrics-service.ts#queryHourlyBuckets`'s reasoning applies unchanged: a
 * plain average of hourly averages would weight a sparse hour the same as a
 * full one). */
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
