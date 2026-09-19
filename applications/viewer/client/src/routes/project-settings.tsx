import { useEffect, useState } from 'react';
import { Link, useOutletContext, useParams } from 'react-router-dom';
import { ApiError, createApiKey, fetchApiKeys, revokeApiKey, type Project } from '../api/client.ts';
import { CopyButton } from '../components/copy-button.tsx';
import { ProjectShell } from '../components/project-shell.tsx';
import { ActionButton, Body, Heading } from '../components/states.tsx';
import type { AuthState } from '../lib/use-auth.ts';
import { useProject } from '../lib/use-projects.ts';

/**
 * `/projects/:projectId/settings` - API key creation, revocation and now
 * listing (`GET /api/v1/projects/:id/keys`, metadata only - see
 * `handlers/projects.handlers.ts`). Existing keys load once the project is
 * known and merge with anything just created in this same visit, so a key
 * minted a moment ago and a key minted last week both show up the same way.
 */

interface KeyRow {
  readonly id: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
  revoked: boolean;
}

function KeyListItem({ row, onRevoked }: { row: KeyRow; onRevoked: (id: string) => void }) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRevoke = () => {
    setRevoking(true);
    setError(null);
    const controller = new AbortController();
    revokeApiKey(row.id, controller.signal)
      .then(() => onRevoked(row.id))
      .catch((cause: unknown) => {
        setError(cause instanceof ApiError ? cause.message : 'Could not revoke the key.');
      })
      .finally(() => setRevoking(false));
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 py-3">
      <span className="font-mono text-[13px] text-ink">mtr_{row.keyPrefix}_••••••••</span>
      <span className="font-mono text-[11px] text-ink-muted">
        created{' '}
        {new Date(row.createdAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}
      </span>
      {row.revoked ? (
        <span className="ml-auto text-[12px] text-ink-muted">Revoked</span>
      ) : (
        <ActionButton className="ml-auto" onClick={handleRevoke} disabled={revoking}>
          {revoking ? 'Revoking…' : 'Revoke'}
        </ActionButton>
      )}
      {error && (
        <p role="alert" className="w-full text-[12px] text-series-8">
          {error}
        </p>
      )}
    </li>
  );
}

/** Shown once, right after creation, then discarded from state entirely -
 * not merely hidden - when the caller confirms they copied it. From that
 * point on nothing in this page can put the secret back on screen, because
 * nothing in this page still holds it. */
function JustCreatedKey({ apiKey, onDone }: { apiKey: string; onDone: () => void }) {
  return (
    <div className="mt-4 border border-line-strong bg-bg-800 px-4 py-3">
      <Heading>Your new key</Heading>
      <Body>
        This is the only time the full key is shown. Copy it now and store it wherever your
        collector reads its credentials from.
      </Body>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="text"
          readOnly
          value={apiKey}
          onFocus={(event) => event.currentTarget.select()}
          aria-label="New API key"
          className="w-full min-w-0 flex-1 rounded-sm border border-line-strong bg-bg-900 px-2.5 py-1.5 font-mono text-[12px] text-ink sm:w-auto"
        />
        <CopyButton text={apiKey} />
      </div>
      <ActionButton className="mt-3" onClick={onDone}>
        I've saved it
      </ActionButton>
    </div>
  );
}

export default function ProjectSettingsRoute() {
  const { projectId } = useParams<{ projectId: string }>();
  const auth = useOutletContext<AuthState>();
  const lookup = useProject(projectId ?? '', auth.status !== 'loading');

  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [keysLoading, setKeysLoading] = useState(true);
  const [keysError, setKeysError] = useState<string | null>(null);
  const [justCreated, setJustCreated] = useState<{ id: string; key: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Declared unconditionally, before the `<ProjectShell>` return below whose
  // phase branching this component has no say in - `lookup.project` is not
  // yet known on the first render that reaches this hook, same reason the
  // effect checks for it itself rather than this component skipping the
  // hook entirely.
  const projectIdForKeys = lookup.project?.id;
  useEffect(() => {
    if (!projectIdForKeys) return;
    const controller = new AbortController();
    setKeysLoading(true);
    setKeysError(null);
    fetchApiKeys(projectIdForKeys, controller.signal)
      .then((summaries) => {
        setKeys(
          summaries.map((summary) => ({
            id: summary.id,
            keyPrefix: summary.keyPrefix,
            createdAt: summary.createdAt,
            revoked: summary.revokedAt !== null,
          })),
        );
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setKeysError(cause instanceof ApiError ? cause.message : 'Could not load API keys.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setKeysLoading(false);
      });
    return () => controller.abort();
  }, [projectIdForKeys]);

  const handleCreate = (project: Project) => {
    setCreating(true);
    setCreateError(null);
    const controller = new AbortController();
    createApiKey(project.id, controller.signal)
      .then((created) => {
        setJustCreated({ id: created.id, key: created.key });
        setKeys((current) => [
          {
            id: created.id,
            keyPrefix: created.keyPrefix,
            createdAt: created.createdAt,
            revoked: false,
          },
          ...current,
        ]);
      })
      .catch((cause: unknown) => {
        setCreateError(cause instanceof ApiError ? cause.message : 'Could not create a key.');
      })
      .finally(() => setCreating(false));
  };

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
          <span className="text-ink">Settings</span>
        </>
      }
    >
      {(project) => (
        <main className="flex-1 px-5 py-8 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h1 className="text-[15px] font-semibold text-ink">API keys</h1>
            <Link
              to={`/projects/${project.id}/status`}
              className="rounded-sm border border-line-strong px-2.5 py-1 text-[12px] text-ink-dim transition-colors duration-150 hover:border-series-1 hover:text-series-1"
            >
              Status, dependencies and thresholds
            </Link>
          </div>
          <p className="mt-1.5 max-w-prose text-[13px] leading-relaxed text-ink-dim">
            A key authenticates <code className="font-mono text-ink">POST /api/v1/ingest</code>{' '}
            for <span className="font-mono text-ink">{project.name}</span>. Revoking one takes
            effect immediately - a collector still presenting it starts getting 401s on its next
            write.
          </p>

          {justCreated && (
            <JustCreatedKey apiKey={justCreated.key} onDone={() => setJustCreated(null)} />
          )}

          {!justCreated && (
            <ActionButton className="mt-4" onClick={() => handleCreate(project)} disabled={creating}>
              {creating ? 'Creating…' : 'Create new key'}
            </ActionButton>
          )}
          {createError && (
            <p role="alert" className="mt-2 text-[12px] text-series-8">
              {createError}
            </p>
          )}

          <div className="mt-8 border-t border-line pt-4">
            <h2 className="font-mono text-[12px] text-ink-dim">Existing keys</h2>
            {keysError && (
              <p role="alert" className="mt-2 text-[13px] text-series-8">
                {keysError}
              </p>
            )}
            {!keysError && keysLoading ? (
              <p className="mt-2 text-[13px] text-ink-dim">Loading…</p>
            ) : !keysError && keys.length === 0 ? (
              <p className="mt-2 text-[13px] text-ink-dim">
                None yet. A key created here shows up in this list right away.
              </p>
            ) : !keysError ? (
              <ul className="mt-2 divide-y divide-line border-y border-line">
                {keys.map((row) => (
                  <KeyListItem
                    key={row.id}
                    row={row}
                    onRevoked={(id) =>
                      setKeys((current) =>
                        current.map((k) => (k.id === id ? { ...k, revoked: true } : k)),
                      )
                    }
                  />
                ))}
              </ul>
            ) : null}
          </div>
        </main>
      )}
    </ProjectShell>
  );
}
