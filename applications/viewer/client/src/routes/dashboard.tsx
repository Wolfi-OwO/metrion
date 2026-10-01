import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, createProject, type MeResponse, type Project } from '../api/client.ts';
import { AccountBar } from '../components/account-bar.tsx';
import { Field } from '../components/field.tsx';
import { OverviewBand, OverviewBandSkeleton } from '../components/overview-band.tsx';
import { ProjectList, ProjectListSkeleton } from '../components/project-list.tsx';
import { ProjectsEmpty } from '../components/projects-empty.tsx';
import { Button, ErrorState } from '../components/states.tsx';
import {
  buildRows,
  FILTER_MIN_PROJECTS,
  filterRows,
  sortRows,
  totalsOf,
  verdictOf,
} from '../lib/dashboard.ts';
import { useNow } from '../lib/use-now.ts';
import { useProjects, useProjectsSummary } from '../lib/use-projects.ts';
import { useRefreshTick } from '../lib/use-refresh-tick.ts';
import { projectNameError } from '../lib/validate.ts';
import type { ProjectSummary } from '../lib/summary.ts';

/**
 * Name only - `defaultResource` stays server-settable-only for now, not
 * exposed here. It has no effect until a key from this project actually
 * ingests something, so a field for it on the very first screen a user sees
 * would ask a question before there is anything to answer it against.
 */
function CreateProjectForm({
  onCreated,
  onCancel,
}: {
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fieldError = touched ? projectNameError(name) : null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (projectNameError(name)) return;

    setSubmitting(true);
    setSubmitError(null);
    const controller = new AbortController();
    createProject(name.trim(), controller.signal)
      .then(() => {
        setName('');
        setTouched(false);
        onCreated();
      })
      .catch((cause: unknown) => {
        setSubmitError(cause instanceof ApiError ? cause.message : 'Could not create the group.');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-6 flex flex-wrap items-end gap-3 rounded-surface border border-line bg-surface p-4"
    >
      <Field
        id="project-name"
        label="Group name"
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => setTouched(true)}
        error={fieldError}
        inputClassName="w-full sm:w-72"
      />
      <Button type="submit" loading={submitting}>
        {submitting ? 'Creating…' : 'Create group'}
      </Button>
      <Button variant="quiet" onClick={onCancel}>
        Cancel
      </Button>
      {submitError && (
        <p role="alert" className="w-full text-label text-text-danger">
          {submitError}
        </p>
      )}
    </form>
  );
}

/** Vertical rhythm of the screen: one step between the header, the band and the list. */
const SECTION = 'mt-6';

export default function DashboardRoute({
  user,
  onSignedOut,
}: {
  user: MeResponse;
  onSignedOut: () => void;
}) {
  const projects = useProjects();
  const summary = useProjectsSummary();
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);

  // Health only - the project list changes on user action (create a group),
  // which already reloads it, so polling it too would just repeat the same
  // request.
  const refreshTick = useRefreshTick();
  useEffect(() => {
    if (refreshTick > 0) summary.reload();
  }, [refreshTick, summary.reload]);

  const list = projects.data ?? [];
  const projectsBusy = projects.phase === 'loading' || projects.phase === 'waking';
  const summaryBusy = summary.phase === 'loading' || summary.phase === 'waking';
  const failed = projects.phase === 'error' && projects.error != null;
  // Hold the skeleton until the summary has answered too (it fails fast when
  // it fails): showing names first and health second would move every row.
  const isLoading = !failed && (projectsBusy || (summaryBusy && list.length > 0));
  const isEmpty = !failed && !projectsBusy && list.length === 0;
  const waking = projects.phase === 'waking' || summary.phase === 'waking';
  const seconds = Math.max(projects.elapsedSeconds, summary.elapsedSeconds);
  const showNew = !isLoading && !failed && !isEmpty && !showForm;
  // The filter lives in the header row, not in a row of its own above the
  // list: a toolbar row that only exists for long lists would push the list
  // down by its height the moment the data arrives.
  const filterable = !isLoading && !failed && list.length >= FILTER_MIN_PROJECTS;

  // "/" jumps to the filter, the convention of every tool with a long list.
  // Ignored while typing in any field and with a modifier held, so it never
  // steals a character or a browser shortcut.
  useEffect(() => {
    if (!filterable) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      event.preventDefault();
      filterRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [filterable]);

  return (
    <>
      <header className="border-b border-line bg-surface">
        <AccountBar email={user.email} onSignedOut={onSignedOut} />
      </header>
      <main className="flex-1">
        <div className="enter page py-8">
          <div className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-3 md:min-h-9">
            <h1 className="mr-auto text-page font-semibold tracking-tight text-ink">Groups</h1>
            {filterable && <ProjectFilter inputRef={filterRef} query={query} onChange={setQuery} />}
            {showNew && (
              <Button variant="primary" onClick={() => setShowForm(true)}>
                New group
              </Button>
            )}
          </div>

          {showForm && (
            <CreateProjectForm
              onCreated={() => {
                setShowForm(false);
                projects.reload();
                summary.reload();
              }}
              onCancel={() => setShowForm(false)}
            />
          )}

          {failed && (
            <div className={SECTION}>
              <ErrorState error={projects.error!} onRetry={projects.reload} what="groups" framed />
            </div>
          )}

          {isLoading && (
            <div aria-busy="true" className={SECTION}>
              <OverviewBandSkeleton waking={waking} seconds={seconds} />
              <div className={SECTION}>
                <ProjectListSkeleton />
              </div>
            </div>
          )}

          {isEmpty && (
            <div className={SECTION}>
              <ProjectsEmpty creating={showForm} onCreate={() => setShowForm(true)} />
            </div>
          )}

          {!isLoading && !failed && list.length > 0 && (
            <Loaded
              projects={list}
              query={query}
              onClearQuery={() => setQuery('')}
              summaries={summary.phase === 'ready' ? summary.data : null}
              onRetrySummary={summary.reload}
            />
          )}
        </div>
      </main>
    </>
  );
}

/**
 * The populated screen. Its own component so the one-second clock re-renders
 * only this, and so the empty, loading and error branches above never start a
 * timer.
 *
 * `summaries` is null when the summary failed. Every row then renders with what
 * the project list alone knows (name, slug, created), the overview band is
 * replaced by a quiet note with a retry, and sorting falls back to newest first.
 */
function Loaded({
  projects,
  query,
  onClearQuery,
  summaries,
  onRetrySummary,
}: {
  projects: readonly Project[];
  query: string;
  onClearQuery: () => void;
  summaries: readonly ProjectSummary[] | null;
  onRetrySummary: () => void;
}) {
  const now = useNow();
  const rows = useMemo(() => sortRows(buildRows(projects, summaries)), [projects, summaries]);
  const shown = useMemo(() => filterRows(rows, query), [rows, query]);
  const totals = useMemo(() => totalsOf(rows), [rows]);
  const verdict = useMemo(() => verdictOf(rows), [rows]);

  return (
    <>
      <div className={SECTION}>
        {summaries ? (
          <OverviewBand verdict={verdict} totals={totals} now={now} />
        ) : (
          <div
            role="status"
            className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-surface border border-dashed border-line-strong px-4 py-2"
          >
            <p className="text-label text-ink-2">
              Health and activity could not be loaded, so they are left out. Every group is still
              listed.
            </p>
            <Button variant="quiet" onClick={onRetrySummary}>
              Retry
            </Button>
          </div>
        )}
      </div>

      {/* Announced, not shown: the list itself is the visible result. */}
      {query.trim() !== '' && (
        <p role="status" className="sr-only">
          {shown.length} of {projects.length} groups match
        </p>
      )}

      <div className={SECTION}>
        {shown.length > 0 ? (
          <ProjectList rows={shown} now={now} detailed={summaries !== null} />
        ) : (
          <div className="rounded-surface border border-dashed border-line-strong px-6 py-8">
            <p className="text-heading font-semibold tracking-tight text-ink">
              No group matches “{query.trim()}”
            </p>
            <p className="mt-1 text-body text-ink-2">
              Filtering looks at names and slugs. All {projects.length} groups are still there.
            </p>
            <Button className="mt-4" onClick={onClearQuery}>
              Clear filter
            </Button>
          </div>
        )}
      </div>
    </>
  );
}

function ProjectFilter({
  inputRef,
  query,
  onChange,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onChange: (query: string) => void;
}) {
  return (
    <div className="relative order-last w-full sm:order-none sm:w-72">
      <label htmlFor="project-filter" className="sr-only">
        Filter groups by name or slug
      </label>
      <input
        id="project-filter"
        ref={inputRef}
        type="search"
        value={query}
        placeholder="Filter groups"
        autoComplete="off"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onChange('');
            event.currentTarget.blur();
          }
        }}
        className="min-h-11 w-full rounded-control border border-control bg-surface pr-8 pl-3 font-mono text-label text-ink placeholder:text-ink-3 md:min-h-9"
      />
      <kbd
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 rounded-control border border-line px-1 font-mono text-meta text-ink-3 max-sm:hidden"
      >
        /
      </kbd>
    </div>
  );
}
