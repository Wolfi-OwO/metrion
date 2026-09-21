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

### 5. Range API contract (built later)

`GET /api/v1/public/projects/:id/uptime/range?from=&to=`

- `from`, `to`: ISO-8601 UTC, `from < to`. `to` is clamped to now. `from`
  defaults to the earliest day with data ("whole period"). Days use UTC
  semantics.
- Granularity: the smallest of `1m, 5m, 15m, 1h, 6h, 1d` that yields at most
  2000 buckets for the range.
- Response, one entry per application:

```json
{
  "from": "2026-07-11T00:00:00.000Z",
  "to": "2026-09-21T12:00:00.000Z",
  "granularity": "1d",
  "applications": [
    {
      "resource": "netviz",
      "uptimePct": 99.93,
      "latency": { "p50": 41, "p95": 118 },
      "buckets": [{ "start": "2026-07-11T00:00:00.000Z", "uptimePct": 100, "samples": 1440 }],
      "incidents": [{ "startedAt": "...", "endedAt": "...", "downSamples": 3 }],
      "truncated": false
    }
  ]
}
```

`incidents` is capped at 100 (`truncated: true` when more exist).
Buckets before a monitor's first sample have `uptimePct: null` (never 100).
`endedAt` is null for an open incident.

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
