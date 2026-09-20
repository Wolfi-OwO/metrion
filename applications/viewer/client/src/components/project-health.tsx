import { fetchProjectStatus, type ApplicationStatus } from '../api/client.ts';
import { useInView } from '../lib/use-in-view.ts';
import { useLoader } from '../lib/use-loader.ts';
import { summariseApplications } from '../lib/status.ts';
import { StatusBadge } from './status-badge.tsx';

/**
 * One dashboard row's health line, folded from the per-project status call the
 * API already offers - there is no summary endpoint, and this does not add
 * one. It answers the question a project list exists for ("is anything on
 * fire, and what?") instead of repeating a bare badge:
 *
 *   [Critical]  Postgres primary · 4 downstream affected
 *   [OK]        8 applications healthy
 *
 * ponytail: still one request per row, now bounded two ways. Rows only
 * request once they are near the viewport (`useInView`), and a settled answer
 * is shared for 30 seconds, so navigating dashboard -> project -> back does
 * not refetch every row. Upgrade path is a `GET /projects/summary` that
 * answers for all of them in one query (needs a server change, so it is a
 * coder task, not a design one).
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

export function ProjectHealth({ projectId }: { projectId: string }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const status = useLoader(`project-status/${projectId}`, () => fetchCached(projectId), inView);

  let body: React.ReactNode;
  if (status.phase === 'error') {
    body = <span className="text-label text-ink-3">Status unavailable</span>;
  } else if (status.phase !== 'ready' || !status.data) {
    body = <span className="h-4 w-40 rounded-control bg-raised" aria-hidden="true" />;
  } else if (status.data.length === 0) {
    body = <span className="text-label text-ink-3">No applications registered yet</span>;
  } else {
    const summary = summariseApplications(status.data);
    body = (
      <>
        <StatusBadge status={summary.worst} className="shrink-0" />
        <span className="min-w-0 truncate text-label text-ink-2">
          {summary.headline}
          {summary.detail && <span className="text-ink-3"> · {summary.detail}</span>}
        </span>
      </>
    );
  }

  return (
    <div ref={ref} className="flex min-h-5 min-w-0 items-center gap-2">
      {body}
    </div>
  );
}
