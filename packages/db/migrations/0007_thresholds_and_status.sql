-- Warning/critical thresholds per metric, and the status each threshold is
-- currently in.
--
-- direction is mandatory and has no default: disk-usage-% wants "above X is
-- bad", free-memory and requests-per-second want "below X is bad", and
-- hardcoding one direction is the bug this column exists to prevent.
--
-- `unique nulls not distinct` requires PostgreSQL 15+; the running dev DB
-- measured as PostgreSQL 17.11 (timescale/timescaledb-ha:pg17), so no
-- fallback to partial unique indexes is needed here.
CREATE TABLE thresholds (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id           uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  application_id       uuid NULL,           -- null = every application in the project
  sub_resource         text NULL,           -- null = every sub_resource
  metric_name          text NOT NULL,
  direction            text NOT NULL CHECK (direction IN ('above','below')),
  warning_value        double precision,
  critical_value       double precision,
  consecutive_breaches smallint NOT NULL DEFAULT 2 CHECK (consecutive_breaches BETWEEN 1 AND 10),
  window_seconds       integer  NOT NULL DEFAULT 300 CHECK (window_seconds BETWEEN 60 AND 86400),
  enabled              boolean  NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (application_id, project_id) REFERENCES applications (id, project_id) ON DELETE CASCADE,
  CHECK (warning_value IS NOT NULL OR critical_value IS NOT NULL),
  CHECK (
    (direction = 'above' AND (warning_value IS NULL OR critical_value IS NULL OR critical_value >= warning_value))
    OR
    (direction = 'below' AND (warning_value IS NULL OR critical_value IS NULL OR critical_value <= warning_value))
  ),
  UNIQUE NULLS NOT DISTINCT (project_id, application_id, sub_resource, metric_name)
);

CREATE TABLE threshold_status (
  threshold_id      uuid NOT NULL REFERENCES thresholds(id) ON DELETE CASCADE,
  sub_resource_key  text NOT NULL DEFAULT '',
  state             text NOT NULL CHECK (state IN ('ok','warning','critical')),
  reason            text NOT NULL DEFAULT 'threshold' CHECK (reason IN ('threshold','no_data')),
  value             double precision,
  breach_count      smallint NOT NULL DEFAULT 0,
  since             timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  last_notified_at  timestamptz,
  last_notified_state text,
  PRIMARY KEY (threshold_id, sub_resource_key)
);

-- Not a hypertable: this holds state transitions, not samples - a few rows
-- per incident, not 37 per minute. Pruned by a DELETE ... WHERE at < now()
-- - interval '180 days' inside the evaluator (a later task), not by a
-- retention policy.
CREATE TABLE status_events (
  id                      bigserial PRIMARY KEY,
  project_id              uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  threshold_id            uuid NOT NULL REFERENCES thresholds(id) ON DELETE CASCADE,
  sub_resource_key        text NOT NULL DEFAULT '',
  from_state              text NOT NULL,
  to_state                text NOT NULL,
  value                   double precision,
  root_cause              boolean NOT NULL DEFAULT true,
  caused_by_application_id uuid,
  notified                boolean NOT NULL DEFAULT false,
  at                      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON status_events (project_id, at DESC);
