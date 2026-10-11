#!/usr/bin/env bash
# One-shot loader: COPYs scripts/uptime-backfill/transform.mjs's output TSV
# into Metrion's `metrics` hypertable over SSH, bypassing the ingest service
# (issue #5's clock-skew guard rejects timestamps older than ~48h, so 90
# days of history cannot go through POST /api/v1/ingest). See README.md for
# the full three-stage procedure this is stage (L) of.
#
# NOT idempotent by design, on purpose: `metrics` is a hypertable of samples
# with no unique constraint and no natural key, so a second run doubles
# every row with no way to tell the copies apart afterwards. This script
# refuses to load if backfill-range data already exists for the given
# project (see the guard query below) — a re-run needs an explicit DELETE
# first, documented in README.md.
#
# The guard is PER-RESOURCE and bounded by each resource's own live-cutoff
# (live-cutoffs.json, the same file transform.mjs reads), not a flat
# "any uptime.* row for this project" check: Task 26's dual-write has been
# writing real uptime.* rows to this exact project since before this backfill
# ever runs, so a flat check would find those live rows and refuse to run on
# the very first (and every) attempt. Checking only the backfill's own time
# range (strictly before each resource's live cutoff) distinguishes "this
# backfill already ran" from "the live writer is doing its job" correctly.
set -euo pipefail

usage() {
    echo "usage: load.sh <points.tsv> <project_id> <live-cutoffs.json> [ssh_target] [compose_file]" >&2
    exit 1
}

POINTS_TSV=${1:?$(usage)}
PROJECT_ID=${2:?$(usage)}
CUTOFFS_JSON=${3:?$(usage)}
SSH_TARGET=${4:-deploy@${VPS_HOST:?pass the SSH target as argument 4 or set VPS_HOST}}
SSH_KEY=${SSH_KEY:-$HOME/.ssh/contabo_vps}
COMPOSE_FILE=${5:-/opt/metrion/docker-compose.prod.yml}

for f in "$POINTS_TSV" "$CUTOFFS_JSON"; do
    [ -f "$f" ] || {
        echo "not found: $f" >&2
        exit 1
    }
done

ssh_cmd() {
    ssh -i "$SSH_KEY" -o BatchMode=yes "$SSH_TARGET" "$@"
}

# Builds one "SELECT count(*) ... WHERE resource = X AND time < cutoff(X)"
# per resource from live-cutoffs.json, UNIONed into a single guard query.
# Plain Node (already a project dependency), no SQL templating library for
# seven rows.
GUARD_SQL=$(node -e '
const cutoffs = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const projectId = process.argv[2];
const esc = (s) => s.replace(/\x27/g, "\x27\x27");
const parts = Object.entries(cutoffs).map(
  ([resource, iso]) =>
    `SELECT count(*) AS cnt FROM metrics WHERE project_id = \x27${esc(projectId)}\x27 AND resource = \x27${esc(resource)}\x27 AND name LIKE \x27uptime.%\x27 AND time < \x27${esc(iso)}\x27`,
);
console.log(`SELECT coalesce(sum(cnt), 0) FROM (${parts.join(" UNION ALL ")}) t;`);
' "$CUTOFFS_JSON" "$PROJECT_ID")

echo "load.sh: checking project $PROJECT_ID has no pre-existing backfill-range uptime.* rows..." >&2
EXISTING=$(ssh_cmd "docker compose -f $COMPOSE_FILE exec -T db psql -U metrion -d metrion -tAc \"$GUARD_SQL\"" | tr -d '[:space:]')
if [ "$EXISTING" != "0" ]; then
    echo "ABORT: $EXISTING uptime.* row(s) already exist in the backfill's own time range for project $PROJECT_ID." >&2
    echo "  This backfill (or something else) already ran. Re-run requires an explicit DELETE first — see README.md's exact statement." >&2
    exit 1
fi

# points.tsv column 1 is an ISO-8601 UTC timestamp (toISOString(), fixed
# width), which compares lexicographically the same as chronologically — a
# single awk pass, not a sort, both to avoid sorting 500k+ lines twice and
# because piping sort's output into head/tail raced a SIGPIPE in testing.
read -r MIN_TIME MAX_TIME <<<"$(awk -F'\t' 'NR==1{min=$1;max=$1} $1<min{min=$1} $1>max{max=$1} END{print min, max}' "$POINTS_TSV")"
ROW_COUNT=$(wc -l <"$POINTS_TSV" | tr -d '[:space:]')
echo "load.sh: loading $ROW_COUNT rows, range $MIN_TIME .. $MAX_TIME" >&2

ssh_cmd "docker compose -f $COMPOSE_FILE exec -T db psql -U metrion -d metrion -v ON_ERROR_STOP=1 -c \"COPY metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds) FROM STDIN\"" \
    <"$POINTS_TSV"

# TimescaleDB measured at 2.30.0 (ADR 0004) — well past the 2.11 floor where
# inserting into an already-compressed chunk needs a manual
# decompress/COPY/compress dance. No decompress_chunk/compress_chunk step
# here; see README.md's Compression section for the version this decision is
# based on.

# add_continuous_aggregate_policy only auto-refreshes [now-3h, now-1h]
# (0004_rollups_and_retention.sql) — a historical insert outside that window
# needs an explicit refresh over the loaded range, or metrics_hourly stays
# empty for it.
echo "load.sh: refreshing metrics_hourly over $MIN_TIME .. $MAX_TIME..." >&2
ssh_cmd "docker compose -f $COMPOSE_FILE exec -T db psql -U metrion -d metrion -v ON_ERROR_STOP=1 -c \"CALL refresh_continuous_aggregate('metrics_hourly', '$MIN_TIME', '$MAX_TIME');\""

echo "load.sh: done. Verify with:" >&2
echo "  SELECT resource, name, count(*), min(time), max(time) FROM metrics WHERE project_id = '$PROJECT_ID' AND name LIKE 'uptime.%' GROUP BY resource, name ORDER BY resource, name;" >&2
