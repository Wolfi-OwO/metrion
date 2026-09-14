import type { Pool } from 'pg';

export type State = 'ok' | 'warning' | 'critical';
export type Reason = 'threshold' | 'no_data';

export interface Threshold {
  id: string;
  projectId: string;
  projectName: string;
  ownerEmail: string;
  alertsEnabled: boolean;
  applicationId: string | null;
  /** `applications.key` == `metrics.resource`, null when `applicationId` is null (every application). */
  applicationKey: string | null;
  /** `applications.display_name ?? applications.key`, or a fixed label for a project-wide threshold. */
  applicationLabel: string;
  subResource: string | null;
  metricName: string;
  direction: 'above' | 'below';
  warningValue: number | null;
  criticalValue: number | null;
  consecutiveBreaches: number;
  windowSeconds: number;
}

interface Aggregate {
  subResourceKey: string;
  avgValue: number;
  sampleCount: number;
}

interface StoredStatus {
  subResourceKey: string;
  state: State;
  reason: Reason;
  breachCount: number;
}

/** One row this cycle committed to `threshold_status` + inserted into `status_events`. */
export interface CommittedEvent {
  eventId: number;
  projectId: string;
  projectName: string;
  ownerEmail: string;
  alertsEnabled: boolean;
  thresholdId: string;
  subResourceKey: string;
  applicationId: string | null;
  applicationLabel: string;
  metricName: string;
  fromState: State;
  toState: State;
  reason: Reason;
  value: number | null;
  at: Date;
  /** Correlation defaults - `src/correlate.ts` overwrites both after this cycle's events are known. */
  rootCause: boolean;
  causedByApplicationId: string | null;
  causedByLabel: string | null;
}

/**
 * Candidate state from `direction` + bounds, per the issue's step 3/4. A
 * null bound never matches. `aggregate` is `null`/`sampleCount === 0` when
 * this cycle's window had no matching metrics - `no_data` fires only when
 * `hasPriorStatus` is true, so a threshold that has never seen data stays
 * `ok` rather than immediately alerting.
 */
export function candidateState(
  threshold: Pick<Threshold, 'direction' | 'warningValue' | 'criticalValue'>,
  aggregate: Aggregate | null,
  hasPriorStatus: boolean,
): { state: State; reason: Reason; value: number | null } {
  if (!aggregate || aggregate.sampleCount === 0) {
    return hasPriorStatus
      ? { state: 'critical', reason: 'no_data', value: null }
      : { state: 'ok', reason: 'threshold', value: null };
  }

  const value = aggregate.avgValue;
  const { direction, warningValue, criticalValue } = threshold;
  let state: State = 'ok';
  if (direction === 'above') {
    if (criticalValue !== null && value >= criticalValue) state = 'critical';
    else if (warningValue !== null && value >= warningValue) state = 'warning';
  } else {
    if (criticalValue !== null && value <= criticalValue) state = 'critical';
    else if (warningValue !== null && value <= warningValue) state = 'warning';
  }
  return { state, reason: 'threshold', value };
}

/**
 * Hysteresis, per the issue's step 5: a candidate different from the stored
 * state increments `breachCount`; the change only commits once it reaches
 * `consecutiveBreaches`, at which point the counter resets for the next
 * transition. A candidate matching the stored state resets the counter
 * immediately - a single stray reading back toward the old state does not
 * keep a breach streak alive.
 */
export function applyHysteresis(
  storedState: State,
  storedBreachCount: number,
  candidate: State,
  consecutiveBreaches: number,
): { commit: boolean; nextState: State; nextBreachCount: number } {
  if (candidate === storedState) {
    return { commit: false, nextState: storedState, nextBreachCount: 0 };
  }
  const nextBreachCount = storedBreachCount + 1;
  if (nextBreachCount >= consecutiveBreaches) {
    return { commit: true, nextState: candidate, nextBreachCount: 0 };
  }
  return { commit: false, nextState: storedState, nextBreachCount };
}

async function selectEnabledThresholds(pool: Pool): Promise<Threshold[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.project_id, p.name AS project_name, u.email AS owner_email,
            p.alerts_enabled,
            t.application_id, a.key AS application_key, a.display_name AS application_display_name,
            t.sub_resource, t.metric_name, t.direction,
            t.warning_value, t.critical_value, t.consecutive_breaches, t.window_seconds
     FROM thresholds t
     JOIN projects p ON p.id = t.project_id
     JOIN users u ON u.id = p.owner_user_id
     LEFT JOIN applications a ON a.id = t.application_id
     WHERE t.enabled = true`,
  );
  return rows.map((row) => ({
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name,
    ownerEmail: row.owner_email,
    alertsEnabled: row.alerts_enabled,
    applicationId: row.application_id,
    applicationKey: row.application_key,
    applicationLabel: row.application_display_name ?? row.application_key ?? '(every application)',
    subResource: row.sub_resource,
    metricName: row.metric_name,
    direction: row.direction,
    warningValue: row.warning_value === null ? null : Number(row.warning_value),
    criticalValue: row.critical_value === null ? null : Number(row.critical_value),
    consecutiveBreaches: row.consecutive_breaches,
    windowSeconds: row.window_seconds,
  }));
}

/**
 * ponytail: one query per threshold (N+1); batch per project if a project
 * ever exceeds ~100 thresholds. `resource`/`sub_resource` filters are
 * skipped (matches everything) when the threshold itself has no scope on
 * that axis, per the schema's own "null = every application"/"null = every
 * sub_resource" convention.
 */
async function aggregateWindow(pool: Pool, threshold: Threshold): Promise<Aggregate[]> {
  const { rows } = await pool.query(
    `SELECT COALESCE(sub_resource, '') AS sub_resource_key,
            avg(value) AS avg_value, count(*)::int AS sample_count
     FROM metrics
     WHERE project_id = $1
       AND name = $2
       AND time >= now() - make_interval(secs => $3)
       AND ($4::text IS NULL OR resource = $4)
       AND ($5::text IS NULL OR sub_resource = $5)
     GROUP BY COALESCE(sub_resource, '')`,
    [
      threshold.projectId,
      threshold.metricName,
      threshold.windowSeconds,
      threshold.applicationKey,
      threshold.subResource,
    ],
  );
  return rows.map((row) => ({
    subResourceKey: row.sub_resource_key,
    avgValue: Number(row.avg_value),
    sampleCount: row.sample_count,
  }));
}

async function selectStoredStatuses(pool: Pool, thresholdId: string): Promise<StoredStatus[]> {
  const { rows } = await pool.query(
    `SELECT sub_resource_key, state, reason, breach_count FROM threshold_status WHERE threshold_id = $1`,
    [thresholdId],
  );
  return rows.map((row) => ({
    subResourceKey: row.sub_resource_key,
    state: row.state,
    reason: row.reason,
    breachCount: row.breach_count,
  }));
}

/**
 * Upserts the (threshold, sub_resource_key) row and, only when this cycle's
 * hysteresis commits a transition, appends a `status_events` row and
 * returns its id. `since` only moves forward when the committed state
 * actually changes - the `CASE` inside the upsert is what makes a re-run
 * with an unchanged state a no-op for that column.
 */
async function upsertStatus(
  pool: Pool,
  threshold: Threshold,
  subResourceKey: string,
  fromState: State,
  previousReason: Reason,
  candidate: { state: State; reason: Reason; value: number | null },
  hysteresis: { commit: boolean; nextState: State; nextBreachCount: number },
): Promise<CommittedEvent | null> {
  await pool.query(
    `INSERT INTO threshold_status (threshold_id, sub_resource_key, state, reason, value, breach_count, since, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (threshold_id, sub_resource_key) DO UPDATE SET
       state = EXCLUDED.state,
       reason = EXCLUDED.reason,
       value = EXCLUDED.value,
       breach_count = EXCLUDED.breach_count,
       since = CASE WHEN threshold_status.state <> EXCLUDED.state THEN now() ELSE threshold_status.since END,
       updated_at = now()`,
    [
      threshold.id,
      subResourceKey,
      hysteresis.nextState,
      // Reason only changes with the committed state - a mid-hysteresis
      // cycle keeps whatever reason the currently-committed state has.
      hysteresis.commit ? candidate.reason : previousReason,
      candidate.value,
      hysteresis.nextBreachCount,
    ],
  );

  if (!hysteresis.commit) return null;

  const {
    rows: [event],
  } = await pool.query(
    `INSERT INTO status_events (project_id, threshold_id, sub_resource_key, from_state, to_state, value, at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     RETURNING id, at`,
    [
      threshold.projectId,
      threshold.id,
      subResourceKey,
      fromState,
      hysteresis.nextState,
      candidate.value,
    ],
  );

  return {
    eventId: event.id,
    projectId: threshold.projectId,
    projectName: threshold.projectName,
    ownerEmail: threshold.ownerEmail,
    alertsEnabled: threshold.alertsEnabled,
    thresholdId: threshold.id,
    subResourceKey,
    applicationId: threshold.applicationId,
    applicationLabel: threshold.applicationLabel,
    metricName: threshold.metricName,
    fromState,
    toState: hysteresis.nextState,
    reason: candidate.reason,
    value: candidate.value,
    at: event.at,
    rootCause: true,
    causedByApplicationId: null,
    causedByLabel: null,
  };
}

/**
 * One evaluation cycle: every enabled threshold, its window aggregate, its
 * stored `threshold_status` rows, hysteresis, and the `status_events` rows
 * any committed transition produces. Root-cause attribution is NOT done
 * here - `src/correlate.ts` needs every threshold's post-cycle status
 * first, which only exists once this whole cycle has run.
 */
export async function runEvaluationCycle(pool: Pool): Promise<CommittedEvent[]> {
  const thresholds = await selectEnabledThresholds(pool);
  const events: CommittedEvent[] = [];

  for (const threshold of thresholds) {
    const [aggregates, stored] = await Promise.all([
      aggregateWindow(pool, threshold),
      selectStoredStatuses(pool, threshold.id),
    ]);

    const aggregateByKey = new Map(aggregates.map((row) => [row.subResourceKey, row]));
    const storedByKey = new Map(stored.map((row) => [row.subResourceKey, row]));
    const keys = new Set([...aggregateByKey.keys(), ...storedByKey.keys()]);

    for (const key of keys) {
      const storedRow = storedByKey.get(key);
      const candidate = candidateState(
        threshold,
        aggregateByKey.get(key) ?? null,
        storedRow !== undefined,
      );
      const fromState = storedRow?.state ?? 'ok';
      const hysteresis = applyHysteresis(
        fromState,
        storedRow?.breachCount ?? 0,
        candidate.state,
        threshold.consecutiveBreaches,
      );
      const event = await upsertStatus(
        pool,
        threshold,
        key,
        fromState,
        storedRow?.reason ?? 'threshold',
        candidate,
        hysteresis,
      );
      if (event) events.push(event);
    }
  }

  return events;
}

/** `DELETE FROM status_events WHERE at < now() - interval '180 days'`, run once per cycle. */
export async function pruneOldStatusEvents(pool: Pool, retentionDays: number): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM status_events WHERE at < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return rowCount ?? 0;
}
