import { fetchStatusEvents, type ApplicationStatus, type Status } from '../api/client.ts';
import { formatTimestamp } from '../lib/format.ts';
import { useLoader } from '../lib/use-loader.ts';
import { StatusBadge } from './status-badge.tsx';

/** `GET /projects/:id/status/events` - `fromState`/`toState` are the same
 * three words as `Status`, just not typed that way on the wire (they come
 * straight out of a `text` column, `status-service.ts#StatusEventRow`); cast
 * at the one place this client renders them as a `StatusBadge`. */
function asStatus(value: string): Status {
  return value === 'warning' || value === 'critical' ? value : 'ok';
}

export function StatusEventsPanel({
  projectId,
  applications,
}: {
  projectId: string;
  applications: readonly ApplicationStatus[];
}) {
  const loader = useLoader(`status-events/${projectId}`, (signal) =>
    fetchStatusEvents(projectId, signal),
  );
  const appById = new Map(applications.map((app) => [app.id, app]));

  if (loader.phase === 'error' && loader.error) {
    return (
      <p role="alert" className="text-[13px] text-series-8">
        {loader.error.message}
      </p>
    );
  }
  if (loader.phase === 'loading' || loader.phase === 'waking') {
    return <p className="text-[13px] text-ink-dim">Loading recent transitions…</p>;
  }

  const events = loader.data ?? [];
  if (events.length === 0) {
    return (
      <p className="text-[13px] text-ink-dim">
        No transitions recorded yet - this fills in the first time a threshold's state changes.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line border-y border-line">
      {events.map((event) => {
        const app = event.applicationId ? appById.get(event.applicationId) : null;
        return (
          <li key={event.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 py-2.5">
            <span className="font-mono text-[12px] text-ink">
              {app ? (app.displayName ?? app.key) : 'project-wide'}
            </span>
            <span className="font-mono text-[11px] text-ink-muted">{event.metricName}</span>
            <span className="flex items-center gap-1.5">
              <StatusBadge status={asStatus(event.fromState)} />
              <span aria-hidden="true" className="text-ink-muted">
                →
              </span>
              <StatusBadge status={asStatus(event.toState)} />
            </span>
            <span className="ml-auto font-mono text-[11px] text-ink-muted">
              {formatTimestamp(Date.parse(event.at))}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
