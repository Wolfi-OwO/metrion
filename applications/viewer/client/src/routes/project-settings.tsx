import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { ApiError, createApiKey, fetchApiKeys, revokeApiKey, type Project } from '../api/client.ts';
import { CopyButton } from '../components/copy-button.tsx';
import { StatusIcon } from '../components/icon.tsx';
import { ProjectShell } from '../components/project-shell.tsx';
import { Body, Button, Heading } from '../components/states.tsx';
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

// How long a first click stays armed before the second, confirming click is
// required again - long enough to move the pointer onto the same button,
// short enough that walking away from the tab doesn't leave it primed.
const REVOKE_ARM_MS = 4000;

function KeyListItem({ row, onRevoked }: { row: KeyRow; onRevoked: (id: string) => void }) {
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), REVOKE_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const handleRevoke = () => {
    if (!armed) {
      setArmed(true);
      return;
    }
    setArmed(false);
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
      <span className="font-mono text-body text-ink">mtr_{row.keyPrefix}_••••••••</span>
      <span className="font-mono text-meta text-ink-muted">
        created{' '}
        {new Date(row.createdAt).toLocaleString(undefined, {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}
      </span>
      {row.revoked ? (
        <span className="ml-auto text-label text-ink-muted">Revoked</span>
      ) : (
        // Solid fill, not the outlined default every other action on this page
        // uses - the one place in the app a destructive action is irreversible
        // with no undo, so it reads that way at rest, not only on hover.
        // First click only arms it (relabels to a confirmation); the second,
        // real click has to land on the same button within REVOKE_ARM_MS.
        <Button
          className="ml-auto"
          variant="primary"
          tone="danger"
          onClick={handleRevoke}
          onBlur={() => setArmed(false)}
          loading={revoking}
        >
          {revoking ? 'Revoking…' : armed ? 'Confirm revoke' : 'Revoke'}
        </Button>
      )}
      {error && (
        <p role="alert" className="w-full text-label text-text-danger">
          {error}
        </p>
      )}
    </li>
  );
}

/** Shown once, right after creation, then discarded from state entirely -
 * not merely hidden - when the caller confirms they copied it. From that
 * point on nothing in this page can put the secret back on screen, because
 * nothing in this page still holds it. Styled as the highest-stakes moment
 * in the product: an elevated, caution-bordered panel rather than a plain
 * bordered div, so it reads as a one-time, unrepeatable action rather than
 * an ordinary status message. */
function JustCreatedKey({ apiKey, onDone }: { apiKey: string; onDone: () => void }) {
  return (
    <div className="mt-4 overflow-hidden rounded-surface border border-text-caution/50 bg-bg-900 shadow-raised">
      <div className="flex items-start gap-3 border-b border-text-caution/30 bg-text-caution/10 px-gutter py-4">
        <span className="mt-0.5 shrink-0 text-text-caution">
          <StatusIcon status="warning" />
        </span>
        <div>
          <Heading>Your new key</Heading>
          <Body>
            This is the only time the full key is shown. Copy it now and store it wherever your
            collector reads its credentials from - it cannot be recovered once you leave this page.
          </Body>
        </div>
      </div>
      <div className="px-gutter py-4">
        <label htmlFor="just-created-key" className="text-label text-ink-dim">
          Full key
        </label>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            id="just-created-key"
            type="text"
            readOnly
            spellCheck={false}
            autoComplete="off"
            value={apiKey}
            onFocus={(event) => event.currentTarget.select()}
            className="w-full min-w-0 flex-1 rounded-control border border-line-strong bg-bg-950 px-2.5 py-1.5 font-mono text-label text-ink sm:w-auto"
          />
          <CopyButton text={apiKey} />
        </div>
        <Button className="mt-3" variant="primary" onClick={onDone}>
          I've saved it
        </Button>
      </div>
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
  const [keysReloadToken, setKeysReloadToken] = useState(0);
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
  }, [projectIdForKeys, keysReloadToken]);

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
    <ProjectShell auth={auth} lookup={lookup} projectId={projectId ?? ''}>
      {(project) => (
        <main className="flex-1 px-gutter py-8 sm:px-gutter-lg">
          <h1 className="text-heading font-semibold text-ink">API keys</h1>
          <p className="mt-1.5 max-w-prose text-body leading-relaxed text-ink-dim">
            A key authenticates <code className="font-mono text-ink">POST /api/v1/ingest</code> for{' '}
            <span className="font-mono text-ink">{project.name}</span>. Revoking one takes effect
            immediately - a collector still presenting it starts getting 401s on its next write.
          </p>

          {justCreated && (
            <JustCreatedKey apiKey={justCreated.key} onDone={() => setJustCreated(null)} />
          )}

          {!justCreated && (
            <Button className="mt-4" onClick={() => handleCreate(project)} loading={creating}>
              {creating ? 'Creating…' : 'Create new key'}
            </Button>
          )}
          {createError && (
            <p role="alert" className="mt-2 text-label text-text-danger">
              {createError}
            </p>
          )}

          <div className="mt-8 border-t border-line pt-4">
            <h2 className="font-mono text-label text-ink-dim">Existing keys</h2>

            {keysError && (
              <div className="mt-3 rounded-surface border border-line px-4 py-3.5" role="alert">
                <p className="font-medium text-label text-text-danger">Could not load API keys</p>
                <p className="mt-1 text-label text-ink-dim">{keysError}</p>
                <Button
                  className="mt-3"
                  variant="secondary"
                  onClick={() => setKeysReloadToken((token) => token + 1)}
                >
                  Try again
                </Button>
              </div>
            )}

            {!keysError && keysLoading && (
              <div className="mt-3 space-y-2" role="status" aria-live="polite">
                <span className="sr-only">Loading API keys…</span>
                <div className="h-11 animate-pulse rounded-control bg-bg-800" aria-hidden="true" />
                <div className="h-11 animate-pulse rounded-control bg-bg-800" aria-hidden="true" />
              </div>
            )}

            {!keysError && !keysLoading && keys.length === 0 && (
              <div className="mt-3 rounded-surface border border-dashed border-line px-4 py-4">
                <p className="text-body text-ink-dim">No keys yet</p>
                <p className="mt-1 text-label text-ink-muted">
                  Create one above - it appears here immediately, and that moment is the only chance
                  to copy its full value.
                </p>
              </div>
            )}

            {!keysError && !keysLoading && keys.length > 0 && (
              <ul className="mt-3 divide-y divide-line border-y border-line">
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
            )}
          </div>
        </main>
      )}
    </ProjectShell>
  );
}
