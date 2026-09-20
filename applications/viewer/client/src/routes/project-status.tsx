import { useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import {
  ApiError,
  createApplication,
  fetchProjectStatus,
  type ApplicationStatus,
  type Project,
  type Status,
} from '../api/client.ts';
import { DependencyGraph } from '../components/dependency-graph.tsx';
import { Field } from '../components/field.tsx';
import { StatusIcon } from '../components/icon.tsx';
import { ProjectShell } from '../components/project-shell.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { StatusEventsPanel } from '../components/status-events.tsx';
import { Body, Button, ErrorState, Heading, LoadingState, Panel } from '../components/states.tsx';
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
      <Field
        id="application-key"
        label="Key"
        type="text"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        onBlur={() => setTouched((current) => ({ ...current, key: true }))}
        error={keyError}
        placeholder="checkout-api"
        inputClassName="w-48"
      />
      <Field
        id="application-name"
        label="Display name"
        type="text"
        value={displayName}
        onChange={(event) => setDisplayName(event.target.value)}
        onBlur={() => setTouched((current) => ({ ...current, displayName: true }))}
        error={nameError}
        placeholder="Checkout API"
        inputClassName="w-56"
      />
      <Button type="submit" loading={submitting}>
        {submitting ? 'Registering…' : 'Register application'}
      </Button>
      {submitError && (
        <p role="alert" className="w-full text-label text-text-danger">
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
        <span className="font-mono text-body font-medium text-ink">
          {app.displayName ?? app.key}
        </span>
        <StatusBadge status={app.effectiveStatus} />
      </div>
      {app.causedBy && (
        // The single most useful line on this page: full body size and
        // bright ink, not a dim footnote, and it leads with the same status
        // icon `StatusBadge` already uses above - reusing that three-channel
        // vocabulary (shape + colour + word, see `status-badge.tsx`) instead
        // of inventing a new container to draw the eye.
        <p className="mt-1.5 flex max-w-prose items-baseline gap-1.5 text-body text-ink">
          <span
            className={
              app.effectiveStatus === 'critical'
                ? 'shrink-0 text-status-critical'
                : 'shrink-0 text-status-warning'
            }
          >
            <StatusIcon status={app.effectiveStatus} />
          </span>
          <span>
            Caused by{' '}
            <a
              href={`#app-${app.causedBy.id}`}
              className="font-mono font-medium text-ink underline decoration-line-strong underline-offset-2 transition-colors duration-(--duration-fast) hover:text-accent hover:decoration-accent"
            >
              {app.causedBy.key}
            </a>
            {' - '}this application's own thresholds read {app.status}.
          </span>
        </p>
      )}
      {app.thresholds.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-meta text-ink-3">
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

/** Chevron-only disclosure marker for the three secondary `<details>`
 * sections below - a text glyph, not a new entry in `icon.tsx`'s vocabulary,
 * matching the `→` this route and `status-events.tsx` already render as
 * plain `aria-hidden` text rather than an SVG. */
function DisclosureMark() {
  return (
    <span
      aria-hidden="true"
      className="inline-block text-ink-3 transition-transform duration-(--duration-fast) group-open:rotate-90"
    >
      {'›'}
    </span>
  );
}

function ProjectStatusPanel({ project }: { project: Project }) {
  const status = useLoader(`status/${project.id}`, (signal) =>
    fetchProjectStatus(project.id, signal),
  );
  const applications = status.data ?? [];
  const counts = applications.reduce(
    (acc, app) => {
      acc[app.effectiveStatus] += 1;
      return acc;
    },
    { ok: 0, warning: 0, critical: 0 } as Record<Status, number>,
  );

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

    // Applications is the answer to the question this whole route exists
    // for ("which application is at fault, and why") and stays fully open,
    // full weight. The graph and threshold editors are configuration, and
    // recent transitions is history rather than current state - all three
    // are real `<details>`, collapsed by default, so they never compete with
    // the answer above for either space or attention. Native disclosure, not
    // a hand-rolled toggle: keyboard and screen-reader behaviour come free.
    return (
      <div className="px-gutter py-8 sm:px-gutter-lg">
        <section>
          <h1 className="text-heading font-semibold text-ink">Applications</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-meta text-ink-3">
            <span className="flex items-center gap-1.5 text-status-critical">
              <StatusIcon status="critical" />
              {counts.critical} critical
            </span>
            <span className="flex items-center gap-1.5 text-status-warning">
              <StatusIcon status="warning" />
              {counts.warning} warning
            </span>
            <span className="flex items-center gap-1.5 text-status-ok">
              <StatusIcon status="ok" />
              {counts.ok} ok
            </span>
          </div>
          <p className="mt-2 max-w-prose text-body leading-relaxed text-ink-2">
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

        <details className="group mt-10 border-t border-line pt-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-body font-medium text-ink-2 transition-colors duration-(--duration-fast) hover:text-ink [&::-webkit-details-marker]:hidden">
            <DisclosureMark />
            Dependency graph
          </summary>
          <p className="mt-2 max-w-prose text-body leading-relaxed text-ink-2">
            Each application's direct dependencies. Editing saves the whole set at once; a save that
            would create a cycle is rejected and the offending path is shown here, not a generic
            error.
          </p>
          <div className="mt-3">
            <DependencyGraph applications={applications} onChanged={status.reload} />
          </div>
        </details>

        <details className="group mt-6 border-t border-line pt-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-body font-medium text-ink-2 transition-colors duration-(--duration-fast) hover:text-ink [&::-webkit-details-marker]:hidden">
            <DisclosureMark />
            Thresholds
          </summary>
          <p className="mt-2 max-w-prose text-body leading-relaxed text-ink-2">
            Per application and metric. Either bound may be left empty, and "below" is exactly as
            easy to set up as "above" - free memory and request-rate alerts need it just as much.
          </p>
          <div className="mt-3">
            <ThresholdPanel projectId={project.id} applications={applications} />
          </div>
        </details>

        <details className="group mt-6 border-t border-line pt-5">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-body font-medium text-ink-2 transition-colors duration-(--duration-fast) hover:text-ink [&::-webkit-details-marker]:hidden">
            <DisclosureMark />
            Recent transitions
          </summary>
          <div className="mt-3">
            <StatusEventsPanel projectId={project.id} applications={applications} />
          </div>
        </details>
      </div>
    );
  }
}

export default function ProjectStatusRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const auth = useOutletContext<AuthState>();
  const lookup = useProject(projectId ?? '', auth.status !== 'loading');

  return (
    <ProjectShell auth={auth} lookup={lookup} projectId={projectId ?? ''}>
      {(project) => <ProjectStatusPanel project={project} />}
    </ProjectShell>
  );
}
