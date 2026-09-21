#!/usr/bin/env node
// THROWAWAY. One-shot backfill of the portfolio's MongoDB `monitorchecks`
// history into Metrion's permanent `uptime_samples` (ADR 0009). Delete this
// file on 2026-11-01: by then Mongo's 90-day TTL (first erasures 2026-10-09)
// has passed, the Azure checker writes to Metrion directly, and the NDJSON
// export on the VPS is the archive of the old data.
//
// Contains no data and no secrets: the Mongo URI is read from the portfolio
// container's own environment and never printed.
//
// Run on the VPS as `deploy` (node 18 + docker access), one step at a time:
//
//   B=/opt/metrion/backup/portfolio-monitorchecks-$(date +%F).ndjson
//   # 1. export (inside the portfolio container, script piped on stdin)
//   c=$(docker ps --format '{{.Names}}' | grep '^portfolio-web-')
//   (umask 077; docker exec -i "$c" node --input-type=module - export < backfill-portfolio-uptime.mjs > "$B")
//   # 2. transform + load + rollup + report (idempotent: ON CONFLICT DO NOTHING)
//   node backfill-portfolio-uptime.mjs load "$B"
//   # 3. compare day-level uptime % (Mongo export vs uptime_daily), 2026-09-14..20
//   node backfill-portfolio-uptime.mjs verify "$B"
//
// Rollback: DELETE FROM uptime_samples WHERE interval_seconds = 60
//           AND time < '<cutover>'; then SELECT refresh_uptime_rollup(...).
// Mongo and the NDJSON file are never modified.
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';

const PROJECT_ID = '86b02c8c-4357-4655-9835-1897787cdd9a'; // Applications Server 01
const DB_CONTAINER = process.env.DB_CONTAINER ?? 'metrion-db-1';
const ROLLUP_FROM = '2026-07-11T00:00:00Z'; // earliest Mongo check

// Exact Mongo `monitors.name` -> Metrion resource key (ADR 0009). The export
// aborts on any monitor not listed here rather than guessing a key.
const NAME_TO_KEY = {
  'Network Visualizer': 'netviz',
  'Machine Learning Visualizer': 'ml-visualizer',
  'Machine Learning Visualizer (Preview)': 'ml-visualizer-preview',
  Portfolio: 'portfolio',
  'Status Page': 'status-page',
  'Preussen Web': 'preussen',
  nutrilens: 'nutrilens',
};

// ---- export: runs INSIDE the portfolio container ---------------------------
async function exportChecks() {
  const { default: mongoose } = await import('/app/node_modules/mongoose/index.js');
  await mongoose.connect(process.env.MONGODB_CONNECTION_STRING);
  try {
    const db = mongoose.connection.db;
    const names = new Map();
    for (const m of await db.collection('monitors').find({}).toArray()) {
      if (!(m.name in NAME_TO_KEY)) throw new Error(`monitor "${m.name}" has no key mapping`);
      names.set(String(m._id), m.name);
    }
    let n = 0;
    for await (const c of db.collection('monitorchecks').find({}).sort({ at: 1 })) {
      const monitorName = names.get(String(c.monitor));
      if (!monitorName) throw new Error(`check ${c._id} belongs to an unknown monitor`);
      const at = new Date(c.at);
      if (Number.isNaN(at.getTime())) throw new Error(`check ${c._id} has an invalid "at"`);
      const line =
        JSON.stringify({
          monitorName,
          at: at.toISOString(),
          ok: Boolean(c.ok),
          latencyMs: c.latencyMs ?? null,
          runningStatus: c.runningStatus ?? null,
        }) + '\n';
      if (!process.stdout.write(line)) await new Promise((r) => process.stdout.once('drain', r));
      n++;
    }
    console.error(`exported ${n} checks`);
  } finally {
    await mongoose.disconnect();
  }
}

// ---- transform: one check -> up to 3 sample rows ---------------------------
function* samplesOf(check) {
  const resource = NAME_TO_KEY[check.monitorName];
  if (!resource) throw new Error(`unmapped monitor "${check.monitorName}"`);
  yield [check.at, resource, 'uptime.ok', check.ok ? 1 : 0, 'boolean'];
  const arm = check.runningStatus != null;
  // The ARM control-plane check has no meaningful latency (same rule as the sink).
  if (!arm && Number.isFinite(check.latencyMs)) {
    yield [check.at, resource, 'uptime.latency', check.latencyMs, 'ms'];
  }
  if (arm)
    yield [
      check.at,
      resource,
      'uptime.idle',
      check.runningStatus === 'ScaledToZero' ? 1 : 0,
      'boolean',
    ];
}

async function readChecks(file, onCheck) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line) onCheck(JSON.parse(line));
}

// ---- psql through the db container -----------------------------------------
function psql(input, args = []) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'docker',
      [
        'exec',
        '-i',
        DB_CONTAINER,
        'psql',
        '-U',
        'metrion',
        '-d',
        'metrion',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        ...args,
      ],
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`psql exited ${code}`))));
    p.stdin.end(input);
  });
}
const query = (sql) => psql(sql, ['-At', '-F', ',']);

const REPORT_SQL = `
SELECT resource, name, count(*) AS rows, min(time)::date AS first_day, max(time)::date AS last_day
  FROM uptime_samples GROUP BY 1, 2 ORDER BY 1, 2;`;

async function load(file, until) {
  const rows = [];
  let checks = 0;
  await readChecks(file, (c) => {
    checks++;
    for (const r of samplesOf(c)) rows.push(r.join(','));
  });
  console.log(`${checks} checks -> ${rows.length} sample rows`);

  console.log('--- before ---');
  console.log(await psql(REPORT_SQL));

  // (iv) first, so the per-key cutover below sees every live 60 s row already
  // written to metrics. The 300 s VPS-vantage rows are kept as history; the
  // rollup ignores them (interval_seconds <= 60 rule).
  // (iii) then the Mongo rows strictly before each key's first authoritative
  // (interval_seconds = 60) row - or now() when there is none, or --until.
  // One transaction: all or nothing.
  const bound = until
    ? `'${until}'::timestamptz`
    : `coalesce((SELECT min(u.time) FROM uptime_samples u WHERE u.project_id = '${PROJECT_ID}'::uuid AND u.resource = s.resource AND u.interval_seconds = 60), now())`;
  const sql = `
BEGIN;
INSERT INTO uptime_samples (time, project_id, resource, name, value, unit, interval_seconds)
SELECT time, project_id, resource, name, value, unit, interval_seconds
  FROM metrics WHERE name LIKE 'uptime.%'
ON CONFLICT (project_id, resource, name, time) DO NOTHING;

CREATE TEMP TABLE stage (time timestamptz, resource text, name text, value double precision, unit text) ON COMMIT DROP;
\\copy stage FROM STDIN WITH (FORMAT csv)
${rows.join('\n')}
\\.
CREATE INDEX ON stage (resource);

INSERT INTO uptime_samples (time, project_id, resource, name, value, unit, interval_seconds)
SELECT s.time, '${PROJECT_ID}'::uuid, s.resource, s.name, s.value, s.unit, 60
  FROM stage s
 WHERE s.time < ${bound}
ON CONFLICT (project_id, resource, name, time) DO NOTHING;
COMMIT;
`;
  await psql(sql);

  console.log('--- rollup over the full span ---');
  await psql(`SELECT refresh_uptime_rollup('${ROLLUP_FROM}'::timestamptz, now());`);

  console.log('--- after (uptime_samples) ---');
  console.log(await psql(REPORT_SQL));
  console.log('--- uptime_daily per resource ---');
  console.log(
    await psql(
      'SELECT resource, count(*) AS days, min(day), max(day) FROM uptime_daily GROUP BY 1 ORDER BY 1;',
    ),
  );
  console.log('--- size ---');
  console.log(
    await psql(
      "SELECT pg_size_pretty(hypertable_size('uptime_samples')) AS total, (SELECT count(*) FROM uptime_samples) AS rows, (SELECT count(*) FROM uptime_incidents) AS incidents;",
    ),
  );
}

// ---- verify: Mongo-side vs uptime_daily, 2026-09-14 .. 2026-09-20 ----------
async function verify(file) {
  const acc = new Map(); // "resource|day" -> [up, total]
  await readChecks(file, (c) => {
    const key = `${NAME_TO_KEY[c.monitorName]}|${c.at.slice(0, 10)}`;
    const a = acc.get(key) ?? [0, 0];
    a[0] += c.ok ? 1 : 0;
    a[1] += 1;
    acc.set(key, a);
  });
  const db = new Map();
  for (const line of (
    await query(
      "SELECT resource, day, 100.0 * up_samples / total_samples FROM uptime_daily WHERE day BETWEEN '2026-09-14' AND '2026-09-20'",
    )
  )
    .trim()
    .split('\n')) {
    const [resource, day, pct] = line.split(',');
    db.set(`${resource}|${day}`, Number(pct));
  }
  let worst = 0;
  let missing = 0;
  for (const [key, [up, total]] of [...acc].sort()) {
    const day = key.split('|')[1];
    if (day < '2026-09-14' || day > '2026-09-20') continue;
    const mongo = (100 * up) / total;
    const metrion = db.get(key);
    if (metrion === undefined) {
      missing++;
      console.log(`${key}  mongo ${mongo.toFixed(3)}  metrion MISSING`);
      continue;
    }
    const diff = Math.abs(mongo - metrion);
    worst = Math.max(worst, diff);
    console.log(
      `${key}  mongo ${mongo.toFixed(3)}  metrion ${metrion.toFixed(3)}  diff ${diff.toFixed(3)}`,
    );
  }
  console.log(`worst diff ${worst.toFixed(3)} pp, missing ${missing}`);
  if (worst > 0.5 || missing > 0) process.exitCode = 1;
}

const [cmd, file, ...rest] = process.argv.slice(2);
if (cmd === 'export') await exportChecks();
else if (cmd === 'load' && file) {
  const i = rest.indexOf('--until');
  await load(file, i >= 0 ? rest[i + 1] : undefined);
} else if (cmd === 'verify' && file) await verify(file);
else {
  console.error('usage: export | load <ndjson> [--until <iso>] | verify <ndjson>');
  process.exitCode = 2;
}
