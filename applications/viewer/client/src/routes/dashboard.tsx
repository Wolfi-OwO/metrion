import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, createProject, type MeResponse } from '../api/client.ts';
import { AccountBar } from '../components/account-bar.tsx';
import { Field } from '../components/field.tsx';
import { ScopeIcon } from '../components/icon.tsx';
import { ProjectStatusIndicator } from '../components/project-status-indicator.tsx';
import { Body, Button, ErrorState, Heading, Panel } from '../components/states.tsx';
import { projectNameError } from '../lib/validate.ts';
import { useProjects } from '../lib/use-projects.ts';

/**
 * One skeleton row, shaped like a real project row (name+status cluster,
 * metadata cluster, actions cluster) so the list does not reflow the instant
 * data lands. Static, not shimmering: `styles/index.css` names the axis
 * sweep in `states.tsx`'s `LoadingState` as the one piece of non-user-
 * triggered motion in this app, so a second animated placeholder here would
 * be a second, competing answer to the same "still working" question.
 */
function ProjectRowSkeleton() {
  return (
    <li aria-hidden="true" className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 py-3.5">
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="h-3.5 w-36 rounded-control bg-raised" />
        <div className="h-2.5 w-12 rounded-control bg-raised" />
      </div>
      <div className="h-2.5 w-40 shrink-0 rounded-control bg-raised" />
      <div className="flex shrink-0 items-center gap-4">
        <div className="h-2.5 w-10 rounded-control bg-raised" />
        <div className="h-2.5 w-14 rounded-control bg-raised" />
      </div>
    </li>
  );
}

function ProjectsLoadingRows() {
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        Loading your projects…
      </p>
      <ul aria-hidden="true" className="mt-6 divide-y divide-line border-y border-line">
        {Array.from({ length: 5 }, (_, index) => (
          <ProjectRowSkeleton key={index} />
        ))}
      </ul>
    </>
  );
}

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
        setSubmitError(cause instanceof ApiError ? cause.message : 'Could not create the project.');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="mt-6 flex flex-wrap items-end gap-3">
      <Field
        id="project-name"
        label="Project name"
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => setTouched(true)}
        error={fieldError}
        inputClassName="w-64"
      />
      <Button type="submit" loading={submitting}>
        {submitting ? 'Creating…' : 'Create project'}
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

export default function DashboardRoute({
  user,
  onSignedOut,
}: {
  user: MeResponse;
  onSignedOut: () => void;
}) {
  const projects = useProjects();
  const [showForm, setShowForm] = useState(false);

  return (
    <>
      <header className="border-b border-line bg-surface">
        <AccountBar email={user.email} onSignedOut={onSignedOut} />
      </header>
      <main className="flex-1 pb-8">{renderBody()}</main>
    </>
  );

  function renderBody() {
    const isLoading = projects.phase === 'loading' || projects.phase === 'waking';
    const isError = projects.phase === 'error' && projects.error != null;
    const list = projects.data ?? [];
    const isEmpty = !isLoading && !isError && list.length === 0;
    // The one create action lives beside the title on every ready state,
    // including the empty one - so a first-time visitor gets a single,
    // unambiguous next step rather than that button repeated a second time
    // inside the empty-state panel below.
    const canCreate = !isLoading && !isError;

    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-3 px-gutter pt-8 sm:px-gutter-lg">
          <h1 className="text-heading font-semibold text-ink">Projects</h1>
          {canCreate && !showForm && <Button onClick={() => setShowForm(true)}>New project</Button>}
        </div>

        {isError && <ErrorState error={projects.error!} onRetry={projects.reload} />}

        {isEmpty && !showForm && (
          <Panel>
            <div className="flex items-center gap-2.5">
              <ScopeIcon id="container" />
              <Heading>No projects yet</Heading>
            </div>
            <Body>
              A project is what an API key belongs to. Create one, mint a key from its settings
              page, then point a collector at it - the quickstart on the landing page shows the
              exact request.
            </Body>
          </Panel>
        )}

        {!isError && (showForm || isLoading || list.length > 0) && (
          <div className="px-gutter sm:px-gutter-lg">
            {showForm && (
              <CreateProjectForm
                onCreated={() => {
                  setShowForm(false);
                  projects.reload();
                }}
                onCancel={() => setShowForm(false)}
              />
            )}

            {isLoading && <ProjectsLoadingRows />}

            {!isLoading && list.length > 0 && (
              // Three fixed-content clusters, not a table: name+status is the
              // one flex-grow item, so it absorbs whatever width metadata and
              // actions do not need and pushes them flush right on their own -
              // no ml-auto, no breakpoint math. Under about 500-600px the
              // clusters no longer fit one line and flex-wrap drops each onto
              // its own row, left-aligned like the line above it, rather than
              // a card grid or a second, narrower layout to maintain.
              <ul className="mt-6 divide-y divide-line border-y border-line">
                {list.map((project) => (
                  <li
                    key={project.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 py-3.5"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2.5">
                      <Link
                        to={`/projects/${project.id}`}
                        className="min-w-0 truncate text-body font-medium text-ink transition-colors duration-(--duration-fast) hover:text-accent"
                      >
                        {project.name}
                      </Link>
                      <span className="shrink-0">
                        <ProjectStatusIndicator projectId={project.id} />
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-2 font-mono text-meta text-ink-3">
                      <span className="max-w-40 truncate">{project.slug}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        {new Date(project.createdAt).toLocaleDateString(undefined, {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </div>

                    <div className="flex shrink-0 items-center gap-4">
                      <Link
                        to={`/projects/${project.id}/status`}
                        className="text-label text-ink-2 transition-colors duration-(--duration-fast) hover:text-ink"
                      >
                        Status
                      </Link>
                      <Link
                        to={`/projects/${project.id}/settings`}
                        className="text-label text-ink-2 transition-colors duration-(--duration-fast) hover:text-ink"
                      >
                        Settings
                      </Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </>
    );
  }
}
