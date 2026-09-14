import { useState } from 'react';
import {
  ApiError,
  fetchDependencies,
  replaceDependencies,
  type ApplicationStatus,
} from '../api/client.ts';
import { cyclePathFromMessage } from '../lib/status.ts';
import { useLoader } from '../lib/use-loader.ts';
import { StatusBadge } from './status-badge.tsx';
import { ActionButton } from './states.tsx';

/**
 * The dependency topology: no graph-drawing library (the issue's own
 * instruction - a dozen nodes do not justify a layout engine), so this is a
 * flat list of applications with each one's direct `dependsOn` edges
 * indented underneath it. Depth is one level on purpose - `causedBy` in the
 * status response already names the ultimate transitive cause regardless of
 * how many edges deep it sits, so the attribution text (rendered by the
 * caller, `project-status.tsx`) does the transitive job; this view only has
 * to show what a person would actually edit, which is always a direct edge.
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
    <div className="mt-2 border border-line-strong bg-bg-800 p-3">
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
            <label key={app.id} className="flex items-center gap-2 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={selected.has(app.id)}
                onChange={() => toggle(app.id)}
              />
              <span className="font-mono">{appLabel(app)}</span>
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
        <ActionButton onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save dependencies'}
        </ActionButton>
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

  const appById = new Map(applications.map((app) => [app.id, app]));
  const edgesFor = (id: string): string[] => overrides.get(id) ?? loader.data?.get(id) ?? [];

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

  return (
    <ul className="divide-y divide-line border-y border-line">
      {applications.map((app) => {
        const deps = edgesFor(app.id);
        return (
          <li key={app.id} className="px-1 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-[13px] text-ink">{appLabel(app)}</span>
              <StatusBadge status={app.effectiveStatus} />
              <button
                type="button"
                onClick={() => setEditingId(editingId === app.id ? null : app.id)}
                className="ml-auto rounded-sm border border-line-strong px-2.5 py-1 text-[12px] text-ink-dim transition-colors duration-150 hover:border-series-1 hover:text-series-1"
              >
                {editingId === app.id ? 'Close' : 'Edit dependencies'}
              </button>
            </div>

            {deps.length > 0 && editingId !== app.id && (
              <ul className="mt-1.5 ml-4 flex flex-col gap-1 border-l border-line pl-3">
                {deps.map((depId) => {
                  const dep = appById.get(depId);
                  return (
                    <li key={depId} className="flex items-center gap-2 text-[12px]">
                      <span className="text-ink-muted">depends on</span>
                      <a href={`#app-${depId}`} className="font-mono text-ink hover:text-series-1">
                        {dep ? appLabel(dep) : depId}
                      </a>
                      {dep && <StatusBadge status={dep.effectiveStatus} />}
                    </li>
                  );
                })}
              </ul>
            )}
            {deps.length === 0 && editingId !== app.id && (
              <p className="mt-1 ml-4 text-[12px] text-ink-muted">Depends on nothing.</p>
            )}

            {editingId === app.id && (
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
          </li>
        );
      })}
    </ul>
  );
}
