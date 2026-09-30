#!/usr/bin/env node
// Transforms mongoexport'd `monitors.ndjson` + `checks.ndjson` into a TSV for
// `COPY metrics (time, project_id, resource, sub_resource, name, value, unit,
// interval_seconds) FROM STDIN` (text format, tabs, `\N` for NULL). Plain
// Node, no dependency — see scripts/uptime-backfill/README.md for the full
// three-stage (export/transform/load) procedure.
//
// RESOURCE MAPPING — deliberately NOT ADR 0007 section 2's original design.
// ADR 0007 ("resource = slugified monitor.group, sub_resource = slugified
// monitor.name") describes the design that was PLANNED, not what shipped.
// The actual dual-write code, portfolio-webpage's
// application/jobs/src/lib/metrion-sink.js (as of commit ffeaa57, "made the
// Metrion sink address monitors by key and emit uptime.idle for ARM
// checks"), addresses every monitor by its own explicit `metrionKey` field
// and never sets subResource at all — confirmed against
// metrion-sink.test.js's "no subResource" assertion and its own comment:
// deriving the key from group/name once folded Portfolio + Status Page into
// one averaged resource and lost Network Visualizer's own key. There is no
// slug function in the shipped code to copy — using ADR 0007's stale mapping
// here would put backfilled points under different resource keys than the
// live series and the two would never join, which is exactly the failure
// this task exists to avoid. So: resource = monitor.metrionKey, looked up
// from the exported monitors collection (never slugified, never read from
// the stale application/server/src/database/data/monitors.json seed file);
// sub_resource = always NULL, matching the live sink exactly.
//
// Only uptime.ok and uptime.latency are emitted (the two points this task's
// issue specifies). The live sink also emits a third point, uptime.idle,
// for ARM-checked monitors — left out here because the issue's mapping
// names only the two and a 90-day-old idle history has no open use case;
// noted as a scope cut in the README, not silently dropped.
//
// UPPER BOUND — a second clamp the issue text didn't anticipate. Task 26's
// dual-write has been live in production since before this task ran (its
// own `metrics` rows already exist for every one of these resources —
// measured, not assumed: see README.md's "live cutoffs" table). The 90-day
// lower clamp alone would re-load that overlap from Mongo, producing a
// second, duplicate set of points for every already-live timestamp — the
// exact corruption load.sh's idempotency guard exists to prevent, just via
// a different mechanism (overlap with the live writer instead of a second
// run of this script). So each resource also has its OWN upper bound: the
// measured timestamp of that resource's first live-written sample. A check
// at or after its resource's cutoff is skipped, not loaded — the live
// series already covers it.
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const [, , monitorsPath, checksPath, projectId, cutoffsPath] = process.argv;
if (!monitorsPath || !checksPath || !projectId || !cutoffsPath) {
  console.error(
    'usage: node transform.mjs <monitors.ndjson> <checks.ndjson> <project_id> <live-cutoffs.json> > points.tsv',
  );
  process.exit(1);
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId)) {
  console.error(`project_id does not look like a UUID, refusing to guess: ${projectId}`);
  process.exit(1);
}

// resource (metrionKey) -> ISO timestamp of that resource's first live
// sample already in `metrics`, i.e. the exclusive upper bound for this
// backfill. Measured with the query in README.md's "Live cutoffs" section,
// not derived. A resource with no entry has no known live-write boundary,
// so it's skipped rather than risking an overlap (see skippedNoCutoff).
const cutoffs = new Map(
  Object.entries(JSON.parse(await readFile(cutoffsPath, 'utf8'))).map(([resource, iso]) => [
    resource,
    Date.parse(iso),
  ]),
);

// Anything older than this would be dropped by the retention policy on its
// very next run (ADR 0004 / 0004_rollups_and_retention.sql: 90-day
// add_retention_policy) — loading it is pure waste, so it's clamped out here
// instead of landing in the hypertable for a few hours.
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const clampCutoff = Date.now() - NINETY_DAYS_MS;

// Driven from the exported `monitors` collection, never from
// portfolio-webpage's monitors.json seed — the seed is not the live list
// (ADR 0007 §3 names a real "Preussen Bot" document that existed in the
// database and not in the seed).
const monitors = new Map(); // oid string -> { name, metrionKey }
for (const line of (await readFile(monitorsPath, 'utf8')).split('\n')) {
  if (!line.trim()) continue;
  const doc = JSON.parse(line);
  monitors.set(doc._id.$oid, { name: doc.name, metrionKey: doc.metrionKey ?? null });
}

let read = 0;
let clamped = 0;
let clampedLiveOverlap = 0;
let skippedMissingMonitor = 0;
let skippedNoKey = 0;
let skippedNoCutoff = 0;
let written = 0;
const pairs = new Set();
const warnedUnknown = new Set();
const warnedNoCutoff = new Set();

function writeRow(time, resource, name, value, unit) {
  // resource/name/unit are all closed vocabularies here (metrionKey values,
  // literal metric names, literal units) — none can contain a tab/newline,
  // so no TSV escaping is needed beyond the fixed `\N` null marker below.
  process.stdout.write([time, projectId, resource, '\\N', name, value, unit, 60].join('\t') + '\n');
}

const rl = createInterface({ input: createReadStream(checksPath, 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  read += 1;
  const doc = JSON.parse(line);
  const monitorId = doc.monitor?.$oid;
  const monitor = monitorId ? monitors.get(monitorId) : undefined;

  if (!monitor) {
    skippedMissingMonitor += 1;
    if (monitorId && !warnedUnknown.has(monitorId)) {
      warnedUnknown.add(monitorId);
      console.error(
        `skip: check(s) reference unknown monitor ${monitorId} (no matching monitor document)`,
      );
    }
    continue;
  }
  if (!monitor.metrionKey) {
    skippedNoKey += 1;
    continue;
  }

  const at = Number(doc.at); // mongoexport renders the Number field as a JSON double, e.g. 1.783794600333E+12
  if (at < clampCutoff) {
    clamped += 1;
    continue;
  }

  const resource = monitor.metrionKey;
  const liveCutoff = cutoffs.get(resource);
  if (liveCutoff === undefined) {
    skippedNoCutoff += 1;
    if (!warnedNoCutoff.has(resource)) {
      warnedNoCutoff.add(resource);
      console.error(
        `skip: resource "${resource}" has no entry in the live-cutoffs file, refusing to guess its overlap boundary`,
      );
    }
    continue;
  }
  if (at >= liveCutoff) {
    clampedLiveOverlap += 1;
    continue;
  }

  const time = new Date(at).toISOString();
  pairs.add(resource);

  writeRow(time, resource, 'uptime.ok', doc.ok ? 1 : 0, 'boolean');
  written += 1;

  // Only a plain HTTP probe measures the monitored app's own latency — an
  // ARM check's latencyMs is the control-plane round trip (ADR 0007 §4).
  if (doc.runningStatus == null) {
    writeRow(time, resource, 'uptime.latency', Number(doc.latencyMs), 'ms');
    written += 1;
  }
}

console.error(
  `transform: rows_read=${read} clamped_older_than_90d=${clamped} clamped_live_overlap=${clampedLiveOverlap} ` +
    `skipped_missing_monitor=${skippedMissingMonitor} skipped_no_metrionKey=${skippedNoKey} ` +
    `skipped_no_cutoff=${skippedNoCutoff} points_written=${written}`,
);
console.error(
  `transform: (resource, sub_resource) pairs produced — eyeball against monitors.ndjson's metrionKey values: ` +
    [...pairs]
      .sort()
      .map((r) => `(${r}, null)`)
      .join(', '),
);
