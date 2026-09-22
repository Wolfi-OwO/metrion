-- Hardens `refresh_uptime_rollup`/`refresh_uptime_rollup_job` (0015) per the
-- security review of migrations 0014/0015, findings 4 and 5 (2026-09-21).
-- `CREATE OR REPLACE FUNCTION` here, not an edit to 0015 in place - 0015 has
-- already run in every environment, so only a new migration reaches the
-- function TimescaleDB's job actually calls.

-- ---- finding 4: floor the incident lookback -------------------------------
--
-- The incidents section extends its own lookback (`v_inc_from`) back to the
-- start of any incident still open, so a run that lands inside an ongoing
-- outage recomputes it from its true beginning rather than re-creating it as
-- starting at the window edge. Without a floor, one incident that never
-- closes - a decommissioned or dead monitor whose last `uptime.ok = 0` sample
-- is also its last sample ever, so no later "up" row ever closes it - pulls
-- `v_inc_from` back to that incident's `started_at` forever. The scheduled
-- job (`refresh_uptime_rollup_job`, every 10 minutes, no arguments) would
-- then re-scan and re-delete/re-insert incidents across the FULL span back to
-- that stale open incident on every single run, not just the normal 2-day
-- window - unbounded, growing work for a permanent store with no retention.
--
-- `greatest(..., v_to - INTERVAL '30 days')` floors it: an incident whose own
-- `started_at` is older than 30 days before `v_to` is left exactly as already
-- stored - not re-derived, not deleted - rather than pulled into every run's
-- window. 30 days is generous against the routine job's own 2-day default
-- window; it only ever binds when an incident has actually been open that
-- long, the pathological case this fix targets.
CREATE OR REPLACE FUNCTION refresh_uptime_rollup(
  p_from timestamptz DEFAULT NULL,
  p_to   timestamptz DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_to        timestamptz := coalesce(p_to, now());
  -- Days are UTC days whatever the session time zone is.
  v_day_from  timestamptz := date_trunc('day', coalesce(p_from, now() - INTERVAL '2 days') AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  v_day_to    timestamptz := date_trunc('day', v_to AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + INTERVAL '1 day';
  v_inc_from  timestamptz;
BEGIN
  -- The 10-minute job and a manual rebuild must not interleave.
  PERFORM pg_advisory_xact_lock(hashtext('refresh_uptime_rollup'));

  -- ---- daily ----------------------------------------------------------
  DELETE FROM uptime_daily
   WHERE day >= (v_day_from AT TIME ZONE 'UTC')::date
     AND day <  (v_day_to   AT TIME ZONE 'UTC')::date;

  -- total_samples counts uptime.ok rows (one per check), not every metric
  -- row: latency and idle rows would otherwise inflate the denominator.
  -- A day without an ok sample gets no row, so "before monitoring" is null
  -- in the API and never 100%.
  INSERT INTO uptime_daily (
    project_id, resource, day, up_samples, total_samples, down_ms,
    latency_p50, latency_p95, latency_avg, latency_max, idle_samples)
  SELECT
    project_id,
    resource,
    (time AT TIME ZONE 'UTC')::date,
    (count(*) FILTER (WHERE name = 'uptime.ok' AND value = 1))::integer,
    (count(*) FILTER (WHERE name = 'uptime.ok'))::integer,
    coalesce(sum(interval_seconds * 1000) FILTER (WHERE name = 'uptime.ok' AND value <> 1), 0)::bigint,
    percentile_cont(0.5)  WITHIN GROUP (ORDER BY value) FILTER (WHERE name = 'uptime.latency'),
    percentile_cont(0.95) WITHIN GROUP (ORDER BY value) FILTER (WHERE name = 'uptime.latency'),
    avg(value) FILTER (WHERE name = 'uptime.latency'),
    max(value) FILTER (WHERE name = 'uptime.latency'),
    (count(*) FILTER (WHERE name = 'uptime.idle' AND value = 1))::integer
  FROM uptime_samples
  WHERE interval_seconds <= 60
    AND name IN ('uptime.ok', 'uptime.latency', 'uptime.idle')
    AND time >= v_day_from AND time < v_day_to
  GROUP BY project_id, resource, (time AT TIME ZONE 'UTC')::date
  HAVING count(*) FILTER (WHERE name = 'uptime.ok') > 0
  ON CONFLICT (project_id, resource, day) DO UPDATE SET
    up_samples    = EXCLUDED.up_samples,
    total_samples = EXCLUDED.total_samples,
    down_ms       = EXCLUDED.down_ms,
    latency_p50   = EXCLUDED.latency_p50,
    latency_p95   = EXCLUDED.latency_p95,
    latency_avg   = EXCLUDED.latency_avg,
    latency_max   = EXCLUDED.latency_max,
    idle_samples  = EXCLUDED.idle_samples;

  -- ---- incidents ------------------------------------------------------
  -- An incident still open (or closed inside the window) may have started
  -- before it; recompute from its start, or it would be re-created as
  -- starting at the window edge. Floored at `v_to - 30 days` (finding 4,
  -- see the migration header above) so a stale open incident cannot pull
  -- this back to the beginning of history; an incident older than the floor
  -- keeps its stored row exactly as it already is.
  SELECT greatest(least(v_day_from, coalesce(min(started_at), v_day_from)), v_to - INTERVAL '30 days')
    INTO v_inc_from
    FROM uptime_incidents
   WHERE ended_at IS NULL OR ended_at >= v_day_from;

  DELETE FROM uptime_incidents WHERE started_at >= v_inc_from AND started_at < v_to;

  -- Runs of uptime.ok = 0. A run starts at a down sample whose predecessor was
  -- up or more than 2.5 sample intervals earlier (a data hole is not an
  -- incident). It ends at the first following up sample; if the next sample is
  -- across a hole, it ends one interval after its last down sample; if there is
  -- no next sample and the last one is fresh, it is open (ended_at NULL).
  INSERT INTO uptime_incidents (project_id, resource, started_at, ended_at, down_samples)
  WITH s AS (
    SELECT project_id, resource, time, value, interval_seconds,
           lag(time)   OVER w AS prev_time,
           lag(value)  OVER w AS prev_value,
           lead(time)  OVER w AS next_time,
           lead(value) OVER w AS next_value
      FROM uptime_samples
     WHERE name = 'uptime.ok' AND interval_seconds <= 60
       AND time >= v_inc_from AND time < v_to
    WINDOW w AS (PARTITION BY project_id, resource ORDER BY time)
  ), d AS (
    SELECT *,
           sum(CASE WHEN prev_value IS DISTINCT FROM 0
                      OR time - prev_time > interval_seconds * 2.5 * INTERVAL '1 second'
                    THEN 1 ELSE 0 END)
             OVER (PARTITION BY project_id, resource ORDER BY time) AS run_id
      FROM s
     WHERE value = 0
  )
  SELECT project_id, resource,
         min(time),
         CASE
           WHEN (array_agg(next_value ORDER BY time DESC))[1] = 1
            AND (array_agg(next_time  ORDER BY time DESC))[1] - max(time)
                  <= max(interval_seconds) * 2.5 * INTERVAL '1 second'
             THEN (array_agg(next_time ORDER BY time DESC))[1]
           WHEN (array_agg(next_time ORDER BY time DESC))[1] IS NULL
            AND v_to - max(time) <= max(interval_seconds) * 2.5 * INTERVAL '1 second'
             THEN NULL
           ELSE max(time) + max(interval_seconds) * INTERVAL '1 second'
         END,
         count(*)::integer
    FROM d
   GROUP BY project_id, resource, run_id
  ON CONFLICT (project_id, resource, started_at) DO UPDATE SET
    ended_at     = EXCLUDED.ended_at,
    down_samples = EXCLUDED.down_samples;
END
$$;

-- ---- finding 5: pin search_path, revoke PUBLIC execute --------------------
--
-- Neither `refresh_uptime_rollup` nor `refresh_uptime_rollup_job` pinned
-- `search_path`, so either would resolve an unqualified identifier through
-- whatever `search_path` its CALLER had, not a fixed one - the standard
-- SQL-injection-via-search-path risk for a `SECURITY DEFINER`-adjacent
-- function (this one is not `SECURITY DEFINER`, but a superuser-owned
-- `plpgsql` function run by a scheduled job is the same class of target: a
-- malicious `public` schema object shadowing a bare table/function name
-- could otherwise be picked up). Both also default to `EXECUTE` granted to
-- `PUBLIC` (Postgres's own default for a new function), letting any role
-- that can connect at all invoke a job that touches every project's uptime
-- history - `metrion_ingest` and `metrion_app` have never needed to call
-- either directly; only the TimescaleDB job scheduler and a superuser doing
-- a manual rebuild do.
ALTER FUNCTION  refresh_uptime_rollup(timestamptz, timestamptz) SET search_path = pg_catalog, public;
ALTER PROCEDURE refresh_uptime_rollup_job(integer, jsonb)       SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION  refresh_uptime_rollup(timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON PROCEDURE refresh_uptime_rollup_job(integer, jsonb)       FROM PUBLIC;

-- The TimescaleDB job (`packages/db/migrations/0015_uptime_rollup_job.sql`'s
-- `add_job`) runs as the function's owner (`metrion`, the migration role),
-- never as `PUBLIC` - revoking `PUBLIC`'s execute grant does not touch that,
-- and a manual rebuild is always run by a human connected as `metrion`
-- (`organizational/agent-deployment-runbook.md`).
