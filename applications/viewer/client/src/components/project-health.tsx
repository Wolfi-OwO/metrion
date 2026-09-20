import { useEffect } from 'react';
import { fetchProjectStatus, type ApplicationStatus, type Status } from '../api/client.ts';
import { summariseApplications } from '../lib/status.ts';
import { useInView } from '../lib/use-in-view.ts';
import { useLoader } from '../lib/use-loader.ts';
import { StatusBadge } from './status-badge.tsx';

/**
 * One dashboard row's health, folded from the per-project status call the API
 * already offers - there is no summary endpoint, and this does not add one.
 *
 * ponytail: still one request per row, bounded two ways. Rows only request once
 * they are near the viewport (`useInView`), and a settled answer is shared for
 * 30 seconds, so navigating dashboard -> project -> back does not refetch every
 * row. Upgrade path is a `GET /projects/summary` that answers for all of them
 * in one query (a server change, so a coder task rather than a design one).
 */

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: Promise<ApplicationStatus[]> }>();

// The loader's own AbortSignal is deliberately not forwarded: the promise is
// shared between callers, and under StrictMode the first caller is aborted
// before the second arrives, which would hand the second an aborted request.
function fetchCached(projectId: string): Promise<ApplicationStatus[]> {
  const hit = cache.get(projectId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = fetchProjectStatus(projectId, new AbortController().signal);
  cache.set(projectId, { at: Date.now(), value });
  // A failed or aborted request must not be served to the next caller.
  value.catch(() => {
    if (cache.get(projectId)?.value === value) cache.delete(projectId);
  });
  return value;
}

export type ProjectStatusResult =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error' }
  | { readonly phase: 'ready'; readonly applications: readonly ApplicationStatus[] };

/**
 * A project's applications, fetched once the returned `ref` element is near the
 * viewport. `onReady` reports the settled list upward so the dashboard's summary
 * strip can add the rows up without a second round of requests.
 */
export function useProjectStatus<T extends Element>(
  projectId: string,
  onReady?: (projectId: string, applications: readonly ApplicationStatus[]) => void,
) {
  const [ref, inView] = useInView<T>();
  const status = useLoader(`project-status/${projectId}`, () => fetchCached(projectId), inView);
  const data = status.data;
  useEffect(() => {
    if (status.phase === 'ready' && data) onReady?.(projectId, data);
  }, [status.phase, data, projectId, onReady]);

  const result: ProjectStatusResult =
    status.phase === 'error'
      ? { phase: 'error' }
      : status.phase === 'ready' && data
        ? { phase: 'ready', applications: data }
        : { phase: 'loading' };
  return { ref, result };
}

const SEGMENT: Record<Status, string> = {
  critical: 'bg-status-critical',
  warning: 'bg-status-warning',
  ok: 'bg-status-ok',
};

/** "Postgres primary · 5 downstream affected", behind a status pill. */
export function HealthCell({ result }: { result: ProjectStatusResult }) {
  if (result.phase === 'error') {
    return <span className="text-label text-ink-3">Status unavailable</span>;
  }
  if (result.phase === 'loading') {
    return <span className="block h-5 w-40 rounded-control bg-raised" aria-hidden="true" />;
  }
  if (result.applications.length === 0) {
    return <span className="text-label text-ink-3">No applications registered yet</span>;
  }
  const summary = summariseApplications(result.applications);
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusBadge status={summary.worst} className="shrink-0" />
      <span className="min-w-0 truncate text-label text-ink-2">
        {summary.headline}
        {summary.detail && <span className="text-ink-3"> · {summary.detail}</span>}
      </span>
    </span>
  );
}

/** How many applications, and how they split by health, as one thin bar. The
 * bar is a redundant glance: the counts are in the text and the accessible
 * name, and the colours are never the only carrier. */
export function ApplicationsCell({ result }: { result: ProjectStatusResult }) {
  if (result.phase !== 'ready') {
    return <span className="block h-5 w-24 rounded-control bg-raised" aria-hidden="true" />;
  }
  const total = result.applications.length;
  if (total === 0) return <span className="text-label text-ink-3">-</span>;
  const summary = summariseApplications(result.applications);
  const parts = (['critical', 'warning', 'ok'] as const).filter((s) => summary.counts[s] > 0);
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className="text-label whitespace-nowrap text-ink-2">
        {total} {total === 1 ? 'application' : 'applications'}
      </span>
      <span
        role="img"
        aria-label={parts.map((s) => `${summary.counts[s]} ${s}`).join(', ')}
        className="flex h-2 w-16 shrink-0 gap-px overflow-hidden rounded-pill bg-raised"
      >
        {parts.map((s) => (
          <span
            key={s}
            className={SEGMENT[s]}
            style={{ width: `${(summary.counts[s] / total) * 100}%` }}
          />
        ))}
      </span>
    </span>
  );
}
