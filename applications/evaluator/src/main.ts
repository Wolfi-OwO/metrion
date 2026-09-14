import { fileURLToPath } from 'node:url';
import { config } from './config/index.js';
import {
  attributeRootCause,
  loadApplicationLabels,
  loadApplicationStatus,
  loadDependencyClosure,
  persistRootCause,
} from './correlate.js';
import type { CommittedEvent } from './evaluate.js';
import { pruneOldStatusEvents, runEvaluationCycle } from './evaluate.js';
import { getPool } from './lib/db.js';
import { createRealTransport, createTestTransport, sendDigests } from './mailer.js';

export interface CycleResult {
  eventCount: number;
  rootCauseEventCount: number;
  prunedEventCount: number;
}

/**
 * One full minute-tick: evaluate every enabled threshold, correlate this
 * cycle's transitions against each affected project's dependency graph,
 * email root-cause digests, then prune old `status_events`. No `.listen()`
 * here - like `applications/agent`, this is a systemd-timer one-shot, so
 * this is the whole "startup file" run directly by the timer's ExecStart.
 * Single-owner (`flock -n` in the systemd unit, not in this code) is what
 * makes this safe to always run to completion rather than support overlap.
 */
export async function runCycle(pool = getPool()): Promise<CycleResult> {
  const events = await runEvaluationCycle(pool);

  // Correlation is scoped per project - each project's own dependency
  // graph, application statuses and labels only need to be fetched once
  // per cycle even though multiple thresholds in the same project may have
  // fired.
  const correlated: CommittedEvent[] = [];
  const projectIds = [...new Set(events.map((event) => event.projectId))];
  for (const projectId of projectIds) {
    const projectEvents = events.filter((event) => event.projectId === projectId);
    const [closure, appStatus, labels] = await Promise.all([
      loadDependencyClosure(pool, projectId),
      loadApplicationStatus(pool, projectId),
      loadApplicationLabels(pool, projectId),
    ]);
    correlated.push(...attributeRootCause(projectEvents, closure, appStatus, labels));
  }
  await persistRootCause(pool, correlated);

  const transport = config.dryRun ? createTestTransport() : createRealTransport(config.smtp);
  await sendDigests(
    pool,
    transport,
    {
      from: config.alertFrom,
      dailyEmailCap: config.quota.dailyEmailCap,
      cooldownMinutes: config.quota.cooldownMinutes,
    },
    correlated,
  );

  const prunedEventCount = await pruneOldStatusEvents(pool, config.statusEventRetentionDays);

  return {
    eventCount: correlated.length,
    rootCauseEventCount: correlated.filter((event) => event.rootCause).length,
    prunedEventCount,
  };
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);

if (isMainModule) {
  runCycle()
    .then((result) => {
      console.log(
        `Evaluation cycle complete: ${result.eventCount} transition(s), ${result.rootCauseEventCount} root-cause, ${result.prunedEventCount} old event(s) pruned.`,
      );
    })
    .catch((error: unknown) => {
      console.error('Evaluator cycle failed:', error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await getPool().end();
    });
}
