import { useLayoutEffect, useRef, useState } from 'react';
import {
  ApiError,
  fetchDependencies,
  replaceDependencies,
  type ApplicationStatus,
} from '../api/client.ts';
import { cyclePathFromMessage } from '../lib/status.ts';
import { useLoader } from '../lib/use-loader.ts';
import { StatusBadge } from './status-badge.tsx';
import { Button } from './states.tsx';

/**
 * The dependency topology, drawn as an actual graph: no graph-drawing
 * library (the original decision stands - a handful of nodes does not
 * justify a layout-engine dependency), so layering and edge routing are done
 * by hand here, the same way `routes/landing.tsx#TimeAxisPreview` hand-draws
 * its SVG rather than reaching for a charting library for one static shape.
 *
 * Nodes are placed into columns by topological depth (a node with no
 * dependencies sits in column 0; everything else sits one column past its
 * deepest dependency), then an SVG overlay draws a cubic curve from each
 * dependency's right edge to its dependent's left edge, measured from the
 * real DOM via `getBoundingClientRect` after layout - there is no formula
 * for "where a node ended up", the node's own rendered position is the only
 * source of truth, same reasoning as this codebase's own rule against
 * deriving a number a real measurement should produce instead.
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
    // Full-bleed within the node card it now lives inside (`-mx-3 -mb-3`
    // cancels the node's own padding on those sides) rather than its own
    // bordered box, so opening the editor reads as the node expanding, not
    // a card nested inside a card.
    <div className="-mx-3 -mb-3 mt-2 border-t border-line-strong bg-bg-800 p-3">
      {candidates.length === 0 ? (
        <p className="text-[12px] text-ink-dim">
          No other applications in this project to depend on yet.
        </p>
      ) : (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[12px] text-ink-dim">
            {appLabel(application)} depends on
          </legend>
          {candidates.map((app) => (
            <label key={app.id} className="flex items-start gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={selected.has(app.id)}
                onChange={() => toggle(app.id)}
                className="mt-0.5 shrink-0"
              />
              <span className="min-w-0 flex-1 break-words font-mono">{appLabel(app)}</span>
            </label>
          ))}
        </fieldset>
      )}

      {cyclePath && (
        <div role="alert" className="mt-3 border border-status-critical/40 bg-bg-900 p-2.5">
          <p className="text-[12px] font-medium text-status-critical">
            That would create a dependency cycle
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[12px] text-ink">
            {cyclePath.map((key, index) => (
              <span key={`${key}-${index}`} className="flex items-center gap-1">
                {index > 0 && (
                  <span aria-hidden="true" className="text-ink-muted">
                    →
                  </span>
                )}
                {key}
              </span>
            ))}
          </p>
          <p className="mt-1 text-[11px] text-ink-muted">
            Remove one of the edges above to break the loop, then save again.
          </p>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-series-8">
          {error}
        </p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <Button onClick={handleSave} loading={saving}>
          {saving ? 'Saving…' : 'Save dependencies'}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-sm px-2.5 py-1.5 text-[12px] text-ink-dim transition-colors duration-150 hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

interface Edge {
  readonly key: string;
  readonly source: string; // the dependency
  readonly target: string; // the dependent
}

interface EdgePath {
  readonly key: string;
  readonly d: string;
}

/** Topological depth per node: 0 when it depends on nothing, otherwise one
 * past its deepest dependency. `visiting` only guards against a stale
 * optimistic override producing a momentary cycle client-side - the server
 * already rejects real cycles (409, handled in `EdgeEditor`) - so a node
 * caught mid-cycle just falls back to depth 0 instead of recursing forever. */
function computeLayers(
  applications: readonly ApplicationStatus[],
  edgesFor: (id: string) => string[],
): Map<string, number> {
  const layer = new Map<string, number>();
  const visiting = new Set<string>();

  function resolve(id: string): number {
    const cached = layer.get(id);
    if (cached !== undefined) return cached;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const deps = edgesFor(id).filter((depId) => depId !== id);
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((depId) => resolve(depId)));
    visiting.delete(id);
    layer.set(id, value);
    return value;
  }

  applications.forEach((app) => resolve(app.id));
  return layer;
}

function groupByLayer(applications: readonly ApplicationStatus[], layers: Map<string, number>) {
  const byLayer = new Map<number, string[]>();
  let maxLayer = 0;
  applications.forEach((app) => {
    const l = layers.get(app.id) ?? 0;
    maxLayer = Math.max(maxLayer, l);
    const column = byLayer.get(l) ?? [];
    column.push(app.id);
    byLayer.set(l, column);
  });
  return Array.from({ length: maxLayer + 1 }, (_, i) => byLayer.get(i) ?? []);
}

function samePaths(a: EdgePath[], b: EdgePath[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((edge, i) => edge.key === b[i]?.key && edge.d === b[i]?.d);
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [overrides, setOverrides] = useState<Map<string, string[]>>(new Map());

  const containerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [edgePaths, setEdgePaths] = useState<EdgePath[]>([]);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });

  const appById = new Map(applications.map((app) => [app.id, app]));
  const edgesFor = (id: string): string[] => overrides.get(id) ?? loader.data?.get(id) ?? [];
  const knownIds = new Set(ids);
  const edges: Edge[] = applications.flatMap((app) =>
    edgesFor(app.id)
      .filter((depId) => knownIds.has(depId))
      .map((depId) => ({ key: `${depId}=>${app.id}`, source: depId, target: app.id })),
  );

  // Recomputed after every commit (mount, data load, override applied, an
  // editor opening and changing a node's height, a window resize): with the
  // node count this view realistically has, redoing the measurement is
  // cheaper than trying to invalidate it correctly, and the equality checks
  // below stop it from looping.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const containerBox = container.getBoundingClientRect();

    const outgoing = new Map<string, Edge[]>();
    const incoming = new Map<string, Edge[]>();
    edges.forEach((edge) => {
      const out = outgoing.get(edge.source) ?? [];
      out.push(edge);
      outgoing.set(edge.source, out);
      const inc = incoming.get(edge.target) ?? [];
      inc.push(edge);
      incoming.set(edge.target, inc);
    });

    // Spreads a node's edges evenly across its height instead of every line
    // leaving/arriving at the exact same pixel - what keeps a 4+ dependent
    // fan-in from drawing as one illegible overlapping stack.
    function spread(nodeId: string, list: Edge[]): Map<string, number> {
      const positions = new Map<string, number>();
      const el = nodeRefs.current.get(nodeId);
      if (!el || list.length === 0) return positions;
      const box = el.getBoundingClientRect();
      const top = box.top - containerBox.top;
      list.forEach((edge, i) => {
        positions.set(edge.key, top + (box.height * (i + 1)) / (list.length + 1));
      });
      return positions;
    }

    const exitY = new Map<string, number>();
    outgoing.forEach((list, nodeId) => spread(nodeId, list).forEach((y, key) => exitY.set(key, y)));
    const entryY = new Map<string, number>();
    incoming.forEach((list, nodeId) =>
      spread(nodeId, list).forEach((y, key) => entryY.set(key, y)),
    );

    const nextPaths: EdgePath[] = [];
    edges.forEach((edge) => {
      const sourceEl = nodeRefs.current.get(edge.source);
      const targetEl = nodeRefs.current.get(edge.target);
      if (!sourceEl || !targetEl) return;
      const sourceBox = sourceEl.getBoundingClientRect();
      const targetBox = targetEl.getBoundingClientRect();
      const x1 = sourceBox.right - containerBox.left;
      const y1 = exitY.get(edge.key) ?? sourceBox.top - containerBox.top + sourceBox.height / 2;
      const x2 = targetBox.left - containerBox.left;
      const y2 = entryY.get(edge.key) ?? targetBox.top - containerBox.top + targetBox.height / 2;
      const bend = Math.max(24, (x2 - x1) / 2);
      nextPaths.push({
        key: edge.key,
        d: `M${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      });
    });

    setEdgePaths((prev) => (samePaths(prev, nextPaths) ? prev : nextPaths));
    setCanvasSize((prev) => {
      const width = container.scrollWidth;
      const height = container.scrollHeight;
      return prev.width === width && prev.height === height ? prev : { width, height };
    });
  });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      // Forces the effect above to run again; the observer's own callback
      // doesn't need to compute anything, only trigger a re-measure.
      setCanvasSize((prev) => ({ ...prev }));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  if (applications.length === 0) return null;

  if (loader.phase === 'error' && loader.error) {
    return (
      <p role="alert" className="text-[13px] text-series-8">
        {loader.error.message}
      </p>
    );
  }
  if (loader.phase === 'loading' || loader.phase === 'waking') {
    return <p className="text-[13px] text-ink-dim">Loading the dependency graph…</p>;
  }

  function renderNode(app: ApplicationStatus) {
    const deps = edgesFor(app.id);
    const editing = editingId === app.id;
    const depNames = deps.map((depId) => {
      const dep = appById.get(depId);
      return dep ? appLabel(dep) : depId;
    });

    return (
      <div
        key={app.id}
        ref={(el) => {
          if (el) nodeRefs.current.set(app.id, el);
          else nodeRefs.current.delete(app.id);
        }}
        className="rounded-md border border-line-strong bg-bg-900 p-3"
      >
        {/* The lines carry this relationship visually; screen reader users
            get the same fact as text, same pairing as
            `metric-chart.tsx`'s sr-only reading beside its chart. */}
        <p className="sr-only">
          {depNames.length > 0 ? `Depends on ${depNames.join(', ')}.` : 'Depends on nothing yet.'}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-mono text-[13px] text-ink">{appLabel(app)}</span>
          <StatusBadge status={app.effectiveStatus} />
        </div>
        <button
          type="button"
          onClick={() => setEditingId(editing ? null : app.id)}
          className="mt-2 rounded-sm border border-line-strong px-2 py-1 text-[11px] text-ink-dim transition-colors duration-150 hover:border-series-1 hover:text-series-1"
        >
          {editing ? 'Close' : deps.length > 0 ? 'Edit dependencies' : 'Connect dependencies'}
        </button>

        {editing && (
          <EdgeEditor
            application={app}
            applications={applications}
            current={deps}
            onCancel={() => setEditingId(null)}
            onSaved={(dependsOn) => {
              setOverrides((prev) => new Map(prev).set(app.id, dependsOn));
              setEditingId(null);
              onChanged();
            }}
          />
        )}
      </div>
    );
  }

  // Nothing connected anywhere yet (today's real production state - 5
  // applications, 0 edges): a single graph column would just be another
  // vertical list, which is the exact complaint this redesign exists to
  // fix. Framed as an open canvas instead - nodes laid out, dashed border,
  // copy that explains why it's empty and what to do about it - never a
  // blank or broken-looking graph.
  if (applications.length > 1 && edges.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-line-strong p-5">
        <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          No connections yet
        </p>
        <p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-ink-dim">
          These applications aren't linked yet. Click one to set what it depends on - once an edge
          exists, this becomes a real graph instead of a shelf of unconnected nodes.
        </p>
        <div className="mt-4 flex flex-wrap items-start gap-4">
          {applications.map((app) => (
            <div key={app.id} className="w-64 shrink-0">
              {renderNode(app)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  const columns = groupByLayer(applications, computeLayers(applications, edgesFor));

  return (
    <div>
      {edges.length > 0 && (
        <p className="mb-4 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
          <span aria-hidden="true" className="text-series-1">
            →
          </span>
          points toward what a dependency can affect
        </p>
      )}
      <div ref={containerRef} className="relative overflow-x-auto pb-1">
        <svg
          aria-hidden="true"
          className="pointer-events-none absolute left-0 top-0"
          width={canvasSize.width}
          height={canvasSize.height}
        >
          <defs>
            <marker
              id="dependency-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M0 0 L8 4 L0 8 Z" fill="var(--color-series-1)" />
            </marker>
          </defs>
          {edgePaths.map((path) => (
            <path
              key={path.key}
              d={path.d}
              fill="none"
              stroke="var(--color-series-1)"
              strokeWidth="1.5"
              markerEnd="url(#dependency-arrow)"
            />
          ))}
        </svg>
        <div className="relative flex items-start gap-x-14 gap-y-6">
          {columns.map((columnIds, columnIndex) => (
            <div key={columnIndex} className="flex w-64 shrink-0 flex-col gap-y-4">
              {columnIds.map((id) => renderNode(appById.get(id)!))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
