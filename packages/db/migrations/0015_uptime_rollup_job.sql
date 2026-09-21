-- Keeps `uptime_daily` and `uptime_incidents` (0014) current from the raw
-- `uptime_samples`, inside the database: a TimescaleDB user-defined action
-- job, no extra process to deploy or supervise (the evaluator app is not
-- deployed anywhere, which is why it does not own this). See
-- docs/adr/0009-permanent-uptime-history-and-range-api.md.
--
-- Only the authoritative series counts: `interval_seconds <= 60` (the Azure
-- checker). The 300 s VPS-vantage rows stay in `uptime_samples` as history and
-- are ignored here. This function never deletes from `uptime_samples`.
--
-- Idempotent by construction: the affected daily rows and incidents are
-- deleted and recomputed from the raw samples in one transaction, so a re-run
-- or a full rebuild - SELECT refresh_uptime_rollup('2026-07-11', now()) -
-- yields identical rows. Deleting first (rather than upserting alone) also
-- clears rows that no longer have samples, which the documented rollback
-- (delete a backfilled range, re-run) depends on.
CREATE FUNCTION refresh_uptime_rollup(
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
  -- starting at the window edge.
  SELECT least(v_day_from, coalesce(min(started_at), v_day_from))
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

-- add_job needs a procedure taking (job_id, config); the function above keeps
-- its explicit window arguments for manual rebuilds.
CREATE PROCEDURE refresh_uptime_rollup_job(job_id integer, config jsonb)
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM refresh_uptime_rollup();
END
$$;

SELECT add_job('refresh_uptime_rollup_job', schedule_interval => INTERVAL '10 minutes');
