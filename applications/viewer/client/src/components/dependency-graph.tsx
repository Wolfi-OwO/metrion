import { useMemo, useState } from 'react';
import {
  ApiError,
  fetchDependencies,
  replaceDependencies,
  type ApplicationStatus,
  type Status,
} from '../api/client.ts';
import {
  edgePath,
  layoutGraph,
  NODE_HEIGHT,
  NODE_WIDTH,
  type LayoutEdge,
} from '../lib/graph-layout.ts';
import { cyclePathFromMessage } from '../lib/status.ts';
import { useLoader } from '../lib/use-loader.ts';
import { StatusBadge } from './status-badge.tsx';
import { StatusIcon } from './icon.tsx';
import { Button } from './states.tsx';

/**
 * The dependency topology as a drawn graph, with no graph library: a handful
 * of nodes does not justify a layout engine. Every coordinate comes from
 * `lib/graph-layout.ts` (pure numbers, unit-tested), so the lines and the
 * nodes cannot disagree - the earlier version measured the DOM and drew
 * curves between the measurements, which drifted whenever a node changed
 * height and routed long edges straight through the nodes in between.
 *
 * What is drawn, and why:
 *  - nodes are compact (name, status) and carry a status stripe on their left
 *    edge, so the graph reads as a map of health before it reads as a map of
 *    structure; editing lives in the detail panel below, not inside a node;
 *  - an edge is neutral grey unless an outage travels along it (both ends are
 *    unhealthy), in which case it takes the colour of the dependency it comes
 *    from - so the blast radius of a root cause is the coloured part;
 *  - hovering or selecting an application dims every edge that is not its own;
 *  - applications with no edges are not drawn on the canvas at all - a wall of
 *    unconnected boxes is noise - and are listed underneath instead.
 */

function appLabel(app: { key: string; displayName: string | null }): string {
  return app.displayName ?? app.key;
}

function EdgeEditor({
  application,
  applications,
  current,
  onSaved,
  onCancel,
}: {
  application: ApplicationStatus;
  applications: readonly ApplicationStatus[];
  current: string[];
  onSaved: (dependsOn: string[]) => void;
  onCancel: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(current));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cyclePath, setCyclePath] = useState<string[] | null>(null);

  const candidates = applications.filter((app) => app.id !== application.id);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = () => {
    setSaving(true);
    setError(null);
    setCyclePath(null);
    const controller = new AbortController();
    replaceDependencies(application.id, [...selected], controller.signal)
      .then((result) => onSaved(result.dependsOn))
      .catch((cause: unknown) => {
        if (cause instanceof ApiError && cause.status === 409) {
          const path = cyclePathFromMessage(cause.message);
          if (path) {
            setCyclePath(path);
            return;
          }
        }
        setError(cause instanceof ApiError ? cause.message : 'Could not save dependencies.');
      })
      .finally(() => setSaving(false));
  };

  return (
    <div className="mt-4 border-t border-line pt-4">
      {candidates.length === 0 ? (
        <p className="text-label text-ink-2">
          No other applications in this group to depend on yet.
        </p>
      ) : (
        <fieldset className="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3">
          <legend className="mb-2 text-label font-medium text-ink-2">
            {appLabel(application)} depends on
          </legend>
          {candidates.map((app) => (
            <label
              key={app.id}
              className="flex min-h-11 items-center gap-3 text-body text-ink md:min-h-8"
            >
              <input
                type="checkbox"
                checked={selected.has(app.id)}
                onChange={() => toggle(app.id)}
                className="h-4 w-4 shrink-0 accent-accent"
              />
              <span className="min-w-0 flex-1 break-words">{appLabel(app)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {cyclePath && (
        <div
          role="alert"
          className="mt-4 rounded-control border border-status-critical/40 bg-status-critical/8 p-3"
        >
          <p className="text-label font-medium text-status-critical">
            That would create a dependency cycle
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1 font-mono text-label text-ink">
            {cyclePath.map((key, index) => (
              <span key={`${key}-${index}`} className="flex items-center gap-1">
                {index > 0 && (
                  <span aria-hidden="true" className="text-ink-3">
                    →
                  </span>
                )}
                {key}
              </span>
            ))}
          </p>
          <p className="mt-1 text-meta text-ink-3">
            Remove one of the edges above to break the loop, then save again.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-label text-text-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center gap-2">
        <Button onClick={handleSave} loading={saving}>
          {saving ? 'Saving…' : 'Save dependencies'}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const STRIPE: Record<Status, string> = {
  ok: 'bg-status-ok',
  warning: 'bg-status-warning',
  critical: 'bg-status-critical',
};

const EDGE_COLOUR: Record<Status, string> = {
  ok: 'var(--color-control)',
  warning: 'var(--color-status-warning)',
  critical: 'var(--color-status-critical)',
};

function GraphNode({
  app,
  selected,
  dependsOn,
  onSelect,
  onHover,
  style,
}: {
  app: ApplicationStatus;
  selected: boolean;
  dependsOn: string[];
  onSelect: () => void;
  onHover?: (hovering: boolean) => void;
  style?: React.CSSProperties;
}) {
  const unhealthy = app.effectiveStatus !== 'ok';
  const isRoot = unhealthy && app.causedBy === null;
  return (
    <button
      type="button"
      onClick={onSelect}
      onMouseEnter={() => onHover?.(true)}
      onMouseLeave={() => onHover?.(false)}
      onFocus={() => onHover?.(true)}
      onBlur={() => onHover?.(false)}
      aria-pressed={selected}
      aria-label={`${appLabel(app)}, ${STATUS_WORD[app.effectiveStatus]}. ${
        dependsOn.length > 0 ? `Depends on ${dependsOn.join(', ')}.` : 'Depends on nothing.'
      }`}
      style={style}
      className={`group relative flex min-h-11 flex-col justify-center overflow-hidden rounded-control border bg-surface py-2 pr-3 pl-4 text-left transition-colors md:min-h-0 ${
        selected
          ? 'border-accent'
          : isRoot
            ? 'border-status-critical/60 hover:border-status-critical'
            : 'border-line-strong hover:border-control'
      }`}
    >
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${STRIPE[app.effectiveStatus]}`}
      />
      <span className="truncate text-body font-medium text-ink">{appLabel(app)}</span>
      <span
        className={`flex items-center gap-1 text-label ${
          app.effectiveStatus === 'ok'
            ? 'text-ink-3'
            : app.effectiveStatus === 'warning'
              ? 'text-status-warning'
              : 'text-status-critical'
        }`}
      >
        <StatusIcon status={app.effectiveStatus} />
        {STATUS_WORD[app.effectiveStatus]}
        {isRoot && <span className="text-ink-3">· root cause</span>}
      </span>
    </button>
  );
}

const STATUS_WORD: Record<Status, string> = { ok: 'OK', warning: 'Warning', critical: 'Critical' };

function NameList({
  title,
  ids,
  appById,
  onSelect,
}: {
  title: string;
  ids: string[];
  appById: Map<string, ApplicationStatus>;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="min-w-0">
      <h4 className="text-label font-medium text-ink-2">{title}</h4>
      {ids.length === 0 ? (
        <p className="mt-1 text-body text-ink-3">Nothing.</p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-2">
          {ids.map((id) => {
            const app = appById.get(id);
            if (!app) return null;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => onSelect(id)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-control border border-line-strong bg-raised px-3 text-label text-ink transition-colors hover:border-control md:min-h-8"
                >
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-pill ${STRIPE[app.effectiveStatus]}`}
                  />
                  {appLabel(app)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function DependencyGraph({
  applications,
  onChanged,
}: {
  applications: readonly ApplicationStatus[];
  onChanged: () => void;
}) {
  const ids = applications.map((app) => app.id);
  const loader = useLoader(
    `dependencies/${ids.join(',')}`,
    async (signal) => {
      const results = await Promise.all(ids.map((id) => fetchDependencies(id, signal)));
      const byApp = new Map<string, string[]>();
      ids.forEach((id, index) => byApp.set(id, results[index]!.dependsOn));
      return byApp;
    },
    ids.length > 0,
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [overrides, setOverrides] = useState<Map<string, string[]>>(new Map());

  const appById = new Map(applications.map((app) => [app.id, app]));
  const edgesFor = (id: string): string[] => overrides.get(id) ?? loader.data?.get(id) ?? [];
  const known = new Set(ids);
  const edges: LayoutEdge[] = applications.flatMap((app) =>
    edgesFor(app.id)
      .filter((depId) => known.has(depId))
      .map((depId) => ({ source: depId, target: app.id })),
  );
  const edgeSignature = edges.map((edge) => `${edge.source}>${edge.target}`).join('|');
  // `edges` is rebuilt every render; its signature is the real dependency.
  const layout = useMemo(() => layoutGraph(ids, edges), [ids.join(','), edgeSignature]);

  if (applications.length === 0) return null;

  if (loader.phase === 'error' && loader.error) {
    return (
      <p role="alert" className="text-body text-text-danger">
        {loader.error.message}
      </p>
    );
  }
  if (loader.phase === 'loading' || loader.phase === 'waking') {
    return <p className="text-body text-ink-2">Loading the dependency graph…</p>;
  }

  // Land on the thing worth looking at: the first application that is
  // unhealthy for its own reasons. Falls back to nothing selected.
  const rootCause = applications.find((app) => app.effectiveStatus !== 'ok' && !app.causedBy);
  const selectedId = picked ?? rootCause?.id ?? null;
  const selected = selectedId ? appById.get(selectedId) : undefined;
  const focusId = hovered ?? selectedId;

  const dependsOn = selected ? edgesFor(selected.id).filter((id) => known.has(id)) : [];
  const dependents = selected
    ? applications.filter((app) => edgesFor(app.id).includes(selected.id)).map((app) => app.id)
    : [];

  const select = (id: string) => {
    setPicked(id);
    setEditing(false);
  };

  const depNames = (id: string) =>
    edgesFor(id)
      .map((depId) => appById.get(depId))
      .filter((dep): dep is ApplicationStatus => dep !== undefined)
      .map(appLabel);

  return (
    <div>
      {layout.nodes.length > 0 ? (
        <div className="overflow-x-auto rounded-surface border border-line bg-surface p-4">
          <div className="relative mx-auto" style={{ width: layout.width, height: layout.height }}>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute top-0 left-0"
              width={layout.width}
              height={layout.height}
            >
              <defs>
                {(['ok', 'warning', 'critical'] as const).map((status) => (
                  <marker
                    key={status}
                    id={`dependency-arrow-${status}`}
                    viewBox="0 0 8 8"
                    refX="7"
                    refY="4"
                    markerWidth="7"
                    markerHeight="7"
                    orient="auto-start-reverse"
                  >
                    <path d="M0 0 L8 4 L0 8 Z" fill={EDGE_COLOUR[status]} />
                  </marker>
                ))}
              </defs>
              {layout.edges.map((edge) => {
                const from = appById.get(edge.source);
                const to = appById.get(edge.target);
                // An outage travels along an edge when both ends are unhealthy.
                const carried: Status =
                  from && to && from.effectiveStatus !== 'ok' && to.effectiveStatus !== 'ok'
                    ? from.effectiveStatus
                    : 'ok';
                const incident = focusId === edge.source || focusId === edge.target;
                return (
                  <path
                    key={`${edge.source}>${edge.target}`}
                    d={edgePath(edge.points)}
                    fill="none"
                    stroke={EDGE_COLOUR[carried]}
                    strokeWidth={carried === 'ok' ? 1.25 : 2}
                    markerEnd={`url(#dependency-arrow-${carried})`}
                    style={{
                      opacity: focusId && !incident ? 0.2 : 1,
                      transition: 'opacity var(--duration-fast) var(--ease-instrument)',
                    }}
                  />
                );
              })}
            </svg>
            {layout.nodes.map((node) => {
              const app = appById.get(node.id);
              if (!app) return null;
              return (
                <GraphNode
                  key={node.id}
                  app={app}
                  selected={selectedId === node.id}
                  dependsOn={depNames(node.id)}
                  onSelect={() => select(node.id)}
                  onHover={(on) => setHovered(on ? node.id : null)}
                  style={{
                    position: 'absolute',
                    left: node.x,
                    top: node.y,
                    width: NODE_WIDTH,
                    minHeight: NODE_HEIGHT,
                  }}
                />
              );
            })}
          </div>
          <p className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-label text-ink-3">
            <span>Arrows point from a dependency to what depends on it.</span>
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true" className="h-0.5 w-5 bg-status-critical" />
              an outage is travelling along this edge
            </span>
          </p>
        </div>
      ) : (
        <div className="rounded-surface border border-dashed border-line-strong p-6">
          <p className="text-body font-medium text-ink">No connections yet</p>
          <p className="mt-1 max-w-prose text-body text-ink-2">
            Select an application below and choose what it depends on. Once an edge exists this
            becomes a graph, and an outage in a dependency shows up on everything downstream of it.
          </p>
        </div>
      )}

      {layout.isolated.length > 0 && (
        <div className="mt-6">
          <h3 className="text-label font-medium text-ink-2">
            {layout.nodes.length > 0 ? 'Not connected' : 'Applications'}{' '}
            <span className="font-mono text-ink-3">{layout.isolated.length}</span>
          </h3>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {layout.isolated.map((id) => {
              const app = appById.get(id);
              if (!app) return null;
              return (
                <GraphNode
                  key={id}
                  app={app}
                  selected={selectedId === id}
                  dependsOn={[]}
                  onSelect={() => select(id)}
                />
              );
            })}
          </div>
        </div>
      )}

      <section
        aria-label="Selected application"
        className="mt-6 rounded-surface border border-line bg-surface p-4 md:p-6"
      >
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 className="text-heading font-semibold tracking-tight text-ink">
                {appLabel(selected)}
              </h3>
              <StatusBadge status={selected.effectiveStatus} />
              <span className="font-mono text-meta text-ink-3">{selected.key}</span>
            </div>
            {selected.causedBy && (
              <p className="mt-2 text-body text-ink-2">
                Degraded because <span className="text-ink">{selected.causedBy.key}</span> is{' '}
                {appById.get(selected.causedBy.id)?.status ?? 'unhealthy'}.
              </p>
            )}
            <div className="mt-6 grid gap-6 md:grid-cols-2">
              <NameList title="Depends on" ids={dependsOn} appById={appById} onSelect={select} />
              <NameList
                title="Depended on by"
                ids={dependents}
                appById={appById}
                onSelect={select}
              />
            </div>
            {editing ? (
              <EdgeEditor
                application={selected}
                applications={applications}
                current={dependsOn}
                onCancel={() => setEditing(false)}
                onSaved={(next) => {
                  setOverrides((prev) => new Map(prev).set(selected.id, next));
                  setEditing(false);
                  onChanged();
                }}
              />
            ) : (
              <Button className="mt-6" onClick={() => setEditing(true)}>
                {dependsOn.length > 0 ? 'Edit dependencies' : 'Connect dependencies'}
              </Button>
            )}
          </>
        ) : (
          <p className="text-body text-ink-2">
            Select an application to see what it depends on, and to change that.
          </p>
        )}
      </section>
    </div>
  );
}
