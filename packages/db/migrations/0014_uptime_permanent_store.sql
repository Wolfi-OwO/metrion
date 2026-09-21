-- Permanent uptime history. See docs/adr/0009-permanent-uptime-history-and-
-- range-api.md.
--
-- `metrics` cannot keep uptime for good: its retention policy (0004, 90 days)
-- is per hypertable and cannot spare `uptime.*`, which is only 15% of the rows
-- next to `container.*`. Measured on production: 426 B/row, 15,762 uptime rows
-- after one week. At 1-minute cadence for seven monitors that is about 3.1 GB
-- per year uncompressed (compressed roughly 0.3 GB, an estimate - only the
-- 426 B/row is measured), small enough to keep forever in its own table.
--
-- No continuous aggregate here on purpose: refreshing one over a window whose
-- raw chunks were dropped materialises empty buckets. The permanent store is
-- raw samples plus the plain rollup tables below (filled by 0015's job).

CREATE TABLE uptime_samples (
  time             timestamptz      NOT NULL,
  project_id       uuid             NOT NULL,
  resource         text             NOT NULL,
  name             text             NOT NULL,
  value            double precision NOT NULL,
  unit             text             NOT NULL,
  interval_seconds integer          NOT NULL
);

SELECT create_hypertable('uptime_samples', 'time');

CREATE INDEX uptime_samples_lookup_idx
  ON uptime_samples (project_id, resource, name, time DESC);

-- Includes the partition column, which TimescaleDB requires. Makes ingest
-- retries and the Mongo backfill idempotent through ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX uptime_samples_unique_idx
  ON uptime_samples (project_id, resource, name, time);

ALTER TABLE uptime_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id, resource, name',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('uptime_samples', INTERVAL '7 days');
-- Deliberately NO add_retention_policy.

CREATE TABLE uptime_daily (
  project_id    uuid             NOT NULL,
  resource      text             NOT NULL,
  day           date             NOT NULL,
  up_samples    integer          NOT NULL,
  total_samples integer          NOT NULL,
  down_ms       bigint           NOT NULL,
  latency_p50   double precision,
  latency_p95   double precision,
  latency_avg   double precision,
  latency_max   double precision,
  idle_samples  integer          NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, resource, day)
);

CREATE TABLE uptime_incidents (
  id           bigserial   PRIMARY KEY,
  project_id   uuid        NOT NULL,
  resource     text        NOT NULL,
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  down_samples integer     NOT NULL,
  UNIQUE (project_id, resource, started_at)
);

-- Ingest appends samples and reads them (ON CONFLICT needs SELECT); it never
-- rewrites or deletes history, and it does not touch the derived tables.
-- TimescaleDB propagates the hypertable grant to its chunks.
GRANT SELECT, INSERT ON uptime_samples TO metrion_ingest;
GRANT SELECT ON uptime_daily, uptime_incidents TO metrion_ingest;

GRANT SELECT ON uptime_samples, uptime_daily, uptime_incidents TO metrion_app;
