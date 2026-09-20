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
import { ChevronIcon, StatusIcon } from '../components/icon.tsx';
import { ProjectShell } from '../components/project-shell.tsx';
import { StatusBadge } from '../components/status-badge.tsx';
import { StatusEventsPanel } from '../components/status-events.tsx';
import { Button, ErrorState, LoadingState } from '../components/states.tsx';
import { ThresholdPanel } from '../components/threshold-panel.tsx';
import { summariseApplications } from '../lib/status.ts';
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
  onCancel,
}: {
  projectId: string;
  onCreated: () => void;
  onCancel?: () => void;
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
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3 first:mt-0">
      <Field
        id="application-key"
        label="Key"
        type="text"
        value={key}
        onChange={(event) => setKey(event.target.value)}
        onBlur={() => setTouched((current) => ({ ...current, key: true }))}
        error={keyError}
        placeholder="checkout-api"
        inputClassName="w-full sm:w-52"
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
        inputClassName="w-full sm:w-64"
      />
      <Button type="submit" variant="primary" loading={submitting}>
        {submitting ? 'Registering…' : 'Register application'}
      </Button>
      {onCancel && (
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      )}
      {submitError && (
        <p role="alert" className="w-full text-label text-text-danger">
          {submitError}
        </p>
      )}
    </form>
  );
}

function ApplicationRow({ app }: { app: ApplicationStatus }) {
  const tripped = app.thresholds.filter((t) => t.state !== 'ok');
  return (
    <li
      id={`app-${app.id}`}
      className="grid scroll-mt-24 grid-cols-[minmax(0,1fr)_auto] items-start gap-x-6 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_6.5rem_minmax(0,2fr)]"
    >
      <div className="min-w-0">
        <p className="truncate text-body font-medium text-ink">{app.displayName ?? app.key}</p>
        <p className="truncate font-mono text-meta text-ink-3">{app.key}</p>
      </div>
      <StatusBadge status={app.effectiveStatus} />
      <div className="col-span-2 min-w-0 md:col-span-1">
        {app.causedBy ? (
          // The most useful line on the page, so it is full-size ink, not a
          // footnote: what is actually broken, and where to click for it.
          <p className="text-body text-ink">
            Caused by{' '}
            <a
              href={`#app-${app.causedBy.id}`}
              className="font-mono font-medium text-accent underline decoration-line-strong underline-offset-2 transition-colors hover:text-accent-strong hover:decoration-accent"
            >
              {app.causedBy.key}
            </a>
            <span className="text-ink-2"> - its own thresholds read {app.status}.</span>
          </p>
        ) : tripped.length === 0 ? (
          <p className="text-body text-ink-3">
            {app.thresholds.length === 0 ? 'No thresholds set.' : 'Within every threshold.'}
          </p>
        ) : null}
        {tripped.length > 0 && (
          <ul className="mt-1 flex flex-wrap gap-2">
            {tripped.map((t) => (
              <li
                key={t.id}
                className="inline-flex items-center gap-2 rounded-control bg-raised px-2 py-1 font-mono text-label text-ink"
              >
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 rounded-pill ${
                    t.state === 'critical' ? 'bg-status-critical' : 'bg-status-warning'
                  }`}
                />
                {t.metricName}
                <span className="text-ink-2">{t.value ?? 'no data'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </li>
  );
}

/**
 * A native <details> with a heading-weight summary: keyboard and screen-reader
 * behaviour come free, and the chevron is the only ornament. Configuration and
 * history live in these so they never compete with the answer at the top.
 */
function Disclosure({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group mt-10 border-t border-line pt-2">
      <summary className="flex min-h-11 list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
        <ChevronIcon className="shrink-0 text-ink-3 transition-transform group-open:rotate-90" />
        <h2 className="text-heading font-semibold tracking-tight text-ink">{title}</h2>
        {meta && <span className="font-mono text-meta text-ink-3">{meta}</span>}
      </summary>
      <div className="pt-4 pb-2">{children}</div>
    </details>
  );
}

function Count({ status, value }: { status: Status; value: number }) {
  return (
    <span
      className={`inline-flex items-center gap-2 ${value === 0 ? 'text-ink-3' : STATUS_TEXT[status]}`}
    >
      <StatusIcon status={status} />
      <span className="font-mono text-heading font-semibold">{value}</span>
      <span className="text-label">{STATUS_WORD[status]}</span>
    </span>
  );
}

const STATUS_TEXT: Record<Status, string> = {
  ok: 'text-status-ok',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
};
const STATUS_WORD: Record<Status, string> = { ok: 'ok', warning: 'warning', critical: 'critical' };

function ProjectStatusPanel({ project }: { project: Project }) {
  const status = useLoader(`status/${project.id}`, (signal) =>
    fetchProjectStatus(project.id, signal),
  );
  const [registering, setRegistering] = useState(false);
  const applications = status.data ?? [];

  return <main className="enter page flex-1 py-8 md:py-12">{renderBody()}</main>;

  function renderBody() {
    if (status.phase === 'error' && status.error) {
      return <ErrorState error={status.error} onRetry={status.reload} what="status" />;
    }
    if (status.phase === 'loading' || status.phase === 'waking') {
      return <LoadingState waking={status.phase === 'waking'} seconds={status.elapsedSeconds} />;
    }

    if (applications.length === 0) {
      return (
        <>
          <h1 className="text-page font-semibold tracking-tight text-ink">Status</h1>
          <section className="mt-8 rounded-surface border border-dashed border-line-strong px-6 py-8 md:px-8">
            <h2 className="text-heading font-semibold tracking-tight text-ink">
              Register your first application
            </h2>
            <p className="mt-2 max-w-prose text-body text-ink-2">
              An application is what status, dependencies and thresholds attach to. Use the same key
              a collector already writes under - the server picker on the Overview tab lists the
              keys in use - then set thresholds for it below.
            </p>
            <CreateApplicationForm projectId={project.id} onCreated={status.reload} />
          </section>
        </>
      );
    }

    const summary = summariseApplications(applications);
    const allHealthy = summary.worst === 'ok';

    // The page opens with the verdict, in a sentence, and the three counts as
    // the numbers behind it. Everything below is the evidence.
    return (
      <>
        <h1 className="text-page font-semibold tracking-tight text-ink">Status</h1>
        <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-body text-ink-2">
          <StatusBadge status={summary.worst} />
          <span>
            {allHealthy ? (
              summary.headline
            ) : (
              <>
                <span className="font-medium text-ink">{summary.headline}</span>
                {summary.detail && <> · {summary.detail}</>}
              </>
            )}
          </span>
        </p>
        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-2">
          <Count status="critical" value={summary.counts.critical} />
          <Count status="warning" value={summary.counts.warning} />
          <Count status="ok" value={summary.counts.ok} />
        </div>

        <section className="mt-10" aria-labelledby="dependencies-heading">
          <h2
            id="dependencies-heading"
            className="text-heading font-semibold tracking-tight text-ink"
          >
            Dependencies
          </h2>
          <p className="mt-1 mb-4 max-w-prose text-body text-ink-2">
            Effective status folds in everything an application depends on, so an outage shows up
            downstream of its cause.
          </p>
          <DependencyGraph applications={applications} onChanged={status.reload} />
        </section>

        <section className="mt-10" aria-labelledby="applications-heading">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2
              id="applications-heading"
              className="text-heading font-semibold tracking-tight text-ink"
            >
              Applications{' '}
              <span className="font-mono text-meta font-normal text-ink-3">
                {applications.length}
              </span>
            </h2>
            {!registering && (
              <Button onClick={() => setRegistering(true)}>Register application</Button>
            )}
          </div>
          {registering && (
            <div className="mt-4 rounded-surface border border-line bg-surface p-4">
              <CreateApplicationForm
                projectId={project.id}
                onCreated={() => {
                  setRegistering(false);
                  status.reload();
                }}
                onCancel={() => setRegistering(false)}
              />
            </div>
          )}
          <ul className="mt-4 divide-y divide-line overflow-hidden rounded-surface border border-line bg-surface">
            {applications.map((app) => (
              <ApplicationRow key={app.id} app={app} />
            ))}
          </ul>
        </section>

        <Disclosure title="Thresholds">
          <p className="mb-4 max-w-prose text-body text-ink-2">
            Per application and metric. Either bound may be left empty, and &ldquo;below&rdquo; is
            exactly as easy to set up as &ldquo;above&rdquo; - free memory and request-rate alerts
            need it just as much.
          </p>
          <ThresholdPanel projectId={project.id} applications={applications} />
        </Disclosure>

        <Disclosure title="Recent transitions">
          <StatusEventsPanel projectId={project.id} applications={applications} />
        </Disclosure>
      </>
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
