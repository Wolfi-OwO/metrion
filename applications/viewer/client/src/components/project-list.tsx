import { Link } from 'react-router-dom';
import { formatRelative, freshnessOf, type DashboardRow } from '../lib/dashboard.ts';
import { Ghost } from './ghost.tsx';
import { StatusIcon } from './icon.tsx';
import { FreshnessDot, HealthBar, Sparkline } from './project-visuals.tsx';
import { buttonClassName } from './states.tsx';

/**
 * The project list as one table-like surface. A row is a name, a verdict, a
 * split, a trend, a recency and two actions - six different kinds of fact, each
 * of which lines up with the same fact in the row above, so this is columns
 * from `xl` (1280px) and a stacked card below it. Cards for their own sake
 * would repeat the same facts in a different shape at every width.
 *
 * `COLUMNS` and `ROW` are shared by the header, the rows and the skeleton rows
 * so that all three are laid out by one grid definition.
 */
const COLUMNS = 'xl:grid-cols-[minmax(0,1.6fr)_6.5rem_minmax(0,1.1fr)_6rem_9rem_12rem]';
const ROW = `grid grid-cols-2 items-center gap-x-6 gap-y-3 px-4 py-4 xl:px-6 xl:py-3 ${COLUMNS}`;
const LIST = 'overflow-hidden rounded-surface border border-line bg-surface';

export function ListHeader() {
  const cell = 'text-meta font-medium text-ink-3';
  return (
    <div
      aria-hidden="true"
      className={`hidden items-center gap-x-6 border-b border-line px-6 py-2 xl:grid ${COLUMNS}`}
    >
      <span className={cell}>Project</span>
      <span className={cell}>Health</span>
      <span className={cell}>Applications</span>
      <span className={cell}>Last 24 h</span>
      <span className={cell}>Last data</span>
      <span />
    </div>
  );
}

const PILL = 'inline-flex items-center gap-1 rounded-pill py-px pr-2 pl-2 text-label font-medium';
const PILL_TONE = {
  ok: 'bg-status-ok/12 text-status-ok',
  warning: 'bg-status-warning/12 text-status-warning',
  critical: 'bg-status-critical/12 text-status-critical',
  unknown: 'bg-raised text-ink-2',
} as const;
const PILL_LABEL = {
  ok: 'OK',
  warning: 'Warning',
  critical: 'Critical',
  unknown: 'No apps',
} as const;

function ProjectRow({ row, now }: { row: DashboardRow; now: number }) {
  const { project, summary } = row;
  const created = new Date(project.createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const state = freshnessOf(summary?.lastSampleAt ?? null, now);
  const actionClass = buttonClassName('secondary', 'default', 'relative');
  return (
    <li className={`group relative transition-colors hover:bg-raised/60 ${ROW}`}>
      <div className="min-w-0">
        {/* The name link stretches over the whole row, so the row is the target;
            the two buttons below sit above it (`relative`). */}
        <Link
          to={`/projects/${project.id}`}
          className="block min-h-11 after:absolute after:inset-0 xl:min-h-0"
        >
          <span className="block truncate text-body font-medium text-ink">{project.name}</span>
          <span className="block truncate font-mono text-meta text-ink-3">{project.slug}</span>
        </Link>
      </div>

      <div className="justify-self-end xl:justify-self-start">
        {summary ? (
          <span className={`${PILL} ${PILL_TONE[summary.worst]}`}>
            {summary.worst !== 'unknown' && <StatusIcon status={summary.worst} />}
            {PILL_LABEL[summary.worst]}
          </span>
        ) : (
          <span className="text-label text-ink-3">Unavailable</span>
        )}
      </div>

      <div className="col-span-2 flex min-w-0 items-center gap-3 xl:col-span-1">
        {summary ? (
          <>
            <span className="text-label whitespace-nowrap text-ink-2">
              {summary.applicationCount === 0
                ? 'No applications'
                : `${summary.applicationCount} ${summary.applicationCount === 1 ? 'application' : 'applications'}`}
            </span>
            <HealthBar counts={summary.counts} className="min-w-8 flex-1 xl:max-w-24" />
          </>
        ) : (
          <span className="text-label text-ink-3">-</span>
        )}
      </div>

      <div>{summary && <Sparkline values={summary.activity24h} />}</div>

      <div className="min-w-0 justify-self-end text-right xl:justify-self-start xl:text-left">
        <p
          className={`flex items-center justify-end gap-2 text-label xl:justify-start ${state === 'stale' ? 'text-text-caution' : 'text-ink-2'}`}
        >
          {summary && <FreshnessDot state={state} />}
          {summary?.lastSampleAt ? (
            <time
              dateTime={summary.lastSampleAt}
              title={new Date(summary.lastSampleAt).toLocaleString()}
            >
              {formatRelative(now - Date.parse(summary.lastSampleAt))}
            </time>
          ) : (
            <span className="text-ink-3">{summary ? 'No data yet' : '-'}</span>
          )}
        </p>
        <p className="truncate text-meta text-ink-3">Created {created}</p>
      </div>

      <div className="col-span-2 grid grid-cols-2 gap-2 md:flex md:justify-end xl:col-span-1">
        <Link
          to={`/projects/${project.id}/status`}
          aria-label={`Open status for ${project.name}`}
          className={actionClass}
        >
          Open status
        </Link>
        <Link
          to={`/projects/${project.id}/settings`}
          aria-label={`Settings for ${project.name}`}
          className={actionClass}
        >
          Settings
        </Link>
      </div>
    </li>
  );
}

export function ProjectList({
  rows,
  now,
  detailed,
}: {
  rows: readonly DashboardRow[];
  now: number;
  /** False when the summary failed: there is no health to sort by and no dashed end to explain. */
  detailed: boolean;
}) {
  return (
    <>
      <div className={LIST}>
        <ListHeader />
        <ul aria-label="Projects" className="divide-y divide-line">
          {rows.map((row) => (
            <ProjectRow key={row.project.id} row={row} now={now} />
          ))}
        </ul>
      </div>
      {/* Explains the two things the drawing cannot say for itself: the order
          and the dashed end of every sparkline. */}
      {detailed && (
        <p className="mt-3 text-meta text-ink-3">
          Sorted by health, then latest data. Activity is samples per hour (UTC); the dashed end is
          the current hour, still filling.
        </p>
      )}
    </>
  );
}

function ProjectRowSkeleton() {
  return (
    <li aria-hidden="true" className={ROW}>
      <div className="min-h-11 min-w-0 xl:min-h-0">
        <div className="text-body">
          <Ghost className="w-40 max-w-full" />
        </div>
        <div className="text-meta">
          <Ghost className="w-24" />
        </div>
      </div>
      <div className="justify-self-end xl:justify-self-start">
        <span className={PILL}>
          <Ghost className="w-12" />
        </span>
      </div>
      <div className="col-span-2 flex min-w-0 items-center gap-3 xl:col-span-1">
        <span className="text-label">
          <Ghost className="w-20" />
        </span>
        <Ghost className="h-2 min-w-8 flex-1 rounded-pill xl:max-w-24" />
      </div>
      <div>
        <Ghost className="h-6 w-24" />
      </div>
      <div className="justify-self-end text-right xl:justify-self-start xl:text-left">
        <div className="text-label">
          <Ghost className="w-16" />
        </div>
        <div className="text-meta">
          <Ghost className="w-28" />
        </div>
      </div>
      <div className="col-span-2 grid grid-cols-2 gap-2 md:flex md:justify-end xl:col-span-1">
        <Ghost className="h-11 md:h-9 md:w-24" />
        <Ghost className="h-11 md:h-9 md:w-20" />
      </div>
    </li>
  );
}

export function ProjectListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className={LIST}>
      <ListHeader />
      <ul className="divide-y divide-line">
        {Array.from({ length: rows }, (_, index) => (
          <ProjectRowSkeleton key={index} />
        ))}
      </ul>
    </div>
  );
}
