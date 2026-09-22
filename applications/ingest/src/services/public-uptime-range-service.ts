import { ValidationError } from '../middlewares/error.js';
import { getPool } from '../lib/db.js';
import type { PublicRangeQuery } from '../schemas/public-status.schemas.js';
import { UUID_RE } from './public-status-service.js';

/**
 * `GET /api/v1/public/projects/:id/uptime/range` (ADR 0009). Same privacy
 * rules as `public-status-service.ts`: only `uptime.ok`/`uptime.latency`/
 * `uptime.idle`, only `key` + `display_name`, and `sub_resource` is never
 * selected - it carries infrastructure names.
 *
 * Read-only, as `metrion_ingest`: `uptime_samples`, `uptime_daily`,
 * `uptime_incidents`, `projects`, `applications` - all already granted.
 */

const OK = 'uptime.ok';
const LATENCY = 'uptime.latency';
const IDLE = 'uptime.idle';

/** ADR 0009 section 4: only the authoritative 60 s vantage counts; the 300 s
 * VPS rows are kept but ignored. Every reader of `uptime_samples` needs this. */
const VANTAGE_MAX_INTERVAL_S = 60;
/** The authoritative cadence; what "expected samples" is measured against. */
const EXPECTED_INTERVAL_MS = 60_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const MAX_BUCKETS = 2000;
export const MAX_INCIDENTS = 100;

/**
 * Whitelist: the granularity name picks a FIXED interval literal (passed as a
 * bind parameter, never spliced into SQL) and its width in ms. Nothing from the
 * request reaches the query as a step.
 *
 * `1h` and `6h` from ADR 0009's first draft are gone: sub-daily reads come from
 * raw `uptime_samples`, measured on production (7 monitors, 73 days of data)
 * at 171 ms warm / 1.56 s cold for 30 days at 1h for the buckets alone, plus
 * ~1 s for latency. Sub-daily is therefore capped at 7 days
 * (`SUBDAILY_MAX_MS`), where 15m already fits under `MAX_BUCKETS` - 1h and 6h
 * could never be picked.
 */
const GRANULARITIES = {
  '1m': { interval: '1 minute', ms: MINUTE_MS },
  '5m': { interval: '5 minutes', ms: 5 * MINUTE_MS },
  '15m': { interval: '15 minutes', ms: 15 * MINUTE_MS },
  '1d': { interval: '1 day', ms: DAY_MS },
} as const;
export type Granularity = keyof typeof GRANULARITIES;
const SUBDAILY: readonly Granularity[] = ['1m', '5m', '15m'];
const SUBDAILY_MAX_MS = 7 * DAY_MS;

/** Ranges that end before today are immutable, so they may be cached long. */
const TTL_LIVE_S = 60;
const TTL_PAST_S = 3600;

/** Bounds on the in-process cache. The entry count alone is not a memory
 * bound (one 24 h entry is 10k buckets, one whole-period entry a few hundred),
 * so the total bucket count is capped too: 250k buckets is roughly 40 MB. */
const CACHE_MAX_ENTRIES = 256;
const CACHE_MAX_BUCKETS = 250_000;

export interface RangeBucket {
  readonly t: string;
  readonly upPct: number | null;
  readonly samples: number;
}

export interface RangeIncident {
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationSeconds: number;
  readonly downSamples: number;
}

export interface PublicRangeApplication {
  readonly key: string;
  readonly displayName: string | null;
  readonly firstSampleAt: string;
  readonly lastSampleAt: string;
  readonly uptimePct: number | null;
  readonly coverage: number | null;
  readonly latency: {
    readonly p50: number | null;
    readonly p95: number | null;
    readonly approximate: boolean;
  };
  readonly idlePct: number | null;
  readonly buckets: RangeBucket[];
  readonly incidents: RangeIncident[];
  readonly truncated: boolean;
  readonly totalIncidents: number;
}

export interface PublicUptimeRange {
  readonly projectId: string;
  readonly generatedAt: string;
  readonly range: {
    readonly from: string;
    readonly to: string;
    readonly granularity: Granularity;
    readonly bucketCount: number;
  };
  readonly applications: PublicRangeApplication[];
}

const floorTo = (ms: number, step: number): number => Math.floor(ms / step) * step;
const startOfUtcDay = (ms: number): number => floorTo(ms, DAY_MS);
const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

/** Smallest step whose bucket count (worst case one extra for alignment) fits. */
export function pickGranularity(spanMs: number): Granularity {
  if (spanMs <= SUBDAILY_MAX_MS) {
    for (const g of SUBDAILY) {
      if (spanMs / GRANULARITIES[g].ms + 1 <= MAX_BUCKETS) return g;
    }
  }
  return '1d';
}

/** `Cache-Control` max-age for a response whose (clamped) `to` is `toMs`. */
export function rangeMaxAgeSeconds(toMs: number, nowMs: number): number {
  return toMs <= startOfUtcDay(nowMs) ? TTL_PAST_S : TTL_LIVE_S;
}

// ---- cache ---------------------------------------------------------------

interface CacheEntry {
  readonly at: number;
  readonly ttlMs: number;
  readonly result: Promise<PublicUptimeRange | null>;
  weight: number;
}

/** Map iteration order is insertion order, so the first key is the least
 * recently used one as long as hits re-insert. */
const cache = new Map<string, CacheEntry>();
let cacheWeight = 0;

function dropEntry(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cacheWeight -= entry.weight;
  cache.delete(key);
}

function evictOverBudget(): void {
  while (cache.size > CACHE_MAX_ENTRIES || cacheWeight > CACHE_MAX_BUCKETS) {
    const oldest = cache.keys().next();
    if (oldest.done) return;
    dropEntry(oldest.value);
  }
}

/** For tests: forget every cached result. */
export function clearPublicRangeCache(): void {
  cache.clear();
  cacheWeight = 0;
}

/** For tests. */
export function publicRangeCacheSize(): number {
  return cache.size;
}

// ---- entry point ---------------------------------------------------------

/**
 * `null` means "not a public project" (nonexistent, malformed id, or
 * unflagged - one path for all three, like `getPublicUptime`).
 *
 * `from`/`to` are floored to whole minutes and `to` is clamped to now, so two
 * requests naming the same range within a minute share one cache entry. `from`
 * absent is "whole period" and is part of the key as such, since what it
 * resolves to is data-dependent.
 */
export async function getPublicUptimeRange(
  projectId: string,
  query: PublicRangeQuery,
  now: Date = new Date(),
): Promise<PublicUptimeRange | null> {
  if (!UUID_RE.test(projectId)) return null;

  const nowMs = now.getTime();
  if (query.from !== undefined && query.from > nowMs) {
    throw new ValidationError([{ path: 'from', message: '`from` must not be in the future.' }]);
  }
  const toMs = floorTo(Math.min(query.to ?? nowMs, nowMs), MINUTE_MS);
  const fromMs = query.from === undefined ? null : floorTo(query.from, MINUTE_MS);
  const granularity = fromMs === null ? null : pickGranularity(toMs - fromMs);

  const key = `${projectId}|${fromMs ?? 'whole'}|${toMs}|${granularity ?? 'auto'}`;
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < hit.ttlMs) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.result;
  }
  if (hit) dropEntry(key);

  // The in-flight promise is cached, so a burst on a cold key shares one
  // computation (one pool connection) instead of each taking its own. `null`
  // (the flag can be flipped at any time) and errors are evicted at once.
  const result = computeRange(projectId, fromMs, toMs, granularity, now);
  const entry: CacheEntry = {
    at: nowMs,
    ttlMs: rangeMaxAgeSeconds(toMs, nowMs) * 1000,
    result,
    weight: 0,
  };
  cache.set(key, entry);
  evictOverBudget();
  result.then(
    (value) => {
      if (cache.get(key) !== entry) return;
      if (value === null) return dropEntry(key);
      entry.weight = value.applications.reduce((n, a) => n + a.buckets.length, 0) + 1;
      cacheWeight += entry.weight;
      evictOverBudget();
    },
    () => {
      if (cache.get(key) === entry) dropEntry(key);
    },
  );
  return result;
}

// ---- computation ---------------------------------------------------------

interface AppRow {
  key: string;
  display_name: string | null;
  first_at: Date | null;
  last_at: Date | null;
}

interface Agg {
  /** bucket start (ms) -> counts */
  buckets: Map<number, { up: number; total: number }>;
  p50: number | null;
  p95: number | null;
  idlePct: number | null;
  latencyApproximate: boolean;
}

async function computeRange(
  projectId: string,
  requestedFromMs: number | null,
  toMs: number,
  requestedGranularity: Granularity | null,
  now: Date,
): Promise<PublicUptimeRange | null> {
  const pool = getPool();
  const { rows: projectRows } = await pool.query<{ public_status_enabled: boolean }>(
    'SELECT public_status_enabled FROM projects WHERE id = $1',
    [projectId],
  );
  if (projectRows.length === 0 || !projectRows[0]!.public_status_enabled) return null;

  // Visibility and first/last sample. `uptime_daily` bounds the sample lookups
  // to one day each: without that bound the planner walked the time index
  // across every chunk (753 ms on production, 3 ms with it). Consequence: an
  // application appears once the 10-minute rollup job has seen its first day.
  // `a.public_status_visible` (finding 2, security review 2026-09-21) gates
  // this the same way `public-status-service.ts` gates its own listing - an
  // auto-registered application defaults to invisible here regardless of how
  // much history it has.
  const { rows: appRows } = await pool.query<AppRow>(
    `WITH d AS (
       SELECT resource, min(day) AS first_day, max(day) AS last_day
         FROM uptime_daily WHERE project_id = $1 GROUP BY resource)
     SELECT a.key, a.display_name,
            (SELECT min(s.time) FROM uptime_samples s
              WHERE s.project_id = a.project_id AND s.resource = a.key
                AND s.name = $2 AND s.interval_seconds <= $3
                AND s.time >= d.first_day::timestamp AT TIME ZONE 'UTC'
                AND s.time <  (d.first_day + 1)::timestamp AT TIME ZONE 'UTC') AS first_at,
            (SELECT max(s.time) FROM uptime_samples s
              WHERE s.project_id = a.project_id AND s.resource = a.key
                AND s.name = $2 AND s.interval_seconds <= $3
                AND s.time >= d.last_day::timestamp AT TIME ZONE 'UTC') AS last_at
       FROM applications a JOIN d ON d.resource = a.key
      WHERE a.project_id = $1 AND a.public_status_visible
      ORDER BY a.key`,
    [projectId, OK, VANTAGE_MAX_INTERVAL_S],
  );
  const apps = appRows.filter((r) => r.first_at !== null && r.last_at !== null);

  const earliestDayMs =
    apps.length === 0 ? null : startOfUtcDay(Math.min(...apps.map((a) => a.first_at!.getTime())));
  let fromMs = requestedFromMs ?? earliestDayMs ?? toMs;
  const granularity = requestedGranularity ?? pickGranularity(toMs - fromMs);
  const step = GRANULARITIES[granularity].ms;

  // Whole buckets: the first/last one may reach outside [from, to).
  const grid = (): { startMs: number; endMs: number; bucketCount: number } => {
    const startMs = floorTo(fromMs, step);
    // Empty range (`from` at or past `to`): no buckets.
    const endMs =
      fromMs >= toMs ? startMs : Math.max(Math.ceil(toMs / step) * step, startMs + step);
    return { startMs, endMs, bucketCount: (endMs - startMs) / step };
  };
  let { startMs, endMs, bucketCount } = grid();
  if (bucketCount > MAX_BUCKETS && earliestDayMs !== null && fromMs < earliestDayMs) {
    // Only 1d can overflow. No sample exists before the first UTC day with
    // data, so raising `from` to it drops nothing but all-null buckets.
    fromMs = earliestDayMs;
    ({ startMs, endMs, bucketCount } = grid());
  }
  if (bucketCount > MAX_BUCKETS) {
    throw new ValidationError([
      {
        path: 'from',
        message: `The range spans more than ${MAX_BUCKETS} days; pass a later \`from\`.`,
      },
    ]);
  }

  const keys = apps.map((a) => a.key);
  const aggs =
    bucketCount === 0 || keys.length === 0
      ? new Map<string, Agg>()
      : granularity === '1d'
        ? await queryDaily(projectId, keys, startMs, endMs)
        : await querySamples(projectId, keys, startMs, endMs, granularity);
  const incidents =
    bucketCount === 0 || keys.length === 0
      ? new Map<string, IncidentRows>()
      : await queryIncidents(projectId, keys, startMs, endMs);

  const nowMs = now.getTime();
  const applications = apps.map((app): PublicRangeApplication => {
    const agg = aggs.get(app.key);
    const firstMs = app.first_at!.getTime();

    const buckets: RangeBucket[] = [];
    let up = 0;
    let total = 0;
    for (let t = startMs; t < endMs; t += step) {
      const b = agg?.buckets.get(t);
      up += b?.up ?? 0;
      total += b?.total ?? 0;
      // A bucket with no samples is `null` whether it precedes the monitor's
      // first sample or is a data hole inside its span: neither is downtime.
      buckets.push({
        t: new Date(t).toISOString(),
        upPct: b && b.total > 0 ? round((b.up / b.total) * 100, 4) : null,
        samples: b?.total ?? 0,
      });
    }

    // Fraction of the checks that should exist in the monitored span of this
    // range (first sample .. now) that do. Assumes the 60 s cadence.
    const expected = (Math.min(endMs, nowMs) - Math.max(startMs, firstMs)) / EXPECTED_INTERVAL_MS;
    const inc = incidents.get(app.key);

    return {
      key: app.key,
      displayName: app.display_name,
      firstSampleAt: app.first_at!.toISOString(),
      lastSampleAt: app.last_at!.toISOString(),
      uptimePct: total > 0 ? round((up / total) * 100, 4) : null,
      coverage: expected > 0 ? round(Math.min(1, total / expected), 4) : null,
      latency: {
        p50: agg?.p50 ?? null,
        p95: agg?.p95 ?? null,
        approximate: agg?.latencyApproximate ?? false,
      },
      idlePct: agg?.idlePct ?? null,
      buckets,
      incidents: (inc?.rows ?? []).map((r) => ({
        startedAt: r.started_at.toISOString(),
        endedAt: r.ended_at === null ? null : r.ended_at.toISOString(),
        durationSeconds: Math.round(
          ((r.ended_at?.getTime() ?? nowMs) - r.started_at.getTime()) / 1000,
        ),
        downSamples: r.down_samples,
      })),
      truncated: (inc?.total ?? 0) > MAX_INCIDENTS,
      totalIncidents: inc?.total ?? 0,
    };
  });

  return {
    projectId,
    generatedAt: now.toISOString(),
    range: {
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
      granularity,
      bucketCount,
    },
    applications,
  };
}

// Sequential on purpose (see `getPublicUptime`): a cache miss holds at most
// one pool connection at a time.

interface SampleBucketRow {
  resource: string;
  t: Date;
  total: number;
  up: number;
}

interface SampleStatRow {
  resource: string;
  p50: number | null;
  p95: number | null;
  idle_total: number;
  idle_up: number;
}

/** Sub-daily: buckets and range latency/idle straight from raw samples. */
async function querySamples(
  projectId: string,
  keys: readonly string[],
  startMs: number,
  endMs: number,
  granularity: Granularity,
): Promise<Map<string, Agg>> {
  const pool = getPool();
  const from = new Date(startMs);
  const to = new Date(endMs);

  const { rows: bucketRows } = await pool.query<SampleBucketRow>(
    `SELECT resource, time_bucket($6::interval, time) AS t,
            count(*)::int AS total, (count(*) FILTER (WHERE value = 1))::int AS up
       FROM uptime_samples
      WHERE project_id = $1 AND resource = ANY($2) AND name = $3
        AND interval_seconds <= $4 AND time >= $5 AND time < $7
      GROUP BY resource, t`,
    [projectId, keys, OK, VANTAGE_MAX_INTERVAL_S, from, GRANULARITIES[granularity].interval, to],
  );
  const { rows: statRows } = await pool.query<SampleStatRow>(
    `SELECT resource,
            percentile_cont(0.5)  WITHIN GROUP (ORDER BY value) FILTER (WHERE name = $3) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY value) FILTER (WHERE name = $3) AS p95,
            (count(*) FILTER (WHERE name = $4))::int AS idle_total,
            (count(*) FILTER (WHERE name = $4 AND value = 1))::int AS idle_up
       FROM uptime_samples
      WHERE project_id = $1 AND resource = ANY($2) AND name IN ($3, $4)
        AND interval_seconds <= $5 AND time >= $6 AND time < $7
      GROUP BY resource`,
    [projectId, keys, LATENCY, IDLE, VANTAGE_MAX_INTERVAL_S, from, to],
  );

  const out = new Map<string, Agg>();
  const get = (resource: string): Agg => {
    let agg = out.get(resource);
    if (!agg) {
      agg = { buckets: new Map(), p50: null, p95: null, idlePct: null, latencyApproximate: false };
      out.set(resource, agg);
    }
    return agg;
  };
  for (const r of bucketRows)
    get(r.resource).buckets.set(r.t.getTime(), { up: r.up, total: r.total });
  for (const r of statRows) {
    const agg = get(r.resource);
    agg.p50 = r.p50 === null ? null : round(r.p50, 2);
    agg.p95 = r.p95 === null ? null : round(r.p95, 2);
    agg.idlePct = r.idle_total > 0 ? round((r.idle_up / r.idle_total) * 100, 4) : null;
  }
  return out;
}

interface DailyRow {
  resource: string;
  day: string;
  up_samples: number;
  total_samples: number;
  latency_p50: number | null;
  latency_p95: number | null;
  idle_samples: number;
}

/**
 * Daily buckets straight from `uptime_daily` (measured 0.2 ms for the whole
 * 73-day period on production). Two things the rollup cannot give exactly:
 *
 * - Range latency: percentile_cont over raw samples cost 1.5 s for 73 days, so
 *   p50/p95 are the mean of the daily percentiles weighted by each day's
 *   sample count, flagged `approximate`.
 * - `idlePct`: the rollup keeps only the count of idle=1 samples, so "never
 *   emitted uptime.idle" and "always 0" are indistinguishable; both are null.
 *
 * The current day's row is as fresh as the last 10-minute job run.
 */
async function queryDaily(
  projectId: string,
  keys: readonly string[],
  startMs: number,
  endMs: number,
): Promise<Map<string, Agg>> {
  const { rows } = await getPool().query<DailyRow>(
    `SELECT resource, day::text AS day, up_samples, total_samples,
            latency_p50, latency_p95, idle_samples
       FROM uptime_daily
      WHERE project_id = $1 AND resource = ANY($2) AND day >= $3::date AND day < $4::date`,
    [
      projectId,
      keys,
      new Date(startMs).toISOString().slice(0, 10),
      new Date(endMs).toISOString().slice(0, 10),
    ],
  );

  const out = new Map<string, Agg>();
  const sums = new Map<
    string,
    { p50: number; p95: number; w: number; idle: number; total: number }
  >();
  for (const r of rows) {
    let agg = out.get(r.resource);
    let sum = sums.get(r.resource);
    if (!agg || !sum) {
      agg = { buckets: new Map(), p50: null, p95: null, idlePct: null, latencyApproximate: true };
      sum = { p50: 0, p95: 0, w: 0, idle: 0, total: 0 };
      out.set(r.resource, agg);
      sums.set(r.resource, sum);
    }
    agg.buckets.set(Date.parse(`${r.day}T00:00:00Z`), { up: r.up_samples, total: r.total_samples });
    sum.total += r.total_samples;
    sum.idle += r.idle_samples;
    if (r.latency_p50 !== null && r.latency_p95 !== null) {
      sum.p50 += r.latency_p50 * r.total_samples;
      sum.p95 += r.latency_p95 * r.total_samples;
      sum.w += r.total_samples;
    }
  }
  for (const [resource, sum] of sums) {
    const agg = out.get(resource)!;
    if (sum.w > 0) {
      agg.p50 = round(sum.p50 / sum.w, 2);
      agg.p95 = round(sum.p95 / sum.w, 2);
    }
    if (sum.idle > 0) agg.idlePct = round((sum.idle / sum.total) * 100, 4);
  }
  return out;
}

interface IncidentRow {
  resource: string;
  started_at: Date;
  ended_at: Date | null;
  down_samples: number;
  total: number;
}
interface IncidentRows {
  rows: IncidentRow[];
  total: number;
}

/** Incidents overlapping [start, end), newest first, MAX_INCIDENTS per app. */
async function queryIncidents(
  projectId: string,
  keys: readonly string[],
  startMs: number,
  endMs: number,
): Promise<Map<string, IncidentRows>> {
  const { rows } = await getPool().query<IncidentRow>(
    `SELECT resource, started_at, ended_at, down_samples, total FROM (
       SELECT resource, started_at, ended_at, down_samples,
              (row_number() OVER (PARTITION BY resource ORDER BY started_at DESC))::int AS rn,
              (count(*) OVER (PARTITION BY resource))::int AS total
         FROM uptime_incidents
        WHERE project_id = $1 AND resource = ANY($2)
          AND started_at < $4 AND (ended_at IS NULL OR ended_at > $3)) i
      WHERE rn <= $5
      ORDER BY resource, started_at DESC`,
    [projectId, keys, new Date(startMs), new Date(endMs), MAX_INCIDENTS],
  );
  const out = new Map<string, IncidentRows>();
  for (const r of rows) {
    const entry = out.get(r.resource) ?? { rows: [], total: r.total };
    entry.rows.push(r);
    out.set(r.resource, entry);
  }
  return out;
}
