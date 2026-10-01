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

  // --- container.cpu: re-anchored to each container's real CPU limit, not
  // the p95/p99-of-normal-load bounds this block used to seed. The metric
  // itself is % of ONE host core (`docker stats`' own CPU% formula,
  // applications/agent/src/collectors/docker-containers.ts:45) - it has no
  // relation to a container's configured `cpus:` limit, which was the
  // actual bug behind the flapping (179 `container.cpu` alert events across
  // fuwwy-platform/netviz/nutrilens/portfolio in ~33h). warning/critical
  // below are 50%/80% of each container's limit, expressed as %-of-one-core
  // (e.g. a 0.3-core limit -> warning 15, critical 24). window is 900s
  // (15 samples at 1/minute), not the old 300s/5-sample window - the same
  // precedent set by uptime.ok (see that block above): a 5-sample window
  // lets a single-minute burst dominate the mean.
  //
  // Limits are read from each app's real compose file, not derived:
  //   nutrilens  ~/.../nutrilens/docker-compose.prod.yml:
  //              nutrilens-blue/-green=0.3, nutrilens-ai=1.0, nutrilens-db=0.5
  //   portfolio  ~/.../portfolio-webpage/application/docker-compose.prod.yaml:
  //              portfolio-web-blue/-green=0.5, caddy=0.25, azurite=0.25
  //   netviz     ~/.../network-visualizer/application/docker-compose.prod.yml: 0.3
  //   fuwwy-platform's monitored containers are NOT in this repo - they run
  //   on the VPS as preussen-bot-prod / preussen-dashboard-blue/green-1,
  //   /opt/preussen/docker-compose.prod.yml, each cpus: 0.5
  //
  // Why the old p95-of-normal bounds flapped: measured against production,
  // preussen-bot-prod (fuwwy-platform's real container) sat at or above its
  // old warning line (3.8) for 12.75% of all minutes, and 82-92% of the old
  // breach-minutes across all four apps were driven by a single sample, not
  // a sustained load change - the old window was too short and the bound
  // too close to normal variance for `consecutive_breaches` to filter
  // either out.
  //
  // 7-day replay of real samples against these new bounds: 0 minutes
  // reached >=80% of the limit, and only 13 minutes reached >=50% (mostly
  // isolated single minutes, so consecutive_breaches=2 absorbs them without
  // committing a state change).
  //
  // ponytail: these rows have no automatic link to the compose files' own
  // `cpus:` values - if a container's limit ever changes, these warning/
  // critical numbers must be re-derived and re-seeded by hand.
  //
  // fuwwy-platform and netviz are single-container apps (one limit each,
  // 0.5 and 0.3 cores) so their project-wide (sub_resource IS NULL) rows
  // stay enabled, just re-pointed at the new bounds. nutrilens and
  // portfolio each run multiple containers at DIFFERENT limits, so a single
  // project-wide bound can't represent all of them - their old project-wide
  // rows are disabled (not deleted: a human may want the history) and
  // replaced by one row per sub_resource below.
  {
    app: 'fuwwy-platform',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 25,
    critical: 40,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.5 (preussen-bot-prod / preussen-dashboard-blue-1/green-1, /opt/preussen/docker-compose.prod.yml)',
  },
  {
    app: 'netviz',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 15,
    critical: 24,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.3 (network-visualizer/application/docker-compose.prod.yml)',
  },
  {
    app: 'nutrilens',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 9.8,
    critical: 17.1,
    window: 900,
    enabled: false,
    note: 'superseded by per-container rows below: limits differ (1.0/0.5/0.3 cores)',
  },
  {
    app: 'portfolio',
    sub: null,
    metric: 'container.cpu',
    direction: 'above',
    warning: 2.7,
    critical: 6.8,
    window: 900,
    enabled: false,
    note: 'superseded by per-container rows below: limits differ (0.5/0.25 cores)',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-ai-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 50,
    critical: 80,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 1.0 (nutrilens/docker-compose.prod.yml)',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-blue-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 15,
    critical: 24,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.3 (nutrilens/docker-compose.prod.yml)',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-green-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 15,
    critical: 24,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.3 (nutrilens/docker-compose.prod.yml)',
  },
  {
    app: 'nutrilens',
    sub: 'container:nutrilens-nutrilens-db-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 25,
    critical: 40,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.5 (nutrilens/docker-compose.prod.yml)',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-web-blue-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 25,
    critical: 40,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.5 (portfolio-webpage/application/docker-compose.prod.yaml)',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-web-green-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 25,
    critical: 40,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.5 (portfolio-webpage/application/docker-compose.prod.yaml)',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-caddy-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 12.5,
    critical: 20,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.25 (portfolio-webpage/application/docker-compose.prod.yaml)',
  },
  {
    app: 'portfolio',
    sub: 'container:portfolio-azurite-1',
    metric: 'container.cpu',
    direction: 'above',
    warning: 12.5,
    critical: 20,
    window: 900,
    enabled: true,
    note: '50/80% of measured cpus: limit 0.25 (portfolio-webpage/application/docker-compose.prod.yaml)',
  },

  // --- uptime.ok: faster detection (2026-10-01), superseding the
  // 900/0.9/0.8/2 values this block seeded previously (that history and its
  // full reasoning now live in organizational/uptime-alerting.md, "why
  // 0.9/0.8, not the originally-seeded 0.995/0.8" plus the dated update
  // below it - re-read both before changing these numbers again).
  // Production was moved by packages/db/migrations/0021_uptime_ok_faster_
  // detection.sql, not by re-running this script (ON CONFLICT DO NOTHING
  // never UPDATEs); this block exists so a FRESH database (CI, a new
  // environment) seeds directly at the current values instead of the old
  // ones plus a migration to walk it forward.
  //
  // User-accepted trade-off: consecutive_breaches dropped from 2 to 1, so a
  // growing outage now commits 'critical' on the FIRST cycle its candidate
  // differs from the stored state, not the second - detection in one ~5min
  // window instead of two ~15min ones. The cost: a 2-failure blip (e.g. a
  // container restart that fails exactly 2 consecutive checks before
  // returning) now alerts immediately, with no second-cycle confirmation
  // to absorb it. Accepted deliberately, not an oversight.
  //
  // warning=null removes the intermediate 'warning' state entirely
  // (evaluate.ts's candidateState: a null bound never matches, so
  // direction='below' with only critical_value set reads only 'ok' or
  // 'critical') - with consecutive_breaches=1 there is no second cycle left
  // for a warning step to occupy anyway.
  //
  // critical=0.7 and window=300 (down from 0.8/900) hold the same "one flap
  // stays silent, two flaps alert" property this metric has always needed,
  // re-derived for the new window size and re-checked across the sample-
  // count jitter a 300s window actually sees at the measured 1/minute
  // cadence (nominally 5 samples/window, but a cycle running slightly off
  // the collector's schedule can see 4 or 6): one failed check gives
  // avg=(N-1)/N = 0.75/0.8/0.8333 at N=4/5/6 - all >= 0.7, stays 'ok'; two
  // failed checks give avg=0.5/0.6/0.6667 at N=4/5/6 - all < 0.7, goes
  // 'critical' regardless of exact alignment. Recovery is the same test run
  // backward: the first cycle whose window again averages >= 0.7 commits
  // straight to 'ok'.
  //
  // applications/evaluator/tests/uptime-alerting.test.ts proves this at the
  // new values, including the 4/5/6-sample boundary case above - it does
  // NOT prove a 2-failure blip never happens in production, only that these
  // thresholds alert immediately when it does, which is the trade the user
  // accepted.
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
    warning: null,
    critical: 0.7,
    window: 300,
    breaches: 1,
    enabled: true,
    note: 'faster detection (2026-10-01, user-accepted trade-off): proven by applications/evaluator/tests/uptime-alerting.test.ts at the real 1/minute cadence across 4/5/6-sample window jitter - critical=0.7 + consecutive_breaches=1 commit in one cycle; warning=null drops the intermediate state. See organizational/uptime-alerting.md for the full history.',
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
          `window=${row.window}s breaches=${row.breaches ?? 2} enabled=${row.enabled}\n    ${row.note}`,
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
              warning_value, critical_value, window_seconds, consecutive_breaches, enabled)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
            row.breaches ?? 2,
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
