import { fetchProjectStatus, type Status } from '../api/client.ts';
import { useLoader } from '../lib/use-loader.ts';
import { worseStatus } from '../lib/status.ts';
import { StatusBadge } from './status-badge.tsx';

/**
 * The dashboard project card's status indicator - the worst `effectiveStatus`
 * across every application in the project, folded client-side with
 * `worseStatus` since `GET /projects/:id/status` answers per-application, not
 * per-project. One request per row, firing in parallel on mount.
 *
 * ponytail: fine at the "a dozen applications, a handful of projects" scale
 * this whole feature is sized for (`status-service.ts`'s own comment); a
 * dashboard with many projects would want the status list to batch this
 * itself rather than one row firing its own request.
 *
 * Loading and error both render nothing rather than a spinner or a retry
 * button on every row - a project list is scanned quickly, and a secondary
 * badge briefly missing is not the same failure as the project itself
 * failing to load (`ProjectsLoading`/`ErrorState` in `dashboard.tsx` still
 * cover that).
 */
export function ProjectStatusIndicator({ projectId }: { projectId: string }) {
  const status = useLoader(`project-status/${projectId}`, (signal) =>
    fetchProjectStatus(projectId, signal),
  );

  if (status.phase !== 'ready' || !status.data || status.data.length === 0) return null;

  const worst: Status = status.data.reduce(
    (acc: Status, app) => worseStatus(acc, app.effectiveStatus),
    'ok',
  );
  return <StatusBadge status={worst} />;
}
