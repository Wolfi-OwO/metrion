import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, createProject, type MeResponse } from '../api/client.ts';
import { AccountBar } from '../components/account-bar.tsx';
import { Field } from '../components/field.tsx';
import { ProjectStatusIndicator } from '../components/project-status-indicator.tsx';
import { Body, Button, ErrorState, Heading, Panel } from '../components/states.tsx';
import { projectNameError } from '../lib/validate.ts';
import { useProjects } from '../lib/use-projects.ts';

function ProjectsLoading() {
  return (
    <div className="px-5 py-14 sm:px-8">
      <p role="status" aria-live="polite" className="text-[13px] text-ink-dim">
        Loading your projects…
      </p>
    </div>
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
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3">
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
      <button
        type="button"
        onClick={onCancel}
        className="rounded-sm px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors duration-150 hover:text-ink"
      >
        Cancel
      </button>
      {submitError && (
        <p role="alert" className="w-full text-[12px] text-series-8">
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
      <header className="border-b border-line bg-bg-900">
        <AccountBar email={user.email} onSignedOut={onSignedOut} />
      </header>
      <main className="flex-1">{renderBody()}</main>
    </>
  );

  function renderBody() {
    if (projects.phase === 'error' && projects.error) {
      return <ErrorState error={projects.error} onRetry={projects.reload} />;
    }
    if (projects.phase === 'loading' || projects.phase === 'waking') {
      return <ProjectsLoading />;
    }

    const list = projects.data ?? [];

    if (list.length === 0 && !showForm) {
      return (
        <Panel>
          <Heading>No projects yet</Heading>
          <Body>
            A project is what an API key belongs to. Create one, mint a key from its settings page,
            then point a collector at it - the quickstart on the landing page shows the exact
            request.
          </Body>
          <Button className="mt-4" onClick={() => setShowForm(true)}>
            New project
          </Button>
        </Panel>
      );
    }

    return (
      <div className="px-5 py-8 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-[15px] font-semibold text-ink">Projects</h1>
          {!showForm && <Button onClick={() => setShowForm(true)}>New project</Button>}
        </div>

        {showForm && (
          <CreateProjectForm
            onCreated={() => {
              setShowForm(false);
              projects.reload();
            }}
            onCancel={() => setShowForm(false)}
          />
        )}

        {list.length > 0 && (
          <ul className="mt-6 divide-y divide-line border-y border-line">
            {list.map((project) => (
              <li
                key={project.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-3"
              >
                <Link
                  to={`/projects/${project.id}`}
                  className="text-[14px] font-medium text-ink transition-colors duration-150 hover:text-series-1"
                >
                  {project.name}
                </Link>
                <ProjectStatusIndicator projectId={project.id} />
                <span className="font-mono text-[11px] text-ink-muted">{project.slug}</span>
                <span className="font-mono text-[11px] text-ink-muted">
                  created{' '}
                  {new Date(project.createdAt).toLocaleDateString(undefined, {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </span>
                <Link
                  to={`/projects/${project.id}/status`}
                  className="ml-auto text-[12px] text-ink-dim transition-colors duration-150 hover:text-ink"
                >
                  Status
                </Link>
                <Link
                  to={`/projects/${project.id}/settings`}
                  className="text-[12px] text-ink-dim transition-colors duration-150 hover:text-ink"
                >
                  Settings
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
}
