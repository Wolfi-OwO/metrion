import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, createProject, type MeResponse } from '../api/client.ts';
import { AccountBar } from '../components/account-bar.tsx';
import { Field } from '../components/field.tsx';
import { ChevronIcon } from '../components/icon.tsx';
import { ProjectHealth } from '../components/project-health.tsx';
import { Button, ErrorState } from '../components/states.tsx';
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
const LIST =
  'mt-6 divide-y divide-line overflow-hidden rounded-surface border border-line bg-surface';

function ProjectRowSkeleton() {
  return (
    <li
      aria-hidden="true"
      className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:gap-6"
    >
      <div className="flex-1 space-y-2">
        <div className="h-4 w-40 rounded-control bg-raised" />
        <div className="h-3 w-24 rounded-control bg-raised" />
      </div>
      <div className="h-4 w-56 rounded-control bg-raised md:flex-1" />
    </li>
  );
}

function ProjectsLoadingRows() {
  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">
        Loading your projects…
      </p>
      <ul aria-hidden="true" className={LIST}>
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
    <form
      onSubmit={handleSubmit}
      className="mt-6 flex flex-wrap items-end gap-3 rounded-surface border border-line bg-surface p-4"
    >
      <Field
        id="project-name"
        label="Project name"
        type="text"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => setTouched(true)}
        error={fieldError}
        inputClassName="w-full sm:w-72"
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
      <main className="flex-1">{renderBody()}</main>
    </>
  );

  function renderBody() {
    const isLoading = projects.phase === 'loading' || projects.phase === 'waking';
    const isError = projects.phase === 'error' && projects.error != null;
    const list = projects.data ?? [];
    const isEmpty = !isLoading && !isError && list.length === 0;

    return (
      <div className="enter page py-8 md:py-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-page font-semibold tracking-tight text-ink">Projects</h1>
            <p className="mt-1 text-body text-ink-2">
              {list.length > 0
                ? `${list.length} ${list.length === 1 ? 'project' : 'projects'}`
                : 'Each project is one environment: its keys, applications and thresholds.'}
            </p>
          </div>
          {!isLoading && !isError && !isEmpty && !showForm && (
            <Button variant="primary" onClick={() => setShowForm(true)}>
              New project
            </Button>
          )}
        </div>

        {isError && (
          <ErrorState error={projects.error!} onRetry={projects.reload} what="projects" nested />
        )}

        {(showForm || (isEmpty && showForm)) && (
          <CreateProjectForm
            onCreated={() => {
              setShowForm(false);
              projects.reload();
            }}
            onCancel={() => setShowForm(false)}
          />
        )}

        {isEmpty && !showForm && <FirstRun onCreate={() => setShowForm(true)} />}

        {isLoading && <ProjectsLoadingRows />}

        {!isLoading && list.length > 0 && (
          // A list, not a card grid: what distinguishes one project from the
          // next is a name and a health line, and those read best as rows
          // that line up. The whole row is the link (the name link stretches
          // over it); Status and Settings are secondary shortcuts that only
          // appear from md up, because the project's own tabs cover them on a
          // phone and a row of four 44px targets would not fit.
          <ul className={LIST}>
            {list.map((project) => (
              <li
                key={project.id}
                className="group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-raised md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_auto_auto] md:gap-x-6"
              >
                <div className="min-w-0">
                  <Link
                    to={`/projects/${project.id}`}
                    className="block py-1 after:absolute after:inset-0"
                  >
                    <span className="block truncate text-body font-medium text-ink">
                      {project.name}
                    </span>
                    <span className="block truncate font-mono text-meta text-ink-3">
                      {project.slug}
                    </span>
                  </Link>
                </div>

                <div className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:row-start-auto">
                  <ProjectHealth projectId={project.id} />
                </div>

                <div className="hidden items-center gap-1 md:flex">
                  <Link
                    to={`/projects/${project.id}/status`}
                    className="relative z-10 rounded-control px-2 py-1 text-label text-ink-2 transition-colors hover:bg-line hover:text-ink"
                  >
                    Status
                  </Link>
                  <Link
                    to={`/projects/${project.id}/settings`}
                    className="relative z-10 rounded-control px-2 py-1 text-label text-ink-2 transition-colors hover:bg-line hover:text-ink"
                  >
                    Settings
                  </Link>
                </div>

                <ChevronIcon className="col-start-2 row-start-1 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5 group-hover:text-ink md:col-start-auto md:row-start-auto" />
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
}

/**
 * First-run. Not an apology for an empty list: the three things that have to
 * happen, in order, with the one action that starts them. The project
 * `defaultResource` is left out on purpose - it does nothing until a key
 * ingests something.
 */
function FirstRun({ onCreate }: { onCreate: () => void }) {
  const steps = [
    ['Create a project', 'One per environment: production, staging, a home lab.'],
    ['Mint an API key', 'From the project’s Settings tab. It is shown once.'],
    ['Send a metric', 'POST to /api/v1/ingest with the key. The landing page shows the request.'],
  ] as const;
  return (
    <section className="mt-8 rounded-surface border border-dashed border-line-strong px-6 py-8 md:px-8">
      <h2 className="text-heading font-semibold tracking-tight text-ink">
        Start with your first project
      </h2>
      <ol className="mt-6 grid gap-6 md:grid-cols-3">
        {steps.map(([title, body], index) => (
          <li key={title} className="flex gap-4">
            <span
              aria-hidden="true"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-pill border border-line-strong font-mono text-label text-ink-2"
            >
              {index + 1}
            </span>
            <div>
              <p className="text-body font-medium text-ink">{title}</p>
              <p className="mt-1 text-body text-ink-2">{body}</p>
            </div>
          </li>
        ))}
      </ol>
      <Button className="mt-8" variant="primary" onClick={onCreate}>
        Create your first project
      </Button>
    </section>
  );
}
