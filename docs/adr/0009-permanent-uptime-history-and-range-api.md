# ADR 0009: Permanent uptime history, and the range API it serves

## Status

Accepted, 2026-09-21. Supersedes in part ADR 0007 (its "uptime lives only in
`metrics`, retained 90 days" consequence).

## Context

The portfolio's MongoDB `monitorchecks` collection holds the only long uptime
history (earliest 2026-07-11, 413,203 checks at 1-minute cadence) and it has a
90-day TTL: it starts erasing that history on 2026-10-09. Metrion's own
`metrics` hypertable cannot take over as the archive:

- Retention is per hypertable (`add_retention_policy('metrics', '90 days')`,
  migration 0004). It cannot spare `uptime.*` while dropping `container.*`,
  which is 85% of the rows.
- Measured on production: 426 B/row. Uptime at 1-minute cadence for seven
  monitors is 2 metrics x 7 x 525,600 = about 7.4 M rows/year, roughly
  3.1 GB/year uncompressed. With compression (segmentby project/resource/
  name) an estimate of about 0.3 GB/year; only the 426 B/row is measured.
- A continuous aggregate does not help: refreshing one over a window whose raw
  chunks were dropped materialises empty buckets. So the permanent store is
  raw samples plus plain rollup tables, not a continuous aggregate.
- The evaluator app (thresholds, `status_events`) is not deployed, so nothing
  else derives long-lived history.

## Decision

### 1. Resource keys and metric names

One resource key per monitor; `sub_resource` is never used for uptime.

| Monitor (Mongo name)        | `resource`              |
| --------------------------- | ----------------------- |
| Network Visualizer          | `netviz`                |
| Machine Learning Visualizer | `ml-visualizer` (ARM)   |
| ML Visualizer (Preview)     | `ml-visualizer-preview` |
| Portfolio                   | `portfolio`             |
| Status Page                 | `status-page`           |
| Preussen Web                | `preussen`              |
| nutrilens                   | `nutrilens`             |

Metrics (project `86b02c8c-4357-4655-9835-1897787cdd9a`):

- `uptime.ok`: 1 or 0, unit `boolean`.
- `uptime.latency`: milliseconds, unit `ms`. Not written when the monitor is
  ARM-checked (`runningStatus` set): a control-plane call has no meaningful
  latency.
- `uptime.idle`: ARM monitors only, 1 when `runningStatus === 'ScaledToZero'`
  else 0, unit `boolean`.

The authoritative cadence is `intervalSeconds: 60` from the external Azure
checker.

### 2. Dual write, `uptime_samples` has no retention

Ingest writes every point whose name starts with `uptime.` to `metrics`
(unchanged, 90 days, so the viewer's metric screens and future thresholds keep
working) and additionally to `uptime_samples`, in the same transaction, with
`ON CONFLICT DO NOTHING` (idempotent retries and backfills).

`uptime_samples` (migration 0014): `time timestamptz, project_id uuid,
resource text, name text, value double precision, unit text,
interval_seconds integer`, all NOT NULL; hypertable on `time`; index
`(project_id, resource, name, time DESC)`; UNIQUE `(project_id, resource,
name, time)`; compression after 7 days, segmentby `project_id, resource,
name`; NO retention policy. `metrion_ingest` may INSERT and SELECT, never
UPDATE or DELETE; `metrion_app` may SELECT.

### 3. Plain rollup tables, maintained by a database job

`uptime_daily(project_id, resource, day date, up_samples, total_samples,
down_ms, latency_p50, latency_p95, latency_avg, latency_max, idle_samples)`,
PK `(project_id, resource, day)`; and `uptime_incidents(id, project_id,
resource, started_at, ended_at NULL, down_samples)`, UNIQUE `(project_id,
resource, started_at)`. Both are ordinary tables. They are maintained by
`refresh_uptime_rollup(p_from, p_to)` (migration 0015), scheduled as a
TimescaleDB user-defined action job every 10 minutes: no extra process. It
never deletes from `uptime_samples`. Full rebuild:
`SELECT refresh_uptime_rollup('2026-07-11', now())`.

A day with zero samples has no `uptime_daily` row, so "before monitoring
started" stays null and is never rendered as 100%. An incident is a run of
`uptime.ok = 0`; consecutive samples further apart than 2.5x their interval
break the run, so a data hole is not an incident. An open run has
`ended_at NULL`.

### 4. Vantage rule

The Azure Function (60 s) is the authoritative uptime vantage. The VPS checker
(`vps-uptime-checker.timer`, 300 s, running on the VPS it monitors) will be
retired. Both write `uptime.*` through ingest, so `uptime_samples` also holds
300 s rows. Rollups and endpoints consider ONLY `interval_seconds <= 60`; the
300 s rows are kept but ignored ("VPS vantage, historical"). Every reader of
`uptime_samples` must apply the same predicate.

### 5. Range API contract

Implemented in `applications/ingest` (`services/public-uptime-range-service.ts`).

`GET /api/v1/public/projects/:id/uptime/range?from=&to=`

Access: unauthenticated, same `projects.public_status_enabled` gate, UUID
pre-check, 404 body and shared rate limiter (`publicStatusRateLimiter`) as the
existing `/uptime` route, which is unchanged. Read-only SELECTs as
`metrion_ingest` on tables it already may read; no new grants.

Parameters:

- `from`, `to`: ISO-8601 with `Z`/offset, or a bare date. A bare `from` is
  00:00:00Z of that day; a bare `to` is the END of that UTC day, inclusive
  (`to=2026-08-31` covers all of 08-31; internally ranges are half-open,
  `[from, to)`, and `range.to` reports the exclusive end).
- `from` before 2000-01-01, `from >= to`, a malformed value, or `from` in the
  future is a 400 with `issues`. `to` later than now is clamped to now, not an
  error. Both are floored to whole minutes. Unknown query parameters are
  ignored, as on the sibling route.
- `from` absent: the first UTC day with data across the project's public
  applications ("whole period"). `to` absent: now.

Granularity: the smallest of `1m`, `5m`, `15m`, `1d` whose bucket count is at
most 2000, where sub-daily steps are only used for ranges up to 7 days (longer
is always `1d`). The chosen value is returned in `range.granularity`.
`1h` and `6h` from the first draft were dropped: sub-daily reads raw
`uptime_samples`, and measured on production (7 monitors, 73 days) 30 days at
1h cost 171 ms warm and 1.56 s cold for the buckets alone, with ~1 s more for
range latency. At 7 days the cost is 65 ms warm / 242 ms cold (buckets) plus
78 / 115 ms (latency and idle), and 15m is already under the cap there, so 1h
and 6h could never be selected. A `1d` range reads `uptime_daily` only (0.1 ms
for the whole 73-day period). If the range would exceed 2000 daily buckets,
`from` is raised to the first day with data; if it still does, 400.

Buckets are aligned to UTC and whole: the first and last bucket may reach
outside `[from, to)`, and the last one covers up to now. Bucketing is
`time_bucket` on a fixed interval taken from a whitelist by granularity name
and passed as a bind parameter.

Response:

```json
{
  "projectId": "86b02c8c-4357-4655-9835-1897787cdd9a",
  "generatedAt": "2026-09-21T20:00:00.000Z",
  "range": {
    "from": "2026-07-11T00:00:00.000Z",
    "to": "2026-09-21T20:00:00.000Z",
    "granularity": "1d",
    "bucketCount": 73
  },
  "applications": [
    {
      "key": "netviz",
      "displayName": "Network Visualizer",
      "firstSampleAt": "2026-07-11T18:30:00.894Z",
      "lastSampleAt": "2026-09-21T19:32:00.755Z",
      "uptimePct": 99.93,
      "coverage": 0.9987,
      "latency": { "p50": 41, "p95": 118, "approximate": true },
      "idlePct": null,
      "buckets": [{ "t": "2026-07-11T00:00:00.000Z", "upPct": 100, "samples": 330 }],
      "incidents": [
        {
          "startedAt": "2026-08-05T10:00:00.000Z",
          "endedAt": "2026-08-05T10:05:00.000Z",
          "durationSeconds": 300,
          "downSamples": 5
        }
      ],
      "truncated": false,
      "totalIncidents": 1
    }
  ]
}
```

- Applications: those of the project with at least one `uptime.ok` sample on
  the 60 s vantage AND a row in `uptime_daily` (so a brand-new monitor appears
  after the next rollup run, at most 10 minutes). Only `key` and
  `display_name`; never `sub_resource`, infrastructure names or raw errors.
- `upPct` = up samples / `uptime.ok` samples * 100, `samples` = that total.
  A bucket without samples is `null`, whether it precedes the monitor's first
  sample or is a data hole inside its span (a hole is not downtime). Never
  100 for "no data".
- `uptimePct`: the same ratio over all buckets of the range, i.e. weighted by
  samples over the time actually covered; `null` without samples.
- `coverage`: samples present / samples expected (one per 60 s) between
  `max(range start, firstSampleAt)` and `min(range end, now)`, capped at 1.
  It is how a hole shows up numerically.
- `latency`: p50/p95 of `uptime.latency` over the range (60 s vantage only).
  Sub-daily ranges: exact `percentile_cont`, `approximate: false`. `1d`
  ranges: the mean of the daily percentiles weighted by each day's sample
  count, `approximate: true` (exact percentiles over raw rows cost 1.5 s for
  73 days). Latency is NOT reported per bucket, to keep the payload small.
- `idlePct`: share of `uptime.idle = 1`. Sub-daily: exact, `null` if the app
  emitted none in the range. `1d`: from `uptime_daily.idle_samples` over
  total samples; `null` when no idle sample was 1, because the rollup cannot
  tell "never emitted" from "always 0".
- `firstSampleAt`/`lastSampleAt`: whole history, not clamped to the range.
- `incidents`: `uptime_incidents` overlapping the (aligned) range, newest
  first, at most 100, with `truncated` and `totalIncidents`. `endedAt` is null
  for an open incident; its `durationSeconds` runs to now.
- The current day's `1d` bucket is as fresh as the last 10-minute job run.

Caching: `Cache-Control: public, max-age=60`, or `3600` when `to` is at or
before the start of today (UTC). In process: keyed on
`(projectId, from, to, granularity)` after normalisation (whole minutes, `to`
clamped; an absent `from` is keyed as "whole"), storing the in-flight promise,
LRU with at most 256 entries and 250k buckets in total (one 24 h entry is 10k
buckets, so the entry count alone is no memory bound), TTL 60 s for ranges
including now and 1 h for ranges ending before today. 404s and errors are
evicted at once. A cache miss holds one pool connection at a time.

## Consequences

- History is permanent from the moment this is deployed; the Mongo backfill
  (`scripts/backfill-portfolio-uptime.mjs`) must run before 2026-09-24
  (compression) and certainly before 2026-10-09 (TTL).
- Uptime rows exist twice for 90 days (about 15% of `metrics` rows); accepted
  for keeping the viewer and thresholds untouched.
- Rollups may be rebuilt from raw samples at any time; raw samples are the
  source of truth.
- `deploy.sh`'s privilege gate covers `metrics` chunks only; `uptime_samples`
  chunk grants propagate from the hypertable and are checked by hand.
- Rollback: drop the three tables and revert the ingest change; safe until the
  backfill has run.
