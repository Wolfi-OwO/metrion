import { useMemo, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import type { Project } from '../api/client.ts';
import { fetchResources } from '../api/client.ts';
import { MetricChart } from '../components/metric-chart.tsx';
import { ProjectHeader, ProjectShell } from '../components/project-shell.tsx';
import { RangeControl } from '../components/range-control.tsx';
import { ResourcePicker, type Selection } from '../components/resource-picker.tsx';
import { Button, buttonClassName, EmptyState, ErrorState, LoadingState } from '../components/states.tsx';
import { formatAge, formatDuration, timeZoneLabel } from '../lib/format.ts';
import { groupByUnit } from '../lib/groups.ts';
import { chooseStepSeconds, RANGE_PRESETS, rangeFor } from '../lib/range.ts';
import type { AuthState } from '../lib/use-auth.ts';
import { useLoader } from '../lib/use-loader.ts';
import { useProject } from '../lib/use-projects.ts';
import { useSeries } from '../lib/use-series.ts';

/**
 * `/projects/:projectId` - a project's dashboard. This is the original
 * single-screen app's whole body, moved here unchanged: same state, same
 * hooks in the same order, same three render branches (waking, empty,
 * error) before the charts. Only the chrome around it - the header's
 * identity row and breadcrumb - is new.
 */

const DEFAULT_PRESET = RANGE_PRESETS[2] ?? RANGE_PRESETS[0]!;

export default function ProjectMetricsRoute() {
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
          <span className="text-ink">{lookup.project?.name ?? '…'}</span>
        </>
      }
    >
      {(project, email, onSignedOut) => (
        <ProjectMetricsPanel project={project} email={email} onSignedOut={onSignedOut} />
      )}
    </ProjectShell>
  );
}

function ProjectMetricsPanel({
  project,
  email,
  onSignedOut,
}: {
  project: Project;
  email: string;
  onSignedOut: () => void;
}) {
  const [preset, setPreset] = useState(DEFAULT_PRESET);
  // Bumping `now` is what "Refresh" does: a new window end means a new range,
  // a new request key, and a reload of everything downstream. One trigger.
  const [now, setNow] = useState(() => new Date());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [attempt, setAttempt] = useState(0);

  const range = useMemo(() => rangeFor(preset, now), [preset, now]);
  const stepSeconds = useMemo(() => chooseStepSeconds(range), [range]);
  const rangeKey = `${range.from.toISOString()}/${range.to.toISOString()}/${project.id}`;

  const resources = useLoader(rangeKey, (signal) =>
    fetchResources(range.from, range.to, signal, project.id),
  );

  const list = resources.data?.resources ?? [];

  /**
   * The selection is derived, not stored twice. A resource or sub-resource can
   * vanish when the range changes - it only existed in last week's data - and
   * a stored selection would then query something the API knows nothing about
   * and render an empty page with no explanation.
   */
  const active: Selection | null = useMemo(() => {
    const first = list[0];
    if (!first) return null;
    const found = selection && list.find((entry) => entry.resource === selection.resource);
    if (!found) return { resource: first.resource };
    if (selection?.subResource && !found.subResources.includes(selection.subResource)) {
      return { resource: found.resource };
    }
    return selection;
  }, [list, selection]);

  const activeEntry = list.find((entry) => entry.resource === active?.resource);

  const series = useSeries(
    active && activeEntry
      ? {
          resource: active.resource,
          subResource: active.subResource,
          names: activeEntry.metricNames,
          range,
          stepSeconds,
          projectId: project.id,
        }
      : null,
    attempt,
  );

  const groups = useMemo(
    () => groupByUnit(series.results, range, stepSeconds),
    [series.results, range, stepSeconds],
  );

  const newestSample = useMemo(() => {
    let newest = 0;
    for (const result of series.results) {
      const last = result.points[result.points.length - 1];
      if (!last) continue;
      const at = Date.parse(last.timestamp);
      if (at > newest) newest = at;
    }
    return newest;
  }, [series.results]);

  const skippedLines = (resources.data?.skippedLines ?? 0) + series.skippedLines;
  const presetIndex = RANGE_PRESETS.indexOf(preset);
  const widerPreset = RANGE_PRESETS[presetIndex + 1] ?? null;
  const selectionLabel = active
    ? active.subResource
      ? `${active.resource} / ${active.subResource}`
      : active.resource
    : 'any resource';

  const refresh = () => {
    setNow(new Date());
    setAttempt((value) => value + 1);
  };

  return (
    <>
      <ProjectHeader
        email={email}
        onSignedOut={onSignedOut}
        sticky
        breadcrumb={
          <>
            <Link to="/" className="transition-colors duration-150 hover:text-ink">
              Projects
            </Link>
            <span aria-hidden="true">/</span>
            <span className="text-ink">{project.name}</span>
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-line px-5 py-2.5 sm:px-8">
          {list.length > 0 && active && (
            <ResourcePicker resources={list} value={active} onChange={setSelection} />
          )}

          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
            {newestSample > 0 && (
              <span className="font-mono text-[11px] text-ink-muted">
                last sample {formatAge(now.getTime() - newestSample)}
              </span>
            )}
            <RangeControl value={preset} onChange={setPreset} />
            <Button variant="quiet" onClick={refresh}>
              Refresh
            </Button>
            <Link to={`/projects/${project.id}/status`} className={buttonClassName('quiet')}>
              Status
            </Link>
            <Link to={`/projects/${project.id}/settings`} className={buttonClassName('quiet')}>
              Settings
            </Link>
          </div>
        </div>

        {/* Indeterminate now: every metric arrives in one request, so there is
            no count to report against - the honest signal is "working", not a
            fake percentage. It was determinate when the page issued one
            request per metric name. */}
        {(series.phase === 'loading' || series.phase === 'waking') && (
          <div
            className="h-px w-full overflow-hidden bg-bg-800"
            role="progressbar"
            aria-label="Loading metrics"
          >
            <div className="h-px w-1/3 animate-[loading-sweep_1.4s_ease-in-out_infinite] bg-series-1" />
          </div>
        )}
      </ProjectHeader>

      {/* Called, not rendered as <Body />: a component declared inside another
          component is a new type on every render, so React would unmount and
          rebuild the whole chart tree - and recharts' hover state with it -
          every time the header ticks. */}
      <main className="flex-1">{renderBody()}</main>
    </>
  );

  function renderBody() {
    if (resources.phase === 'error' && resources.error) {
      return <ErrorState error={resources.error} onRetry={resources.reload} />;
    }
    if (resources.phase === 'loading' || resources.phase === 'waking') {
      return (
        <LoadingState waking={resources.phase === 'waking'} seconds={resources.elapsedSeconds} />
      );
    }
    if (list.length === 0) {
      return (
        <EmptyState
          range={range}
          label="any resource"
          onWiden={widerPreset ? () => setPreset(widerPreset) : null}
        />
      );
    }
    if (series.phase === 'error' && series.error) {
      return <ErrorState error={series.error} onRetry={() => setAttempt((v) => v + 1)} />;
    }
    if (groups.length === 0) {
      if (series.phase === 'ready') {
        return (
          <EmptyState
            range={range}
            label={selectionLabel}
            onWiden={widerPreset ? () => setPreset(widerPreset) : null}
          />
        );
      }
      return <LoadingState waking={series.phase === 'waking'} seconds={series.elapsedSeconds} />;
    }

    return (
      <>
        <div className="py-2">
          {groups.map((group, index) => (
            <MetricChart
              key={group.unit ?? 'unitless'}
              group={group}
              range={range}
              showAxis={index === groups.length - 1}
            />
          ))}
        </div>

        <div className="border-t border-line px-5 py-4 text-[11px] leading-relaxed text-ink-muted sm:px-8">
          <p>
            Times in {timeZoneLabel()}; the collector records in UTC. Each point is a{' '}
            {formatDuration(stepSeconds)} average, and a gap in a line is a bucket that held no
            sample - never a zero. Shaded columns are stretches where nothing at all was recorded.
          </p>
          {(series.phase === 'loading' || series.phase === 'waking') && (
            <p className="mt-1 text-ink-dim">Reading the day-blobs for this window.</p>
          )}
          {skippedLines > 0 && (
            <p className="mt-1 text-series-2">
              {skippedLines} unreadable {skippedLines === 1 ? 'line was' : 'lines were'} skipped in
              storage, so this window may be missing points.
            </p>
          )}
        </div>
      </>
    );
  }
}
