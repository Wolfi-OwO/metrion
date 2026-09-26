# Quickstart: bash

The absolute minimum way to get real numbers off a box and into metrion:
`/proc`, `df`, and `curl`. No SDK, no runtime to install, no library to pin -
just the shell commands most machines already have. This is one of the
per-language quickstart pages (issue #10 adds the rest); this page stands on
its own.

It POSTs a **bare array of metric points** - the plain
`{name, value, unit, timestamp, interval}` shape, with no `resource` wrapper
at all. The ingest service fills in `resource` from the project's own
`default_resource` (see `docs/adr/0005-api-key-determines-tenancy.md`), so a
sender that only ever reports for one project never has to know or send its
own name.

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` - `API_KEY`
below is that token, key prefix and secret together.

## The script

```bash
#!/usr/bin/env bash
set -euo pipefail

# Where the ingest service listens and the API key it should bill this data
# to. mtr_<prefix>_<secret> - never commit a real one; generate a project and
# a key first (see the ingest service's own README once issue #7's
# account/project API exists - until then, seed one directly, the same way
# applications/ingest/tests/ingest.test.ts does).
INGEST_URL="${INGEST_URL:-http://localhost:8090}"
API_KEY="${API_KEY:-mtr_REPLACE_WITH_YOUR_KEY_PREFIX_REPLACE_WITH_YOUR_SECRET}"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- CPU%: two /proc/stat samples one second apart -------------------------
# Line 1 is the aggregate "cpu" line: user nice system idle iowait irq softirq
# steal guest guest_nice (man proc(5)). "busy" is everything that isn't idle
# or iowait; usage% is the busy delta over the total delta between samples -
# a single snapshot cannot give a rate, only a cumulative counter since boot.
read_cpu_line() { awk '/^cpu /{ $1=""; print }' /proc/stat; }

cpu_percent() {
  local a b idle_a idle_b total_a total_b busy_a busy_b
  a=($(read_cpu_line)); sleep 1; b=($(read_cpu_line))

  idle_a=$(( a[3] + a[4] )); idle_b=$(( b[3] + b[4] ))
  total_a=0; for v in "${a[@]}"; do total_a=$(( total_a + v )); done
  total_b=0; for v in "${b[@]}"; do total_b=$(( total_b + v )); done
  busy_a=$(( total_a - idle_a )); busy_b=$(( total_b - idle_b ))

  awk -v db="$(( busy_b - busy_a ))" -v dt="$(( total_b - total_a ))" \
    'BEGIN { printf "%.2f", (dt > 0) ? (100 * db / dt) : 0 }'
}

# --- Memory%: MemAvailable, not MemFree - matches applications/agent's own
# reasoning (a page cache full of reclaimable pages is not "used" memory). ---
memory_percent() {
  awk '
    /^MemTotal:/     { total = $2 }
    /^MemAvailable:/ { avail = $2 }
    END              { printf "%.2f", (total > 0) ? (100 * (total - avail) / total) : 0 }
  ' /proc/meminfo
}

# --- Disk%: the root filesystem's own "Use%" column from df, no dependency
# beyond df itself (POSIX, `-P` for portable single-line output). -----------
disk_percent() {
  df -P / | awk 'NR==2 { gsub("%", "", $5); print $5 }'
}

TIMESTAMP="$(now)"
CPU="$(cpu_percent)"
MEMORY="$(memory_percent)"
DISK="$(disk_percent)"

BODY=$(cat <<JSON
[
  { "name": "cpu.usage",    "value": ${CPU},    "unit": "percent", "timestamp": "${TIMESTAMP}", "interval": 60 },
  { "name": "memory.usage", "value": ${MEMORY}, "unit": "percent", "timestamp": "${TIMESTAMP}", "interval": 60 },
  { "name": "disk.usage",   "value": ${DISK},   "unit": "percent", "timestamp": "${TIMESTAMP}", "interval": 60 }
]
JSON
)

curl -sS -o /dev/stdout -w '\nHTTP %{http_code}\n' \
  -X POST "${INGEST_URL}/api/v1/ingest" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "${BODY}"
```

## Running it

```bash
cp the script above into system-metrics.sh, chmod +x it, then:
INGEST_URL=http://localhost:8090 API_KEY=mtr_<prefix>_<secret> ./system-metrics.sh
```

A successful call answers `202` with `{"accepted":1,"points":3}` - one
(synthetic) envelope, three points. Run it from cron or a systemd timer once
a minute for continuous reporting; `applications/agent` is the same idea
built out into a real long-running collector once bash stops being enough
(container stats, request logs, a retry queue for outages).

## What this deliberately does not do

- No retry, no local queue - a failed POST here is just lost. `applications/agent`'s
  on-disk `SampleQueue` is the upgrade path once losing a minute's sample on a
  network blip starts to matter.
- No `resource`/`subResource` - this is the bare-array shape specifically to
  exercise (and demonstrate) the project's `default_resource` fallback. Send
  an enveloped body instead if a sender reports for more than one resource.
