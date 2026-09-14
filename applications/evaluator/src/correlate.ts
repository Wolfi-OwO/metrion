import type { Pool } from 'pg';
import type { CommittedEvent, State } from './evaluate.js';

const SEVERITY: Record<State, number> = { ok: 0, warning: 1, critical: 2 };

/** `dependentId -> Set<transitive depends_on_id>`, one project's whole graph. */
export type DependencyClosure = Map<string, Set<string>>;
/** `applicationId -> worst current state across that application's own thresholds.` */
export type ApplicationStatus = Map<string, State>;

/**
 * Transitive dependency closure via a recursive CTE over
 * `application_dependencies`, scoped to one project (edges never cross
 * projects - see the composite FKs in migration 0006). Empty graph in,
 * empty map out - callers must treat "no entry" as "no dependencies", which
 * is exactly what makes the whole feature degrade to "every event is a root
 * cause" when nobody has recorded an edge.
 */
export async function loadDependencyClosure(
  pool: Pool,
  projectId: string,
): Promise<DependencyClosure> {
  const { rows } = await pool.query(
    `WITH RECURSIVE closure AS (
       SELECT dependent_id, depends_on_id
       FROM application_dependencies
       WHERE project_id = $1
       UNION
       SELECT c.dependent_id, ad.depends_on_id
       FROM closure c
       JOIN application_dependencies ad ON ad.dependent_id = c.depends_on_id AND ad.project_id = $1
     )
     SELECT dependent_id, depends_on_id FROM closure`,
    [projectId],
  );

  const closure: DependencyClosure = new Map();
  for (const row of rows) {
    const set = closure.get(row.dependent_id) ?? new Set<string>();
    set.add(row.depends_on_id);
    closure.set(row.dependent_id, set);
  }
  return closure;
}

/**
 * Current status per application, worst-of across that application's own
 * (non-wildcard) thresholds. Read fresh, after `runEvaluationCycle` has
 * already committed this cycle's transitions, so a dependency that just
 * turned critical this same minute is visible to its dependents' events.
 */
export async function loadApplicationStatus(
  pool: Pool,
  projectId: string,
): Promise<ApplicationStatus> {
  const { rows } = await pool.query(
    `SELECT t.application_id, ts.state
     FROM threshold_status ts
     JOIN thresholds t ON t.id = ts.threshold_id
     WHERE t.project_id = $1 AND t.application_id IS NOT NULL`,
    [projectId],
  );

  const status: ApplicationStatus = new Map();
  for (const row of rows) {
    const current = status.get(row.application_id);
    if (!current || SEVERITY[row.state as State] > SEVERITY[current]) {
      status.set(row.application_id, row.state as State);
    }
  }
  return status;
}

/** `applicationId -> display_name ?? key`, for the "caused by X" label in the digest email. */
export async function loadApplicationLabels(
  pool: Pool,
  projectId: string,
): Promise<Map<string, string>> {
  const { rows } = await pool.query(
    `SELECT id, COALESCE(display_name, key) AS label FROM applications WHERE project_id = $1`,
    [projectId],
  );
  return new Map(rows.map((row) => [row.id, row.label]));
}

/**
 * The correlation rule (issue #22): a dependent's event is not the root
 * cause when any of its transitive dependencies is currently non-`ok`.
 * Colour still shows on the dependent (its own `status_events`/
 * `threshold_status` row is untouched) - only `root_cause`/
 * `caused_by_application_id` change, which is what stops the dependent from
 * also emailing.
 *
 * Wildcard thresholds (`applicationId === null`, "every application in the
 * project") have no single application to correlate against - the schema
 * has no per-event application column, only the threshold's own scope - so
 * they are always their own root cause. This is a real modelling
 * consequence of migration 0007's `status_events` shape, not a shortcut:
 * only application-scoped thresholds participate in correlation.
 *
 * Pure and synchronous: it only combines data the two loaders above already
 * fetched, so tests exercise it with plain fixtures and no database.
 */
export function attributeRootCause(
  events: CommittedEvent[],
  closure: DependencyClosure,
  appStatus: ApplicationStatus,
  applicationLabels: Map<string, string>,
): CommittedEvent[] {
  return events.map((event) => {
    if (!event.applicationId) return event;

    const dependencies = closure.get(event.applicationId);
    if (!dependencies || dependencies.size === 0) return event;

    const unhealthyDeps = [...dependencies].filter(
      (depId) => (appStatus.get(depId) ?? 'ok') !== 'ok',
    );
    if (unhealthyDeps.length === 0) return event;

    unhealthyDeps.sort((a, b) => {
      const bySeverity = SEVERITY[appStatus.get(b) ?? 'ok'] - SEVERITY[appStatus.get(a) ?? 'ok'];
      return bySeverity !== 0 ? bySeverity : a.localeCompare(b);
    });
    const causeId = unhealthyDeps[0] as string;

    return {
      ...event,
      rootCause: false,
      causedByApplicationId: causeId,
      causedByLabel: applicationLabels.get(causeId) ?? causeId,
    };
  });
}

/** Persists the attribution `attributeRootCause` computed, one row per changed event. */
export async function persistRootCause(pool: Pool, events: CommittedEvent[]): Promise<void> {
  for (const event of events) {
    if (event.rootCause) continue; // default in the DB already matches - nothing to update
    await pool.query(
      `UPDATE status_events SET root_cause = false, caused_by_application_id = $2 WHERE id = $1`,
      [event.eventId, event.causedByApplicationId],
    );
  }
}
