#!/usr/bin/env bash
# Proves that dropping raw `metrics` chunks (what the 90-day retention policy
# does) cannot erase uptime history, and shows why uptime_daily is a plain
# table: a continuous aggregate refreshed over dropped raw chunks goes empty.
# See docs/adr/0009-permanent-uptime-history-and-range-api.md.
#
# Needs Docker. Manual test, not wired into CI (the CI job's service container
# cannot be dropped and recreated per run). Self-contained: starts a throwaway
# TimescaleDB container, never reads or writes any real database, and fails
# closed if DATABASE_URL is set so it cannot be pointed at one by accident.
set -euo pipefail

if [ -n "${DATABASE_URL:-}" ]; then
  echo "refusing to run: DATABASE_URL is set; this test only talks to its own scratch container" >&2
  exit 2
fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
migrations="$here/../migrations"
# Same tag as production (docker-compose.prod.yml, dev compose, CI).
image="timescale/timescaledb-ha:pg17"
name="metrion-retention-safety-$$"

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$name" -e POSTGRES_USER=metrion -e POSTGRES_PASSWORD=scratch \
  -e POSTGRES_DB=metrion "$image" >/dev/null

psql_() { docker exec -i "$name" psql -U metrion -d metrion -v ON_ERROR_STOP=1 -X -q "$@"; }
val() { psql_ -At -c "$1"; }

# The image restarts the server once after its init scripts; wait for two
# successful queries in a row so a migration does not hit the restart.
ok=0
for _ in $(seq 1 90); do
  if docker exec "$name" psql -U metrion -d metrion -Atc 'select 1' >/dev/null 2>&1; then
    ok=$((ok + 1)); [ "$ok" -ge 3 ] && break
  else
    ok=0
  fi
  sleep 2
done
[ "$ok" -ge 3 ] || { echo "scratch database did not become ready" >&2; exit 1; }

for f in "$migrations"/*.sql; do
  psql_ -1 -f - < "$f" >/dev/null
done
echo "timescaledb $(val "select extversion from pg_extension where extname='timescaledb'"); migrations applied: $(ls "$migrations"/*.sql | wc -l)"

# 40 days at 60 s: uptime (also mirrored into uptime_samples, as ingest does)
# with one 3-minute outage per day, plus container samples.
psql_ <<'SQL' >/dev/null
CREATE TEMP TABLE synth AS
SELECT t, extract(epoch FROM t)::bigint / 60 % 1440 AS minute_of_day
  FROM generate_series(date_trunc('minute', now()) - INTERVAL '40 days',
                       date_trunc('minute', now()) - INTERVAL '1 minute',
                       INTERVAL '1 minute') AS t;
INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
SELECT t, '00000000-0000-0000-0000-000000000001'::uuid, 'app', NULL::text, 'uptime.ok',
       CASE WHEN minute_of_day BETWEEN 100 AND 102 THEN 0 ELSE 1 END, 'boolean', 60 FROM synth
UNION ALL
SELECT t, '00000000-0000-0000-0000-000000000001'::uuid, 'app', NULL, 'container.cpu', 5, 'percent', 60 FROM synth;
INSERT INTO uptime_samples (time, project_id, resource, name, value, unit, interval_seconds)
SELECT t, '00000000-0000-0000-0000-000000000001'::uuid, 'app', 'uptime.ok',
       CASE WHEN minute_of_day BETWEEN 100 AND 102 THEN 0 ELSE 1 END, 'boolean', 60 FROM synth;
SELECT refresh_uptime_rollup(now() - INTERVAL '41 days', now());
SQL

snapshot() {
  val "select (select count(*) from uptime_samples) || ' ' ||
              (select count(*) from uptime_daily) || ' ' ||
              (select count(*) from uptime_incidents) || ' ' ||
              (select md5(string_agg(d::text, ',' order by day)) from uptime_daily d) || ' ' ||
              (select md5(string_agg(row(resource, started_at, ended_at, down_samples)::text, ',' order by started_at) ) from uptime_incidents)"
}

metrics_before=$(val "select count(*) from metrics")
before=$(snapshot)
[ "$(val 'select count(*) from uptime_incidents')" -ge 30 ] || { echo "FAIL: synthetic outages produced no incidents" >&2; exit 1; }

val "select count(*) from drop_chunks('metrics', older_than => INTERVAL '7 days')" >/dev/null
metrics_after=$(val "select count(*) from metrics")
[ "$metrics_after" -lt "$metrics_before" ] || { echo "FAIL: drop_chunks dropped nothing, test proves nothing" >&2; exit 1; }
after=$(snapshot)

if [ "$before" != "$after" ]; then
  echo "FAIL: uptime history changed by dropping metrics chunks" >&2
  echo "  before: $before" >&2; echo "  after:  $after" >&2
  exit 1
fi
echo "OK: dropping raw metrics chunks ($metrics_before -> $metrics_after rows) left uptime_samples, uptime_daily and uptime_incidents unchanged ($before)"

# Contrast: a continuous aggregate over a source whose chunks were dropped.
psql_ <<'SQL' >/dev/null
CREATE TABLE scratch_src (time timestamptz NOT NULL, v double precision NOT NULL);
SELECT create_hypertable('scratch_src', 'time');
INSERT INTO scratch_src
SELECT t, 1 FROM generate_series(now() - INTERVAL '40 days', now(), INTERVAL '10 minutes') t;
CREATE MATERIALIZED VIEW scratch_cagg WITH (timescaledb.continuous) AS
SELECT time_bucket('1 day', time) AS bucket, avg(v) AS v FROM scratch_src GROUP BY 1 WITH NO DATA;
CALL refresh_continuous_aggregate('scratch_cagg', NULL, now() - INTERVAL '1 day');
SQL
# 15 days: drop_chunks keeps the (7-day) chunk containing now()-7d, so anything older than 14 days is certainly gone.
window="bucket < now() - INTERVAL '15 days'"
cagg_before=$(val "select count(*) from scratch_cagg where $window")
val "select count(*) from drop_chunks('scratch_src', older_than => INTERVAL '7 days')" >/dev/null
# force => true: without it TimescaleDB refreshes only invalidated regions and
# dropping chunks records no invalidation, so a plain refresh would leave the
# stale buckets in place. That is a property of the cagg, not of this test:
# any full or forced refresh (a rebuild) empties them.
psql_ -c "CALL refresh_continuous_aggregate('scratch_cagg', now() - INTERVAL '41 days', now() - INTERVAL '8 days', force => true)" >/dev/null
cagg_after=$(val "select count(*) from scratch_cagg where $window")
if [ "$cagg_before" -gt 0 ] && [ "$cagg_after" -eq 0 ]; then
  echo "OK: contrast: a continuous aggregate refreshed over dropped raw chunks went empty ($cagg_before -> $cagg_after buckets), hence uptime_daily is a plain table"
else
  echo "FAIL: continuous aggregate contrast unexpected ($cagg_before -> $cagg_after)" >&2
  exit 1
fi
