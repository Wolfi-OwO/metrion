import { getPool } from '../lib/db.js';

/**
 * Two parameterised queries against `@metrion/db`'s `metrics` hypertable -
 * replacing the in-memory blob scan this file used to do. See ADR 0004: both
 * `ponytail:` markers that scan used to carry (the upgrade path for a slow
 * wide range, and for the fan-out that once ran the process out of memory)
 * are superseded, not worked around - a database query has neither failure
 * mode.
 *
 * `projectIds` is a plain parameter on every function here, never read from a
 * query string. It comes from `req.projectIds`
 * (`middlewares/project-scope.ts`), the seam issue #7's real session lookup
 * plugs into - this file does not know, and must never need to know, whether
 * that list came from a real session or a test's resolver override.
 */

/** Ranges wider than this read `metrics_hourly` instead of `metrics` directly. */
const WIDE_RANGE_MS = 7 * 24 * 60 * 60 * 1000;

export type MetricsSource = 'raw' | 'hourly';

/**
 * `metrics_hourly` is TimescaleDB's own compression boundary (`packages/db`
 * migration 0004 compresses chunks after 7 days) - past that point the raw
 * hypertable is compressed columnar storage tuned for a full-chunk scan, not
 * a point lookup, so the same 7 days is where reads switch to the
 * pre-aggregated rollup rather than the compressed raw rows.
 */
function pickSource(from: Date, to: Date): MetricsSource {
  return to.getTime() - from.getTime() > WIDE_RANGE_MS ? 'hourly' : 'raw';
}

export interface ResourceSummary {
  readonly resource: string;
  /** One entry per logical service (`service_group`), never per blue/green colour or pod. */
  readonly subResources: string[];
  /** Group -> the individual containers behind it, for the "all pods" view. */
  readonly instances: Record<string, string[]>;
  readonly metricNames: string[];
}

interface ResourceRow {
  resource: string;
  sub_resource: string | null;
  group_key: string | null;
  name: string;
}

/**
 * Distinct `resource`, `subResource` and metric names seen in the range - what
 * a chart needs to offer a picker without downloading any series first.
 *
 * Always reads the raw table: a `DISTINCT` over three columns needs actual
 * rows, and `metrics_hourly` carries no more distinct (resource, sub_resource,
 * name) tuples than `metrics` does over the same window - reading it here
 * would trade nothing for a second code path.
 */
export async function getResources(
  projectIds: readonly string[],
  from: Date,
  to: Date,
): Promise<{ resources: ResourceSummary[] }> {
  if (projectIds.length === 0) return { resources: [] };

  const { rows } = await getPool().query<ResourceRow>(
    `SELECT DISTINCT resource, sub_resource, service_group(sub_resource) AS group_key, name
       FROM metrics
      WHERE project_id = ANY($1) AND time BETWEEN $2 AND $3`,
    [projectIds, from, to],
  );

  const byResource = new Map<
    string,
    { instances: Map<string, Set<string>>; metricNames: Set<string> }
  >();
  for (const row of rows) {
    let entry = byResource.get(row.resource);
    if (!entry) {
      entry = { instances: new Map(), metricNames: new Set<string>() };
      byResource.set(row.resource, entry);
    }
    if (row.sub_resource !== null) {
      const group = row.group_key ?? row.sub_resource;
      const members = entry.instances.get(group) ?? new Set<string>();
      members.add(row.sub_resource);
      entry.instances.set(group, members);
    }
    entry.metricNames.add(row.name);
  }

  const resources = [...byResource.entries()]
    .map(([resource, entry]) => ({
      resource,
      subResources: [...entry.instances.keys()].sort(),
      instances: Object.fromEntries(
        [...entry.instances].map(([group, members]) => [group, [...members].sort()]),
      ),
      metricNames: [...entry.metricNames].sort(),
    }))
    .sort((a, b) => a.resource.localeCompare(b.resource));

  return { resources };
}

export interface SeriesBatchQuery {
  readonly projectIds: readonly string[];
  readonly resource: string;
  readonly subResource?: string | undefined;
  /** One series per container behind `subResource`'s group instead of their mean. */
  readonly perInstance?: boolean | undefined;
  readonly names: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly stepSeconds: number;
}

export interface SeriesPoint {
  /** Start of the bucket, ISO-8601 UTC. */
  readonly timestamp: string;
  /** Mean of the raw points in the bucket. */
  readonly value: number;
  /** How many raw points the mean is over - an honest 1 beats a smooth-looking lie. */
  readonly count: number;
}

export interface SeriesResult {
  readonly resource: string;
  readonly subResource?: string | undefined;
  readonly name: string;
  readonly unit: string | null;
  readonly stepSeconds: number;
  readonly points: SeriesPoint[];
}

export interface SeriesBatch {
  readonly series: SeriesResult[];
  readonly source: MetricsSource;
}

interface BucketRow {
  bucket: Date;
  name: string;
  /** The container the row came from; `null` for the host-level series. */
  sub_resource: string | null;
  avg_value: number;
  sample_count: number | string;
  unit?: string | null;
}

/** `sub_resource` is nullable, so `undefined` (host-level) has to reach pg as `null`, never as itself. */
function toSqlSubResource(subResource: string | undefined): string | null {
  return subResource ?? null;
}

async function queryRawBuckets(query: SeriesBatchQuery): Promise<BucketRow[]> {
  const { rows } = await getPool().query<BucketRow>(
    `SELECT time_bucket($1::interval, time) AS bucket,
            name,
            sub_resource,
            avg(value) AS avg_value,
            count(*)::int AS sample_count,
            min(unit) AS unit
       FROM metrics
      WHERE project_id = ANY($2)
        AND resource = $3
        AND (CASE WHEN $4::text IS NULL THEN sub_resource IS NULL
                  ELSE service_group(sub_resource) = service_group($4) END)
        AND name = ANY($5)
        AND time >= $6 AND time <= $7
      GROUP BY bucket, name, sub_resource`,
    [
      `${query.stepSeconds} seconds`,
      query.projectIds,
      query.resource,
      toSqlSubResource(query.subResource),
      query.names,
      query.from,
      query.to,
    ],
  );
  return rows;
}

/**
 * Same shape as `queryRawBuckets`, sourced from the hourly rollup. The
 * average is recombined weighted by each hour's own `sample_count` - a plain
 * average of hourly averages would silently weight a sparse hour the same as
 * a full one. Filtered from the hour containing `from`, not from `from`
 * itself: an hourly bucket's own timestamp is its start, so a strict `>=
 * from` would drop the partial hour the range actually starts inside of.
 * `unit` is not a column on `metrics_hourly` (`packages/db` migration 0004),
 * so it is fetched separately, from the raw table's newest matching row per
 * name - unit is stable metadata, not a time-series value, so "most recent"
 * is as good an answer at 30 days old as it is on the raw path.
 */
async function queryHourlyBuckets(query: SeriesBatchQuery): Promise<BucketRow[]> {
  const subResource = toSqlSubResource(query.subResource);

  const { rows } = await getPool().query<BucketRow>(
    `SELECT time_bucket($1::interval, bucket) AS bucket,
            name,
            sub_resource,
            sum(avg_value * sample_count) / sum(sample_count) AS avg_value,
            sum(sample_count)::bigint AS sample_count
       FROM metrics_hourly
      WHERE project_id = ANY($2)
        AND resource = $3
        AND (CASE WHEN $4::text IS NULL THEN sub_resource IS NULL
                  ELSE service_group(sub_resource) = service_group($4) END)
        AND name = ANY($5)
        AND bucket >= time_bucket('1 hour', $6::timestamptz)
        AND bucket <= $7
      GROUP BY time_bucket($1::interval, bucket), name, sub_resource`,
    [
      `${query.stepSeconds} seconds`,
      query.projectIds,
      query.resource,
      subResource,
      query.names,
      query.from,
      query.to,
    ],
  );

  const { rows: unitRows } = await getPool().query<{ name: string; unit: string }>(
    `SELECT DISTINCT ON (name) name, unit
       FROM metrics
      WHERE project_id = ANY($1) AND resource = $2
        AND (CASE WHEN $3::text IS NULL THEN sub_resource IS NULL
                  ELSE service_group(sub_resource) = service_group($3) END)
        AND name = ANY($4)
      ORDER BY name, time DESC`,
    [query.projectIds, query.resource, subResource, query.names],
  );
  const units = new Map(unitRows.map((row) => [row.name, row.unit]));

  return rows.map((row) => ({ ...row, unit: units.get(row.name) ?? null }));
}

function seriesKey(name: string, instance: string | null): string {
  return `${name}\u0000${instance ?? ''}`;
}

/** Per (bucket, name): mean of the per-container means, samples summed. */
function combineInstances(rows: readonly BucketRow[]): BucketRow[] {
  const merged = new Map<string, { row: BucketRow; sum: number; instances: number }>();
  for (const row of rows) {
    const key = `${row.bucket.getTime()}\u0000${row.name}`;
    const entry = merged.get(key);
    if (entry) {
      entry.sum += row.avg_value;
      entry.instances += 1;
      entry.row = {
        ...entry.row,
        sample_count: Number(entry.row.sample_count) + Number(row.sample_count),
        unit: entry.row.unit ?? row.unit,
      };
    } else {
      merged.set(key, { row: { ...row, sub_resource: null }, sum: row.avg_value, instances: 1 });
    }
  }
  return [...merged.values()].map(({ row, sum, instances }) => ({
    ...row,
    avg_value: sum / instances,
  }));
}

/**
 * One downsampled series per requested name. Buckets are aligned to the
 * epoch rather than to `from` (`time_bucket`'s own default behaviour), so two
 * requests with different start times over the same window return the same
 * bucket boundaries and a chart does not shimmer when its range slides by a
 * few seconds.
 */
export async function getSeries(query: SeriesBatchQuery): Promise<SeriesBatch> {
  if (query.projectIds.length === 0) {
    return {
      source: pickSource(query.from, query.to),
      series: query.names.map((name) => ({
        resource: query.resource,
        subResource: query.subResource,
        name,
        unit: null,
        stepSeconds: query.stepSeconds,
        points: [],
      })),
    };
  }

  const source = pickSource(query.from, query.to);
  const rows = source === 'hourly' ? await queryHourlyBuckets(query) : await queryRawBuckets(query);

  // A group with several containers (blue AND green mid-swap, or scaled pods)
  // is answered as ONE series: per bucket, the mean of each container's own
  // mean - never a sum, and a container that is not running just is not in the
  // mean. `perInstance` skips that and keeps one series per container.
  const instances = query.perInstance
    ? [...new Set(rows.map((row) => row.sub_resource))].sort()
    : [query.subResource ?? null];
  const combined = query.perInstance ? rows : combineInstances(rows);

  const byName = new Map<string, BucketRow[]>();
  for (const row of combined) {
    const key = seriesKey(row.name, query.perInstance ? row.sub_resource : null);
    const bucket = byName.get(key);
    if (bucket) bucket.push(row);
    else byName.set(key, [row]);
  }

  // Every requested name comes back even with no points, so a caller can tell
  // "nothing in this window" apart from "that metric does not exist".
  const series = query.names.flatMap((name) =>
    instances.map((instance) => {
      const bucketRows = [
        ...(byName.get(seriesKey(name, query.perInstance ? instance : null)) ?? []),
      ].sort((a, b) => a.bucket.getTime() - b.bucket.getTime());
      return {
        resource: query.resource,
        subResource: query.perInstance ? (instance ?? undefined) : query.subResource,
        name,
        unit: bucketRows.find((row) => row.unit)?.unit ?? null,
        stepSeconds: query.stepSeconds,
        points: bucketRows.map((row) => ({
          timestamp: row.bucket.toISOString(),
          value: row.avg_value,
          count: Number(row.sample_count),
        })),
      };
    }),
  );

  return { series, source };
}
