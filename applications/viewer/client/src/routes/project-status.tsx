import { useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import {
  ApiError,
  createApplication,
  fetchProjectStatus,
  type ApplicationStatus,
  type Project,
} from '../api/client.ts';
import { DependencyGraph } from '../components/dependency-graph.tsx';
import { ProjectShell } from '../components/project-shell.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { StatusEventsPanel } from '../components/status-events.tsx';
import { ActionButton, Body, ErrorState, Heading, LoadingState, Panel } from '../components/states.tsx';
import { ThresholdPanel } from '../components/threshold-panel.tsx';
import { applicationKeyError, applicationNameError } from '../lib/validate.ts';
import type { AuthState } from '../lib/use-auth.ts';
import { useLoader } from '../lib/use-loader.ts';
import { useProject } from '../lib/use-projects.ts';

/**
 * `/projects/:projectId/status` - the screen `GET /projects/:id/status`
 * exists for: green/orange/red per application at a glance, which one is
 * actually at fault when a dependency is what is really failing, and the
 * dependency and threshold editors that decide both. Same lookup/header
 * pattern as `project-settings.tsx`.
 */

function CreateApplicationForm({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: () => void;
}) {
  const [key, setKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [touched, setTouched] = useState<{ key?: boolean; displayName?: boolean }>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const keyError = touched.key ? applicationKeyError(key) : null;
  const nameError = touched.displayName ? applicationNameError(displayName) : null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched({ key: true, displayName: true });
    if (applicationKeyError(key) || applicationNameError(displayName)) return;

    setSubmitting(true);
    setSubmitError(null);
    const controller = new AbortController();
    createApplication(projectId, key.trim(), displayName.trim(), controller.signal)
      .then(() => {
        setKey('');
        setDisplayName('');
        setTouched({});
        onCreated();
      })
      .catch((cause: unknown) => {
        setSubmitError(
          cause instanceof ApiError ? cause.message : 'Could not register the application.',
        );
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="application-key" className="text-[12px] text-ink-dim">
          Key
        </label>
        <input
          id="application-key"
          type="text"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          onBlur={() => setTouched((current) => ({ ...current, key: true }))}
          aria-invalid={keyError !== null}
          aria-describedby={keyError ? 'application-key-error' : undefined}
          placeholder="checkout-api"
          className="w-48 rounded-sm border border-line-strong bg-bg-800 px-2.5 py-1.5 font-mono text-[13px] text-ink"
        />
        {keyError && (
          <p id="application-key-error" role="alert" className="text-[12px] text-series-8">
            {keyError}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="application-name" className="text-[12px] text-ink-dim">
          Display name
        </label>
        <input
          id="application-name"
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          onBlur={() => setTouched((current) => ({ ...current, displayName: true }))}
          aria-invalid={nameError !== null}
          aria-describedby={nameError ? 'application-name-error' : undefined}
          placeholder="Checkout API"
          className="w-56 rounded-sm border border-line-strong bg-bg-800 px-2.5 py-1.5 font-mono text-[13px] text-ink"
        />
        {nameError && (
          <p id="application-name-error" role="alert" className="text-[12px] text-series-8">
            {nameError}
          </p>
        )}
      </div>
      <ActionButton type="submit" disabled={submitting}>
        {submitting ? 'Registering…' : 'Register application'}
      </ActionButton>
      {submitError && (
        <p role="alert" className="w-full text-[12px] text-series-8">
          {submitError}
        </p>
      )}
    </form>
  );
}

function ApplicationRow({ app }: { app: ApplicationStatus }) {
  return (
    <li id={`app-${app.id}`} className="scroll-mt-20 px-1 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-[13px] font-medium text-ink">
          {app.displayName ?? app.key}
        </span>
        <StatusBadge status={app.effectiveStatus} />
      </div>
      {app.causedBy && (
        <p className="mt-1 text-[12px] text-ink-dim">
          Caused by{' '}
          <a href={`#app-${app.causedBy.id}`} className="font-mono text-ink hover:text-series-1">
            {app.causedBy.key}
          </a>
          {/* `causedBy` is only ever set when the dependency's status is
              strictly worse than this application's own - see
              `status-service.ts`'s comment - so `app.status` here always
              differs from the badge above; naming it is the whole point of
              the attribution, not a hedge against a case that cannot occur. */}
          {' - '}this application's own thresholds read {app.status}.
        </p>
      )}
      {app.thresholds.length > 0 && (
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-ink-muted">
          {app.thresholds
            .filter((t) => t.state !== 'ok')
            .map((t) => (
              <li key={t.id} className="font-mono">
                {t.metricName}: {t.value ?? 'no data'}
              </li>
            ))}
        </ul>
      )}
    </li>
  );
}

function ProjectStatusPanel({ project }: { project: Project }) {
  const status = useLoader(`status/${project.id}`, (signal) =>
    fetchProjectStatus(project.id, signal),
  );
  const applications = status.data ?? [];

  return <main className="flex-1">{renderBody()}</main>;

  function renderBody() {
    if (status.phase === 'error' && status.error) {
      return <ErrorState error={status.error} onRetry={status.reload} />;
    }
    if (status.phase === 'loading' || status.phase === 'waking') {
      return <LoadingState waking={status.phase === 'waking'} seconds={status.elapsedSeconds} />;
    }

    if (applications.length === 0) {
      return (
        <Panel>
          <Heading>No applications registered yet</Heading>
          <Body>
            An application is what status, dependencies and thresholds attach to. Register one with
            the same key a collector already writes under (the metrics view's server picker shows
            the keys in use), then set thresholds for it below.
          </Body>
          <CreateApplicationForm projectId={project.id} onCreated={status.reload} />
        </Panel>
      );
    }

    return (
      <div className="px-5 py-8 sm:px-8">
        <section>
          <h1 className="text-[15px] font-semibold text-ink">Applications</h1>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-dim">
            Effective status folds in every application this one depends on - when it differs from
            what this application's own thresholds say, the cause is named underneath it.
          </p>
          <ul className="mt-3 divide-y divide-line border-y border-line">
            {applications.map((app) => (
              <ApplicationRow key={app.id} app={app} />
            ))}
          </ul>
          <CreateApplicationForm projectId={project.id} onCreated={status.reload} />
        </section>

        <section className="mt-10 border-t border-line pt-6">
          <h2 className="text-[15px] font-semibold text-ink">Dependency graph</h2>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-dim">
            Each application's direct dependencies. Editing saves the whole set at once; a save that
            would create a cycle is rejected and the offending path is shown here, not a generic
            error.
          </p>
          <div className="mt-3">
            <DependencyGraph applications={applications} onChanged={status.reload} />
          </div>
        </section>

        <section className="mt-10 border-t border-line pt-6">
          <h2 className="text-[15px] font-semibold text-ink">Thresholds</h2>
          <p className="mt-1 max-w-prose text-[13px] leading-relaxed text-ink-dim">
            Per application and metric. Either bound may be left empty, and "below" is exactly as
            easy to set up as "above" - free memory and request-rate alerts need it just as much.
          </p>
          <div className="mt-3">
            <ThresholdPanel projectId={project.id} applications={applications} />
          </div>
        </section>

        <section className="mt-10 border-t border-line pt-6">
          <h2 className="text-[15px] font-semibold text-ink">Recent transitions</h2>
          <div className="mt-3">
            <StatusEventsPanel projectId={project.id} applications={applications} />
          </div>
        </section>
      </div>
    );
  }
}

export default function ProjectStatusRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const auth = useOutletContext<AuthState>();
  const lookup = useProject(projectId ?? '', auth.status !== 'loading');

  return (
    <ProjectShell
      auth={auth}
      lookup={lookup}
      breadcrumb={
        <>
          <Link to="/" className="transition-colors duration-150 hover:text-ink">
            Projects
          </Link>
          <span aria-hidden="true">/</span>
          {lookup.project ? (
            <Link
              to={`/projects/${lookup.project.id}`}
              className="transition-colors duration-150 hover:text-ink"
            >
              {lookup.project.name}
            </Link>
          ) : (
            <span>…</span>
          )}
          <span aria-hidden="true">/</span>
          <span className="text-ink">Status</span>
        </>
      }
    >
      {(project) => <ProjectStatusPanel project={project} />}
    </ProjectShell>
  );
}
