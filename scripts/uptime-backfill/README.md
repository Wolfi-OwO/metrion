# Uptime backfill (GitHub issue #27)

One-time ETL: loads the ~90 days of historical `MonitorCheck` data already
sitting in MongoDB Atlas into Metrion's `metrics` hypertable, so the
dashboard shows real history on day one instead of starting empty.

**This is a disposable one-shot, not a sync pipeline.** MongoDB's TTL index
expires `MonitorCheck` rows after 90 days and Metrion's own retention policy
drops chunks after 90 days (`packages/db/migrations/0004_rollups_and_retention.sql`),
so this buys "90 days of history, 90 days earlier" and nothing more — the
oldest rows it loads will themselves be dropped within days of landing. No
scheduling, cursor state or incremental sync is built here. Task 26 (already
shipped) covers everything from its own go-live forward; this script exists
only to backfill what came before it.

Run once, 2026-09-30, against project `86b02c8c-4357-4655-9835-1897787cdd9a`
("Applications Server 01"). The scripts stay in the tree as the record of
that run — not wired into CI or any timer.

## Credential used — deviates from the original issue text

The original issue asked for a dedicated read-only Atlas user. The account
owner decided to use the existing production user (`woofi`) instead, whose
password lives in `/opt/portfolio/.env` on the VPS (never in a repo).
**Because this is the full read/write production credential being used for
a read-only job, only `mongoexport` was ever run against Atlas in this
procedure — never `mongorestore`, `mongoimport`, nor any other write
command.** Every Atlas interaction below is `mongoexport` (a read command)
or a `mongosh --eval` running a `find`/`aggregate`/`countDocuments` (also
read-only). Verified: `monitors.countDocuments()` was 7 before, during and
after this entire procedure — this run never wrote to Atlas.

## Tooling

Neither `mongoexport` nor `mongosh` was installed anywhere reachable. Rather
than give up, both were fetched as standalone binaries (no root, no system
package changes) onto the VPS, used from a scratch directory, and deleted
afterward:

```bash
curl -sO https://fastdl.mongodb.org/tools/db/mongodb-database-tools-ubuntu2404-x86_64-100.10.0.deb
ar x mongodb-database-tools-ubuntu2404-x86_64-100.10.0.deb && tar xf data.tar.*   # -> usr/bin/mongoexport
curl -sLO https://downloads.mongodb.com/compass/mongosh-2.3.2-linux-x64.tgz && tar xf mongosh-2.3.2-linux-x64.tgz
```

## Stage (E) — Export

Read-only, from Atlas, database `portfolio`
(`mongodb+srv://<REDACTED-USER>:${MONGODB_PASSWORD}@<REDACTED-ATLAS-HOST>/portfolio`,
per `portfolio-webpage/application/docker-compose.prod.yaml`). Run from the
VPS (reachable; this machine has no Mongo egress path proven):

```bash
MONGODB_PASSWORD=$(grep -m1 '^MONGODB_PASSWORD=' /opt/portfolio/.env | cut -d= -f2-)
ATLAS_URI="mongodb+srv://<REDACTED-USER>:${MONGODB_PASSWORD}@<REDACTED-ATLAS-HOST>/portfolio"
mongoexport --uri "$ATLAS_URI" --collection monitors      --out monitors.ndjson
mongoexport --uri "$ATLAS_URI" --collection monitorchecks --out checks.ndjson
```

**Measured, not derived** (the planning estimate of ~10k rows/day / ~900k
total was a derived guess; these replace it):

| Measurement                                                    | Value                    |
| -------------------------------------------------------------- | ------------------------ |
| `db.monitorchecks.countDocuments()`, before export             | 503,564                  |
| `db.monitorchecks.countDocuments()`, immediately after export  | 503,571                  |
| `db.monitorchecks.countDocuments()`, after the whole procedure | 503,655                  |
| `db.monitors.countDocuments()`                                 | 7 (unchanged throughout) |
| `wc -l checks.ndjson`                                          | 503,564                  |
| `wc -l monitors.ndjson`                                        | 7                        |
| min `at`                                                       | 2026-07-11T18:30:00.333Z |
| max `at`                                                       | 2026-09-30T17:45:01.487Z |

The count grew by 7 between the "before" and "immediately after" measurement
and kept growing afterward (503,571 → 503,655 over the following ~15
minutes) — the production `monitor-checker` Azure Function checks all 7
monitors roughly once a minute, 24/7, and never stopped running during this
procedure. `mongoexport` issues no write of any kind, so this growth is the
live system doing its own job, not a side effect of anything here. The
source is provably unmodified by this procedure: `monitors.countDocuments()`
never changed (7 throughout), and `monitorchecks.countDocuments()` only ever
grew, consistent with the live checker's own cadence.

`monitors.ndjson` is driven from directly, never from
`portfolio-webpage/application/server/src/database/data/monitors.json` — see
the Transform section for why (the seed is not the live list).

## Stage (T) — Transform

```bash
node scripts/uptime-backfill/transform.mjs monitors.ndjson checks.ndjson \
  86b02c8c-4357-4655-9835-1897787cdd9a live-cutoffs.json > points.tsv
```

Plain Node, no new dependency. Reads both NDJSON files, writes a TSV for
`COPY` on stdout, and a summary to stderr.

### Resource mapping — deviates from ADR 0007 §2's written text

ADR 0007 §2 describes `resource = slugified monitor.group` (falling back to
slugified `monitor.name`), `sub_resource = slugified monitor.name`. That is
the design that was **planned**, not what **shipped**. The actual dual-write
code, `portfolio-webpage/application/jobs/src/lib/metrion-sink.js` (commit
`ffeaa57`, "made the Metrion sink address monitors by key and emit
uptime.idle for ARM checks"), addresses every monitor by its own explicit
`metrionKey` field and never sets `subResource` at all — confirmed against
`metrion-sink.test.js`'s own assertions (`"an HTTP monitor is addressed by
metrionKey: one envelope, no subResource, two points"`) and its file
comment: deriving the key from group/name once folded "Portfolio" and
"Status Page" into one averaged resource and lost Network Visualizer's own
key (`netviz` vs. the slug `network-visualizer`).

There is no slug function in the shipped code to copy. Using ADR 0007's
written mapping here would put the backfilled series and the live series
under two different resource keys that never join — exactly the failure
this task exists to avoid, and confirmed by measurement, not just ADR text:
Metrion's `metrics` table already holds live `uptime.*` rows for this
project keyed by `metrionKey` (e.g. `netviz`, `ml-visualizer-preview`), not
by any slug. So: **`resource = monitor.metrionKey`**, looked up from the
exported `monitors` collection; **`sub_resource` is always NULL**, matching
the live sink exactly.

Only `uptime.ok` and `uptime.latency` are emitted — the two points this
issue's mapping names. The live sink also emits a third point,
`uptime.idle`, for ARM-checked monitors; left out here as a deliberate scope
cut (the issue's mapping names only two points, and a 90-day-old idle
history has no open use case), not silently dropped.

### Upper bound — a second clamp the issue text didn't anticipate

The 90-day **lower** clamp (`at >= now() - 90 days`) was in the issue. A
**second, upper** clamp had to be added after measuring the live database:
Task 26's dual-write has been running in production since before this
backfill, and `metrics` already held real `uptime.*` rows for every one of
these 7 resources. Loading the full 90-day Mongo history without an upper
bound would re-load that overlap, producing a second, duplicate set of
points for every already-live timestamp — the exact kind of corruption the
loader's idempotency guard exists to prevent, just via a different
mechanism (overlap with the live writer, not a second run of this script).

So each resource has its own measured upper bound — the timestamp of that
resource's first live-written sample in `metrics` — and any check at or
after it is skipped, not loaded. Measured with:

```sql
SELECT resource, min(time) FROM metrics
WHERE project_id = '86b02c8c-4357-4655-9835-1897787cdd9a' AND name LIKE 'uptime.%'
GROUP BY resource ORDER BY resource;
```

which produced `live-cutoffs.json` (not committed — it is a measurement
taken at run time, not a script input that should exist before the live
system started writing):

| resource                | first live sample (exclusive upper bound) |
| ----------------------- | ----------------------------------------- |
| `ml-visualizer`         | 2026-09-14T12:09:41.000Z                  |
| `ml-visualizer-preview` | 2026-09-22T14:17:04.651Z                  |
| `netviz`                | 2026-09-14T12:09:41.000Z                  |
| `nutrilens`             | 2026-09-14T12:09:41.000Z                  |
| `portfolio`             | 2026-09-14T12:09:41.000Z                  |
| `preussen`              | 2026-09-22T14:17:04.328Z                  |
| `status-page`           | 2026-09-22T14:17:04.229Z                  |

Recreate it any time with the query above; `transform.mjs` and `load.sh`
both take its path as an argument and fail rather than guess if a resource
has no entry.

### Measured transform summary

```
transform: rows_read=503564 clamped_older_than_90d=0 clamped_live_overlap=128611
           skipped_missing_monitor=82 skipped_no_metrionKey=0 skipped_no_cutoff=0
           points_written=570590
```

Accounting: `503564 = 0 (age-clamped) + 128611 (already covered by the live
series) + 82 (unknown monitor) + 0 (no metrionKey) + 0 (no cutoff) + 374871
(loaded rows)`. `374871` rows produced `570590` points (each row emits 1
point, `uptime.ok`, always; a second, `uptime.latency`, only on a plain HTTP
check — `runningStatus IS NULL`). `570590` is exactly what `COPY` reported
(see below) — no unexplained delta.

**The 82 `skipped_missing_monitor` rows** all reference one Mongo
`ObjectId` (`6a9bec69a8c8abd4c1de0bda`) that has no corresponding document
in the exported `monitors` collection — a monitor that was deleted from
Mongo at some point, orphaning its checks (Mongo doesn't cascade-delete
`MonitorCheck` rows when a `Monitor` is removed). All 82 fall in an ~81
minute window, 2026-09-05T10:19–11:40Z — the same few minutes `portfolio`,
`preussen` and `status-page` first started being checked, suggesting a
monitor document created and then quickly removed around that same
onboarding event (the same class of event ADR 0007 §3 documents for a
"Preussen Bot" document — this is evidently a different, later one, since it
predates the current `monitors` collection's 7 live entries). Reported and
skipped, exactly as the issue's own mapping rule requires — not guessed at.

**Distinct `(resource, sub_resource)` pairs produced** (eyeballed against
`monitors.ndjson`'s 7 `metrionKey` values — all present, none extra):

```
(ml-visualizer, null), (ml-visualizer-preview, null), (netviz, null),
(nutrilens, null), (portfolio, null), (preussen, null), (status-page, null)
```

## Stage (L) — Load

`COPY` directly into the hypertable over SSH, bypassing the ingest service —
issue #5's clock-skew guard rejects timestamps older than ~48h, so 90 days
of history cannot go through `POST /api/v1/ingest` at all:

```bash
./scripts/uptime-backfill/load.sh points.tsv 86b02c8c-4357-4655-9835-1897787cdd9a live-cutoffs.json
```

`load.sh` is **not idempotent by design** and refuses to run twice: `metrics`
has no unique constraint and no natural key, so a second run doubles every
row with no way to tell the copies apart afterward — the single most likely
way this task corrupts data. Before `COPY`, it asserts, **per resource**,
that zero rows exist strictly before that resource's own live-cutoff for
this project (see the Transform section above for why a flat "any uptime.*
row for this project" check can't work here — the live writer already has
rows for this exact project). If any resource fails that check, it aborts
loudly without writing.

**Re-run requires this exact `DELETE` first** (mirrors the per-resource
guard exactly — a single flat timestamp cutoff would either miss backfilled
rows or delete live ones, since different resources' live-write start dates
differ by over a week):

```sql
DELETE FROM metrics WHERE project_id = '86b02c8c-4357-4655-9835-1897787cdd9a' AND name LIKE 'uptime.%' AND (
  (resource = 'ml-visualizer'         AND time < '2026-09-14T12:09:41.000Z') OR
  (resource = 'ml-visualizer-preview' AND time < '2026-09-22T14:17:04.651Z') OR
  (resource = 'netviz'                AND time < '2026-09-14T12:09:41.000Z') OR
  (resource = 'nutrilens'             AND time < '2026-09-14T12:09:41.000Z') OR
  (resource = 'portfolio'             AND time < '2026-09-14T12:09:41.000Z') OR
  (resource = 'preussen'              AND time < '2026-09-22T14:17:04.328Z') OR
  (resource = 'status-page'           AND time < '2026-09-22T14:17:04.229Z')
);
```

then re-run `CALL refresh_continuous_aggregate('metrics_hourly', <min>, <max>)`
over the same range again so `metrics_hourly` reflects the deletion (its
policy only auto-refreshes `[now-3h, now-1h]`; a historical change needs the
same manual call the load itself uses).

### Compression

Rows older than 7 days land in already-compressed chunks
(`add_compression_policy('metrics', INTERVAL '7 days')`,
`0004_rollups_and_retention.sql`). TimescaleDB 2.11+ inserts into a
compressed chunk correctly, just slower — no `decompress_chunk`/
`compress_chunk` dance needed. **Read out of ADR 0004, not re-measured
here**: ADR 0004 item 3 records the installed version as `2.30.0`
(`pg_available_extensions` against `timescale/timescaledb-ha:pg17`), well
past the 2.11 floor.

### `metrics_hourly`

The continuous aggregate's own refresh policy only auto-materializes
`[now-3h, now-1h]` — a historical insert outside that window needs an
explicit `refresh_continuous_aggregate` call, which `load.sh` runs
automatically after `COPY`, over the exact loaded range.

## Verification — all three passed

**1. Counts line up.**

|                                                     |               |
| --------------------------------------------------- | ------------- |
| `wc -l checks.ndjson`                               | 503,564       |
| `db.monitorchecks.countDocuments()` (before export) | 503,564       |
| transform `rows_read`                               | 503,564       |
| transform `points_written`                          | 570,590       |
| `COPY` reported row count                           | `COPY 570590` |

`503564 = 0 clamped (age) + 128611 clamped (live overlap) + 82 skipped
(unknown monitor) + 0 skipped (no metrionKey) + 0 skipped (no cutoff) +
374871 loaded rows`; `374871` rows → `570590` points, exactly what `COPY`
reported. No unexplained delta.

**2. Five spot-checked documents, including one ARM-mode row with no
latency point** (picked pseudo-randomly from the checks that actually landed
in Postgres; `_id`s are the Mongo `ObjectId`s):

| Mongo `_id`                | resource              | `at` (UTC)               | Mongo `ok`/`latencyMs`/`runningStatus` | Postgres rows found                                           |
| -------------------------- | --------------------- | ------------------------ | -------------------------------------- | ------------------------------------------------------------- |
| `6aa744f4dbb9942015207d3a` | ml-visualizer         | 2026-09-14T00:51:00.428Z | `true` / `422` / `ScaledToZero` (ARM)  | `uptime.ok=1` only — **no `uptime.latency` row**, as required |
| `6a61d3605e5c819d0b09b439` | ml-visualizer-preview | 2026-07-23T08:40:00.524Z | `true` / `515` / `null` (HTTP)         | `uptime.ok=1` **and** `uptime.latency=515`                    |
| `6a55e80df825f6d4c9c39bd6` | netviz                | 2026-07-14T07:41:01.532Z | `true` / `1529` / `Running` (ARM)      | `uptime.ok=1` only                                            |
| `6a7c0461d26bd6a5572c6937` | netviz                | 2026-08-12T05:28:01.288Z | `true` / `1279` / `ScaledToZero` (ARM) | `uptime.ok=1` only                                            |
| `6a6d6658e765d471cfc0fc0d` | netviz                | 2026-08-01T03:22:00.970Z | `true` / `963` / `ScaledToZero` (ARM)  | `uptime.ok=1` only                                            |

Every value, timestamp and resource matched; every `sub_resource` was
`NULL`; every ARM-mode row (non-null `runningStatus`) produced `uptime.ok`
and nothing else. 5/5.

**3. Cross-validation against `status-checker.js`'s own reader — the check
that actually proves the mapping.** `status-checker.js`'s `uptimePct` is
`(passed checks / total checks) * 100` over a window
(`status-checker.js:109-123`); reproduced here directly against Mongo with
the identical `$match`/`$group` shape, for `netviz`, over two fixed 24h/1h
windows:

| Window                                                                                   | Postgres `avg(uptime.ok) * 100` | Mongo, `status-checker.js`'s own formula | Samples       |
| ---------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------- | ------------- |
| 2026-08-15T00:00–2026-08-16T00:00Z (quiet day)                                           | 100.0000%                       | 100.0000%                                | 1,440 / 1,440 |
| 2026-09-08T13:00–14:00Z (the documented outage window, `checkMonitors.js`'s own comment) | 58.3333%                        | 58.3333%                                 | 35 / 60       |

Both agree exactly, including on the outage window (35/60 up both sides) —
the mapping is correct.

**`metrics_hourly` backfilled its own buckets**, confirmed rather than
assumed: 6,898 non-empty hourly buckets for `uptime.ok` across the loaded
range (2026-07-11 through 2026-09-23), e.g. `netviz`'s first few:
`2026-07-11 19:00+00 avg=1 n=120`, `20:00+00 avg=1 n=119`, `21:00+00 avg=1
n=103`, …

## Acceptance criteria

| Criterion                                                                           | Result                                        |
| ----------------------------------------------------------------------------------- | --------------------------------------------- |
| `monitors.ndjson`/`checks.ndjson` exist locally, Atlas provably unmodified          | PASS — counts above                           |
| Transform's summary accounts for every exported row as written/clamped/skipped      | PASS — accounting above, no unexplained delta |
| `COPY` loads into project `86b02c8c-4357-4655-9835-1897787cdd9a` only               | PASS                                          |
| A second run of `load.sh` aborts without writing                                    | PASS — per-resource guard; see Stage (L)      |
| Five spot-checked documents match, including one ARM-mode row with no latency point | PASS — table above                            |
| 24h `avg(uptime.ok)*100` agrees with `status-checker.js`'s figure, both recorded    | PASS — both windows, table above              |
| `metrics_hourly` returns non-empty buckets for the backfilled range                 | PASS — 6,898 buckets                          |

## Files

- `transform.mjs` — Mongo NDJSON → `COPY`-ready TSV, plain Node, no dependency.
- `load.sh` — the one-shot, non-idempotent `COPY` + `metrics_hourly` refresh over SSH.
- This README — the record of the one run that happened, 2026-09-30.

Not committed (regenerated locally if this is ever re-run, not durable
artifacts of the run): `monitors.ndjson`, `checks.ndjson`, `points.tsv`,
`live-cutoffs.json` — all either raw exports or derived intermediate data,
not source.
