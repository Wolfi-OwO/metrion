import { fileURLToPath } from 'node:url';
import type { MetricEnvelope, VpsSample } from '@metrion/shared';
import { collectHostRequestStats } from './collectors/caddy-requests.js';
import { collectContainerSamples } from './collectors/docker-containers.js';
import { collectSystemSample } from './collectors/system.js';
import { config } from './config/index.js';
import { SampleQueue } from './lib/queue.js';
import { toMetricEnvelopes } from './lib/to-metric-envelopes.js';
import { sendEnvelopes } from './sink/http-post.js';

/**
 * One run: collect everything, map it to `MetricEnvelope[]` (one JSONL line
 * per run, see ADR 0003), then flush the local queue (this new line
 * included) to the ingest endpoint oldest-first. No `.listen()` in this app - it is a
 * systemd-timer one-shot, not an HTTP service - so this is the whole
 * "startup file", run directly by the timer's ExecStart.
 * Pure collection/aggregation logic lives in `collectors/`/`lib/` and is
 * importable (and imported, by the tests) without triggering any of this.
 */
export async function collectAndSend(): Promise<{
  sample: VpsSample;
  queuedAfter: number;
}> {
  const startedAt = process.hrtime.bigint();
  const cpuUsageAtStart = process.cpuUsage();
  const queue = new SampleQueue(config.stateDir, config.queue.maxLines);

  // Each collector degrades independently: a container list/stats hiccup or
  // a momentarily-restarting Caddy container (observed for real during
  // development) must not throw away the CPU/RAM/disk/network numbers that
  // DID succeed this minute - losing a fully-collectible sample over one
  // unrelated failure would be strictly worse than shipping it with an
  // empty `containers`/`requestsByHost`.
  const [system, containers, requestsByHost] = await Promise.all([
    collectSystemSample(config.stateDir, config.docker.socketPath),
    collectContainerSamples(config.docker.socketPath).catch((error: unknown) => {
      console.error(
        `Container metrics collection failed, reporting none for this minute: ${(error as Error).message}`,
      );
      return [];
    }),
    collectHostRequestStats(
      config.docker.socketPath,
      config.docker.caddyContainerName,
      `${config.stateDir}/caddy-log-cursor.json`,
    ).catch((error: unknown) => {
      console.error(
        `Caddy request-log collection failed, reporting none for this minute: ${(error as Error).message}`,
      );
      return {};
    }),
  ]);

  const timestamp = new Date();
  timestamp.setUTCSeconds(0, 0);

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const cpuUsageDelta = process.cpuUsage(cpuUsageAtStart);
  const cpuTimeMs = (cpuUsageDelta.user + cpuUsageDelta.system) / 1000;
  const maxRssMiB = process.resourceUsage().maxRSS / 1024;

  const sample: VpsSample = {
    timestamp: timestamp.toISOString(),
    host: config.host,
    cpu: system.cpu,
    memory: system.memory,
    disk: system.disk,
    network: system.network,
    containers,
    requestsByHost,
    collector: { durationMs, cpuTimeMs, maxRssMiB, queuedSamples: queue.size },
  };

  if (config.dryRun) {
    process.stdout.write(`${JSON.stringify(toMetricEnvelopes(sample))}\n`);
    return { sample, queuedAfter: 0 };
  }

  queue.push(JSON.stringify(toMetricEnvelopes(sample)));
  await flushQueue(queue);
  return { sample, queuedAfter: queue.size };
}

/**
 * A queued line is `JSON.stringify(MetricEnvelope[])` (`main.ts`'s own
 * `queue.push` call below). Returns `null` for anything unparseable rather
 * than throwing - the queue file on the live box could in principle still
 * hold a line from before this sink existed at the moment a new build is
 * deployed, and that must not wedge the flush.
 */
function parseQueuedLine(line: string): MetricEnvelope[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? (parsed as MetricEnvelope[]) : null;
}

/**
 * Sends every queued line, oldest first, stopping at the first failure so
 * order is preserved and a down ingest endpoint doesn't get hammered once
 * per queued line every run. `flushBudgetMs` bounds how long one run can
 * spend on this so a slow/degraded ingest endpoint never eats into the next
 * minute's timer.
 */
async function flushQueue(queue: SampleQueue): Promise<void> {
  const budgetEndsAt = Date.now() + config.queue.flushBudgetMs;
  const lines = queue.readAll();
  let sentCount = 0;

  for (const line of lines) {
    if (Date.now() >= budgetEndsAt) break;
    const envelopes = parseQueuedLine(line);
    if (envelopes === null) {
      // Dropped, not fatal - same policy as `SampleQueue.readAll`. Throwing
      // here would abort the flush before `replaceAll` runs, so one bad line
      // would wedge the queue permanently and nothing would ever be
      // delivered again.
      console.error('Dropping a queued line that is not a valid envelope array.');
      sentCount += 1;
      continue;
    }
    try {
      await sendEnvelopes(
        {
          ingestUrl: config.ingest.url,
          apiKey: config.ingest.apiKey,
          timeoutMs: config.ingest.sendTimeoutMs,
        },
        envelopes,
      );
      sentCount += 1;
    } catch (error) {
      console.error(
        `Ingest send failed, ${lines.length - sentCount} sample(s) staying queued: ${(error as Error).message}`,
      );
      break;
    }
  }

  queue.replaceAll(lines.slice(sentCount));
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  collectAndSend()
    .then(({ queuedAfter }) => {
      if (queuedAfter > 0) {
        console.error(`${queuedAfter} sample(s) still queued after this run.`);
      }
    })
    .catch((error: unknown) => {
      console.error('Collector run failed:', error);
      process.exitCode = 1;
    });
}
