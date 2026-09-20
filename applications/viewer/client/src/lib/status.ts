import type { ApplicationStatus, Status } from '../api/client.ts';

/**
 * Small shared pieces `status-badge.tsx`, `dependency-graph.tsx` and
 * `project-status.tsx` all need, so "worse than" and "what a 409 cycle path
 * looks like" are decided once rather than re-derived per component.
 */

const RANK: Record<Status, number> = { ok: 0, warning: 1, critical: 2 };

/** Mirrors `worse()` in `status-service.ts` - used client-side to fold a
 * project's applications into one aggregate badge for the dashboard's
 * project card. */
export function worseStatus(a: Status, b: Status): Status {
  return RANK[b] > RANK[a] ? b : a;
}

export const STATUS_LABEL: Record<Status, string> = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
};

const CYCLE_PREFIX = 'Dependency cycle detected: ';

/**
 * `replaceDependencies`'s 409 (`applications.handlers.ts#findCyclePath`)
 * sends its whole answer as a plain-text `message`, not a structured field -
 * this is the one place that string is parsed back into the list of
 * application keys the offending path visits, so the cycle can be rendered
 * as a path instead of a generic "Conflict".
 */
export function cyclePathFromMessage(message: string): string[] | null {
  if (!message.startsWith(CYCLE_PREFIX)) return null;
  const path = message.slice(CYCLE_PREFIX.length).split(' -> ');
  return path.length > 1 ? path : null;
}

export interface ApplicationSummary {
  readonly worst: Status;
  /** "Postgres primary +1 more", or "8 applications healthy". */
  readonly headline: string;
  /** "5 downstream affected", when something is. */
  readonly detail: string | null;
  readonly counts: Record<Status, number>;
}

/**
 * One project's applications folded to the sentence a health line needs. A
 * root cause is an application that is unhealthy on its own account;
 * everything else that is unhealthy is being dragged down by something it
 * depends on. Shared by the dashboard rows and the status page's header so
 * the two cannot describe the same project differently.
 */
export function summariseApplications(apps: readonly ApplicationStatus[]): ApplicationSummary {
  const counts: Record<Status, number> = { ok: 0, warning: 0, critical: 0 };
  for (const app of apps) counts[app.effectiveStatus] += 1;
  const worst = apps.reduce<Status>((acc, app) => worseStatus(acc, app.effectiveStatus), 'ok');
  if (worst === 'ok') {
    return {
      worst,
      headline: `${apps.length} ${apps.length === 1 ? 'application' : 'applications'} healthy`,
      detail: null,
      counts,
    };
  }
  // A root cause is an application that is unhealthy on its own account;
  // everything else that is unhealthy is being dragged down by a dependency.
  const roots = apps.filter((app) => app.status !== 'ok' && app.causedBy === null);
  const affected = apps.filter((app) => app.effectiveStatus !== 'ok' && app.causedBy !== null);
  const first = roots.sort((a, b) => (a.status === b.status ? 0 : a.status === worst ? -1 : 1))[0];
  const name = first ? (first.displayName ?? first.key) : 'A dependency';
  const more = roots.length > 1 ? ` +${roots.length - 1} more` : '';
  return {
    worst,
    headline: `${name}${more}`,
    detail: affected.length > 0 ? `${affected.length} downstream affected` : null,
    counts,
  };
}
