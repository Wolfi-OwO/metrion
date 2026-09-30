# ADR 0007: Uptime monitoring as metrics - mapping, dual-write, and why no generic checker yet

## Status

Accepted, 2026-09-12.

Superseded in part by ADR 0009: uptime is now also written to the permanent
`uptime_samples` table (no retention); the 90-day `metrics` copy stays.

## Context

The portfolio site already runs its own uptime monitor: an Azure Function
(`monitor-checker`) probes each `Monitor` roughly once a minute and writes a
`MonitorCheck` row to MongoDB
(`portfolio-webpage/application/server/src/models/monitor-check.js:5-34`) -
`monitor`, `at`, `ok`, `statusCode`, `latencyMs`, `error`, `runningStatus`.
`status-checker.js` reads those rows to build the public status page:
per-monitor status, a 90-day daily history bar, and rolling uptime
percentages for 24h/7d/30d windows.

Metrion (this repo) now has its own generic metric store (ADR 0003's
envelope, ADR 0004's Postgres/TimescaleDB hypertable) and the applications
layer being built in Tasks 19-24 wants uptime as a first-class metric a
tenant can chart and threshold, the same way it already charts CPU or
memory. That means the same underlying check has to reach two systems: the
portfolio's own MongoDB store (which the public status page keeps reading)
and Metrion's `metrics` hypertable. Before any code writes to both, this ADR
fixes what a `MonitorCheck` row becomes as metric points, and records what
is deliberately left out of that mapping and why.

## Decision

### 1. One `MonitorCheck` row becomes two metric points, not one encoded value

- `uptime.ok` - `1` if `ok` is true, `0` otherwise. Unit `boolean`.
- `uptime.latency` - `latencyMs` verbatim. Unit `ms`.

The decisive argument is what the aggregate already does for free.
`metrics_hourly` (`packages/db/migrations/0004_rollups_and_retention.sql:19-33`)
computes `avg(value)` per `project_id, resource, sub_resource, name` per
hour. Run that `avg` over `uptime.ok` and the result **is** the uptime
percentage for that hour - "over any window" is then a `time_bucket` range
on an already-materialized column, not new code. That is exactly
`status-checker.js`'s own definition of uptime: "the share of the window's
checks that passed"
(`portfolio-webpage/application/server/src/utils/status-checker.js:101-125`,
`uptimePct`), deliberately not passed÷expected - see decision 5 for why that
distinction matters here too. Two systems computing uptime from the same
underlying checks land on the same number because they are using the same
formula, not because anyone kept them in sync by hand.

**Rejected: a single combined value.** Encoding both signals into one
column - e.g. `latencyMs`, with a negative sentinel meaning "down" - was
considered and rejected. `avg()` over that column is neither a latency
figure (down samples corrupt it) nor an uptime percentage (there is no
`avg` that recovers "count of non-negative ÷ total" without every reader
re-deriving the ok/down split by hand, i.e. special-casing every consumer
of the series exactly the way a shared column is supposed to avoid).
Two independent points let `metrics_hourly` answer two independent
questions with the one aggregation it already computes.

### 2. `resource` = slugified `monitor.group`, `sub_resource` = slugified `monitor.name`

This reuses the shape the docker-container collector already established -
one parent resource, many named sub-resources under it (`resource =
<host>`, `sub_resource = container:<name>`,
`applications/agent/src/lib/to-metric-envelopes.ts:66-76`) - rather than
inventing a third grouping convention for this integration alone.

It also preserves the group rollup the status page already depends on
(`status-checker.js:186-222`, `buildGroups`). The live example:
`monitors.json` has `Machine Learning Visualizer` (group `ML Visualizer`,
checked via the ARM container-app path) and `Machine Learning Visualizer
(Preview)` (same group, plain HTTP)
(`portfolio-webpage/application/server/src/database/data/monitors.json:12-26`).
One application, two sub-resources, is the correct shape here: a threshold
with `sub_resource = null` covers the whole `ML Visualizer` group, and a
threshold naming the preview's slug covers only that one monitor.

When `monitor.group` is empty (most monitors - `group` defaults to `null`
on the Mongoose schema, `monitor.js:19-24`), `resource` falls back to the
slugified `monitor.name` and `sub_resource` is `null`.

### 3. `statusCode`, `error` and `runningStatus` are not carried - MongoDB stays

None of the three fits ADR 0003's envelope, which is numeric
(`MetricPoint`: `{name, value, unit, intervalSeconds, timestamp}`,
`packages/db/migrations/0003_metrics_hypertable.sql:5-14`). `statusCode` is
a label whose `avg()` across a compressed chunk means nothing (averaging
`200` and `503` produces a number that describes neither response). `error`
and `runningStatus` are strings; there is no numeric point to make from
either.

So MongoDB remains the incident-detail store, and the public status page
keeps reading it directly - nothing about this ADR changes
`status-checker.js` or its read path.

This is why the integration is a **dual-write, not a repoint**, and that is
a deliberate deviation from Task 11 / issue #12: that task could replace
the VPS agent's Append Blob sink outright, because nothing else consumed
that blob once the metrics endpoint existed. `MonitorCheck` has a consumer
Metrion does not replace - the public status page's incident detail (status
codes, error text, the ARM running-status label) - so the checker keeps
writing MongoDB exactly as it does today, and gains a second write to
Metrion's ingest endpoint alongside it. Record this so nobody "finishes the
job" later by deleting the Mongo write once the Metrion write exists.

### 4. `uptime.latency` is emitted only when `runningStatus IS NULL`

Container-app monitors checked through Azure ARM never issue an HTTP
request - that is by design, to avoid waking a scale-to-zero app
(`monitor.js:25-37`, `containerApp.scaleToZero`). For those checks,
`latencyMs` measures the ARM control-plane query's round trip, not the
monitored application's response time. `runningStatus` is set only on that
path (`monitor-check.js:18-20`: "Set only for container-app monitors"), so
it is an exact discriminator between the two kinds of measurement, not a
heuristic.

Averaging ARM-query latency together with real HTTP response latency in one
series produces a number that describes neither. `uptime.latency` is
therefore only emitted when the check that produced the row has
`runningStatus IS NULL` - a plain HTTP probe. `uptime.ok` is unaffected and
is always emitted, from either kind of check: "is it up" is a valid question
regardless of how the check was performed, "how fast did it respond" is
only a valid question for the checks that actually sent a request.

### 5. `interval_seconds = 60` is a nominal declaration, not a measured cadence

`status-checker.js:9-14` already documents the trap this decision exists to
avoid: Azure's timer trigger replays ticks it thinks it missed, so a real
day holds roughly 1,700 samples against a schedule of 1,440 - `CHECK_MS` is
"only ever a display hint," and nothing in that file divides by it.

`interval_seconds` on the emitted `uptime.*` points is set to the nominal
`60` for the same reason `MetricEnvelope.metrics[].intervalSeconds` exists
at all (ADR 0003) - it is a declared cadence, carried for display and for
senders whose real cadence is steady. **No consumer may compute uptime as
passed ÷ (window ÷ interval_seconds)** from this field. That is precisely
the mistake `status-checker.js`'s own comment names as already having
shipped and been fixed once (the old form "divided by span/CHECK_MS and
clamped... because the checker really writes ~1700 samples a day against an
assumed 1440, every ratio landed above 1 and clamped," `status-checker.js:
101-106`). `avg(uptime.ok)` is immune to this drift by construction - it
divides by the count of rows that actually exist in the window, never by an
assumed count - which is a second, independent reason (alongside decision 1)
for the 0/1 encoding rather than a derived percentage.

## Consequences

- `uptime.ok` and `uptime.latency` land in the same hypertable, the same
  `metrics_hourly` continuous aggregate, and the same retention/compression
  policy as every other metric (ADR 0004) - no new query path, no new
  rollup.
- The status page's own uptime definition and Metrion's are the same
  formula (decision 1), so they cannot silently drift into reporting two
  different percentages for the same underlying checks.
- MongoDB is not being retired by this ADR. `MonitorCheckModel` keeps being
  written and read exactly as today; this integration only adds a second
  write. A future task that wants to drop the Mongo write needs its own ADR
  amending decision 3, not a quiet deletion.
- Any dashboard or threshold reading `uptime.latency` is reading real HTTP
  response time only - container-app monitors on the ARM path contribute
  `uptime.ok` but never `uptime.latency` (decision 4).
- No consumer of `interval_seconds` on these points may use it as a divisor
  (decision 5); this is the same constraint `status-checker.js` already
  lives under, now stated for Metrion's readers too.

### Future direction: no generic uptime checker in Metrion yet

Nothing in this ADR gives a Metrion tenant a way to register an arbitrary
URL for Metrion itself to poll. Letting a tenant supply a URL and having
Metrion's own infrastructure issue the outbound HTTP request means Metrion
becomes the one sending requests to an address the tenant chose - a cloud
provider's instance-metadata endpoint, `127.0.0.1` and other loopback/RFC
1918 ranges, or a Postgres port on some third party's host (the same class
of destination issue #8's amended scope already flags as a concern for
this project). At best that is Metrion's infrastructure probing addresses
it has no business reaching from the outside; at worst it turns Metrion
into a request amplifier against a third party who never consented to being
probed by anyone.

Closing that gap safely needs an egress allowlist, a proxy the checker's
outbound traffic is forced through, and abuse controls (rate limits, target
validation, likely a moderation/reporting path) - that is a security
project in its own right, not a feature to bolt onto this ADR's mapping.
Until it exists, the only checker Metrion's ingest endpoint needs to accept
data from is the one that already exists: the portfolio's own Azure
Function, which this ADR's dual-write (decision 3) covers completely for
the one tenant who currently needs uptime data at all.

### Future direction: `uptime.ok` / `uptime.latency` are a public convention

Metrion is multi-tenant, and any tenant's own checker - not just the
portfolio's Azure Function - can point at the ingest endpoint with its own
API key. `uptime.ok` (0/1, `boolean`) and `uptime.latency` (`ms`) are
therefore not this integration's private naming choice; they are the
convention every tenant's checker should emit under, so a second tenant's
uptime data renders on the same charts and passes the same thresholds
without Metrion special-casing whoever showed up first. This belongs in the
ingest quickstart docs (issue #10, already amended in a prior round to
carry this exact convention) rather than living only in this ADR and this
codebase's own agent.

### 2026-09-30: uptime monitoring turned out to be the forcing function for the threshold/evaluator work

Everything that made `applications/evaluator` worth finishing in this round

- the duplicate-writer bug (Task 6), the false-alarm-prone default
threshold values (Task 7, `applications/evaluator/tests/uptime-alerting.test.ts`),
production values actually matching what was proven (Task 8,
`organizational/uptime-alerting.md`), and the first real dry-run deployment
(Task 9) - was uptime, not any of the container-resource metrics this ADR's
envelope was originally designed to carry. `uptime.ok`'s 0/1 shape made the
false-alarm mechanism (a window mean with too few samples) both easy to get
wrong and easy to prove correct once tested; CPU/memory thresholds, already
seeded and unaffected by any of this round's tasks, never surfaced the same
problem because their bounds aren't derived from an average of a boolean
series.
</content>
