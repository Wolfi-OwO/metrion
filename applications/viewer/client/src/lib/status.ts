import type { Status } from '../api/client.ts';

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
