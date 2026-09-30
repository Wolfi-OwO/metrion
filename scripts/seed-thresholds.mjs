#!/usr/bin/env node
// Seeds the first `thresholds` rows for "Applications Server 01" so the
// evaluator (applications/evaluator, not deployed yet - see
// organizational/agent-deployment-runbook.md, "Threshold evaluator
// (issue #22)") has something to evaluate once it ships. Idempotent:
// `ON CONFLICT DO NOTHING` against the table's own
// `UNIQUE NULLS NOT DISTINCT (project_id, application_id, sub_resource,
// metric_name)` (packages/db/migrations/0007_thresholds_and_status.sql), so
// a re-run never touches a row a human has since hand-tuned. This script
// never UPDATEs or DELETEs an existing row - ON CONFLICT DO NOTHING is the
// only conflict action here, by design.
//
// Usage:
//   DATABASE_URL=<superuser DSN> node scripts/seed-thresholds.mjs [--dry-run|--apply]
// Defaults to --dry-run: prints every row + its resolved application UUID,
// opens no write transaction, exits 0.
import pg from 'pg';

const APPLY = process.argv.includes('--apply');

// -----------------------------------------------------------------------
// EXCLUDED - (application, metric) pairs deliberately left without a
// threshold, and the measured reason. Re-verify with the queries in the
// comments before ever adding one of these back.
//
// requests.count / requests.latency.avg / requests.status.* across
// fuwwy-platform, netviz, nutrilens, portfolio - dead. Measured
// (`select resource, name, max(time) from metrics where name like
// 'requests.%' group by 1,2`): every one of these 26 series' last sample is
// 2026-09-14, the latest across all four being 2026-09-14 16:36:00+00. A
// threshold's `candidateState` (applications/evaluator/src/evaluate.ts)
// returns critical/no_data for a series with a prior status row and no
// current data - seeding a threshold on a dead metric is a guaranteed,
// permanent false alarm, not a monitor. This is the collector regression
// documented in organizational/agent-deployment-runbook.md, not a
// deliberate removal.
//
// container.restarts / container.oomKilled - same regression, same last
// sample 2026-09-14 16:36:00+00 (`select resource, name, max(time) from
// metrics where name in ('container.restarts','container.oomKilled') group
// by 1,2`). Independently, a window avg() of a counter/boolean series is
// not a meaningful "above X" bound regardless of freshness - restarts and
// OOM kills want a rate-of-change or a "count > 0" check the current
// schema's `direction: above/below` on avg(value) cannot express.
//
// container.memory.limit - a per-container config constant, not a
// measurement to threshold. Verified `select resource, sub_resource,
// min(value), max(value) from metrics where name='container.memory.limit'
// group by 1,2`: every sub_resource has min = max (e.g.
// nutrilens/container:nutrilens-nutrilens-ai-1 is 2048/2048). It is the
// input the container.memory.used bounds below are derived from, not a
// target itself.
//
// deploy.probe - project "Deploy probe" (7cd08e44-a2dc-438e-993d-1ecb27f5fadf)
// has alerts_enabled=false, and the series itself is a constant liveness
// ping: measured 33 samples, value always 1.0, interval_seconds 86400
// (daily), last sample 2026-09-23 17:26:35+00. Nothing to bound.
//
// ml-visualizer's uptime.latency - dead since 2026-09-20. Measured 7-day
// daily averages before the flatline: 2026-09-14..2026-09-19 ranged
// 168-3112ms, then the series pins to a ~25000ms sentinel with
// uptime.idle's p50 = 1 (the app went idle). Its uptime.ok is still fresh
// and IS seeded below (list #1) - only uptime.latency is skipped here.
//
// vmi3556446 ("Contabo VPS", application id
// 8af01c4d-67cb-4540-8715-e476ed54502e) - never emitted anything. Measured
// `select count(*) from metrics where resource='vmi3556446'` = 0 and the
// same against `uptime_samples` = 0. No threshold possible; documented as
// an orphan finding in the runbook, not deleted here.
// -----------------------------------------------------------------------

// "Applications Server 01" - every application below lives in this one
// project. application_id itself is resolved from applications.key at
// query time, never hardcoded as a UUID.
const PROJECT_ID = '86b02c8c-4357-4655-9835-1897787cdd9a';

/**
 * One row per threshold. `app` is `applications.key` (== `metrics.resource`),
 * resolved to `application_id` below - never the UUID typed here directly.
 * `sub` is the literal `sub_resource` string from `metrics`/`container.memory.limit`,
 * or null for "every sub_resource of this application".
 */
const ROWS = [
  // --- container.memory.used: warning/critical are 80%/95% of each
  // scope's measured constant limit (container.memory.limit, min=max per
  // sub_resource - see EXCLUDED block above for the verification query).
  {
    app: 'fuwwy-platform',
    sub: null,
    metric: 'container.memory.used',
    direction: 'above',
    warning: 410,
    critical: 486,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 512 MiB (all 3 fuwwy-platform sub_resources: preussen-bot-prod, preussen-dashboard-blue-1/green-1, each min=max=512)',
  },
  {
    app: 'netviz',
    sub: null,
    metric: 'container.memory.used',
    direction: 'above',
    warning: 102.4,
    critical: 121.6,
    window: 300,
    enabled: false,
    note: 'disabled: netviz-blue-1 measured p50 110.5 MiB of measured constant limit 128 MiB = 86%, already above the 80% warning bound - would fire permanently',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-ai-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 1638,
    critical: 1946,
    window: 300,
    enabled: false,
    note: 'disabled: measured p95 1970 MiB of measured constant limit 2048 MiB = 96%, already above the 95% critical bound - would fire permanently',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-blue-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 102.4,
    critical: 121.6,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 128 MiB',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-db-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 410,
    critical: 486,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 512 MiB',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-green-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 102.4,
    critical: 121.6,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 128 MiB',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-azurite-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 204.8,
    critical: 243.2,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 256 MiB',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-caddy-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 102.4,
    critical: 121.6,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 128 MiB',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-web-blue-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 410,
    critical: 486,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 512 MiB',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-web-green-1',
    metric: 'container.memory.used',
    direction: 'above',
    warning: 410,
    critical: 486,
    window: 300,
    enabled: true,
    note: '80/95% of measured constant limit 512 MiB',
  },

  // --- container.cpu: re-derived from window-mean percentiles (the
  // evaluator's own aggregateWindow does avg(value) over window_seconds,
  // not raw-sample percentiles), per the query in Task A2. Measured
  // against production, 7-day window, 300s buckets, 2026-09-26:
  //   fuwwy-platform  p95_of_means=3.8   p99_of_means=7.6   max_mean=24.9
  //   netviz          p95_of_means=10.4  p99_of_means=16.0  max_mean=25.6
  //   nutrilens       p95_of_means=9.8   p99_of_means=17.1  max_mean=42.1
  //   portfolio       p95_of_means=2.7   p99_of_means=6.8   max_mean=32.6
  {
    app: 'fuwwy-platform',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 3.8,
    critical: 7.6,
    window: 300,
    enabled: true,
    note: 'window-mean p95_of_means=3.8, p99_of_means=7.6 (7-day, 300s buckets)',
  },
  {
    app: 'netviz',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 10.4,
    critical: 16.0,
    window: 300,
    enabled: true,
    note: 'window-mean p95_of_means=10.4, p99_of_means=16.0 (7-day, 300s buckets)',
  },
  {
    app: 'nutrilens',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 9.8,
    critical: 17.1,
    window: 300,
    enabled: true,
    note: 'window-mean p95_of_means=9.8, p99_of_means=17.1 (7-day, 300s buckets)',
  },
  {
    app: 'portfolio',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 2.7,
    critical: 6.8,
    window: 300,
    enabled: true,
    note: 'window-mean p95_of_means=2.7, p99_of_means=6.8 (7-day, 300s buckets)',
  },

  // --- uptime.ok: tuned and proven by
  // applications/evaluator/tests/uptime-alerting.test.ts, not derived from
  // the severityFor convention this originally copied. That convention's
  // 0.995 warning bound FAILS the issue's own requirement: at the real
  // measured cadence (Task 6, organizational/uptime-sources.md, 1
  // sample/minute per key) a window_seconds=900 window holds 15 samples, so
  // one single failed check among otherwise-passing ones reads
  // avg=14/15=0.9333 - already below 0.995, so a single flap would have
  // sent a false warning email every time. The GitHub issue's own suggested
  // 300s/0.99 has the identical problem at 5 samples (one flap = 0.8,
  // still below 0.99).
  //
  // warning=0.9 keeps a single flap (0.9333) inside 'ok'. critical=0.8 and
  // consecutive_breaches=2 (the thresholds table's own schema default,
  // unchanged) together collapse a growing outage's warning-then-critical
  // ramp into exactly one committed transition (hysteresis commits on
  // whatever the candidate is once two consecutive cycles differ from the
  // stored state, not once per distinct candidate value) and recovery's
  // critical-then-warning-then-ok ramp into exactly one recovery
  // transition - both proven in the test file above, not just asserted
  // here.
  ...[
    'netviz',
    'ml-visualizer',
    'ml-visualizer-preview',
    'nutrilens',
    'portfolio',
    'preussen',
    'status-page',
  ].map((app) => ({
    app,
    sub: null,
    metric: 'uptime.ok',
    direction: 'below',
    warning: 0.9,
    critical: 0.8,
    window: 900,
    enabled: true,
    note: 'proven by applications/evaluator/tests/uptime-alerting.test.ts at the real 1/minute cadence: warning=0.9 keeps one flapped check (avg 0.9333) in ok; critical=0.8 + consecutive_breaches=2 (schema default) give exactly one email for a sustained outage and exactly one recovery email',
  })),

  // --- uptime.latency: re-derived from window-mean percentiles, same
  // query/date as container.cpu above. ml-visualizer excluded (EXCLUDED
  // block above - dead since 2026-09-20); ml-visualizer-preview kept.
  //   netviz                 p95_of_means=1094.6  p99_of_means=5141.3
  //   nutrilens               p95_of_means=1125.4  p99_of_means=5160.3
  //   portfolio               p95_of_means=5058.4  p99_of_means=5840.5
  //   preussen                p95_of_means=686.4   p99_of_means=1259.8
  //   status-page             p95_of_means=618.9   p99_of_means=1103.6
  //   ml-visualizer-preview   p95_of_means=735.1    p99_of_means=1461.9
  {
    app: 'netviz',
    sub: null,
    metric: 'uptime.latency',
    direction: 'above',
    warning: 1094.6,
    critical: 5141.3,
    window: 900,
    enabled: true,
    note: 'window-mean p95_of_means=1094.6, p99_of_means=5141.3 (7-day, 300s buckets)',
  },
  {
    app: 'nutrilens',
    sub: null,
    metric: 'uptime.latency',
    direction: 'above',
    warning: 1125.4,
    critical: 5160.3,
    window: 900,
    enabled: true,
    note: 'window-mean p95_of_means=1125.4, p99_of_means=5160.3 (7-day, 300s buckets)',
  },
  {
    app: 'portfolio',
    sub: null,
    metric: 'uptime.latency',
    direction: 'above',
    warning: 5058.4,
    critical: 5840.5,
    window: 900,
    enabled: true,
    note: 'window-mean p95_of_means=5058.4, p99_of_means=5840.5 (7-day, 300s buckets)',
  },
  {
    app: 'preussen',
    sub: null,
    metric: 'uptime.latency',
    direction: 'above',
    warning: 686.4,
    critical: 1259.8,
    window: 900,
    enabled: true,
    note: 'window-mean p95_of_means=686.4, p99_of_means=1259.8 (7-day, 300s buckets)',
  },
  {
    app: 'status-page',
    sub: null,
    metric: 'uptime.latency',
    direction: 'above',
    warning: 618.9,
    critical: 1103.6,
    window: 900,
    enabled: true,
    note: 'window-mean p95_of_means=618.9, p99_of_means=1103.6 (7-day, 300s buckets)',
  },
  {
    app: 'ml-visualizer-preview',
    sub: null,
    metric: 'uptime.latency',
    direction: 'above',
    warning: 735.1,
    critical: 1461.9,
    window: 900,
    enabled: true,
    note: 'window-mean p95_of_means=735.1, p99_of_means=1461.9 (7-day, 300s buckets); NOT ml-visualizer itself, see EXCLUDED block',
  },
];

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }

  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const appKeys = [...new Set(ROWS.map((r) => r.app))];
    const { rows: appRows } = await pool.query(
      'SELECT key, id FROM applications WHERE project_id = $1 AND key = ANY($2::text[])',
      [PROJECT_ID, appKeys],
    );
    const appIdByKey = new Map(appRows.map((r) => [r.key, r.id]));

    const missing = appKeys.filter((k) => !appIdByKey.has(k));
    if (missing.length > 0) {
      throw new Error(
        `applications.key not found under project ${PROJECT_ID}: ${missing.join(', ')}`,
      );
    }

    console.log(`${ROWS.length} threshold rows resolved:\n`);
    for (const row of ROWS) {
      const appId = appIdByKey.get(row.app);
      console.log(
        `  ${row.app} (${appId}) ${row.sub ?? '(all sub_resources)'} ${row.metric} ` +
          `${row.direction} warning=${row.warning} critical=${row.critical} ` +
          `window=${row.window}s enabled=${row.enabled}\n    ${row.note}`,
      );
    }

    if (!APPLY) {
      console.log('\ndry run - nothing written. Pass --apply to insert.');
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      let inserted = 0;
      for (const row of ROWS) {
        const { rowCount } = await client.query(
          `INSERT INTO thresholds
             (project_id, application_id, sub_resource, metric_name, direction,
              warning_value, critical_value, window_seconds, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT DO NOTHING`,
          [
            PROJECT_ID,
            appIdByKey.get(row.app),
            row.sub,
            row.metric,
            row.direction,
            row.warning,
            row.critical,
            row.window,
            row.enabled,
          ],
        );
        inserted += rowCount;
      }
      await client.query('COMMIT');
      console.log(
        `\ninserted ${inserted} new row(s), ${ROWS.length - inserted} already present (ON CONFLICT DO NOTHING).`,
      );
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
