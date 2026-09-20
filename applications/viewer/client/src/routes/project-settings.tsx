import { useEffect, useState } from 'react';
import { useOutletContext, useParams } from 'react-router-dom';
import { ApiError, createApiKey, fetchApiKeys, revokeApiKey, type Project } from '../api/client.ts';
import { CopyButton } from '../components/copy-button.tsx';
import { StatusIcon } from '../components/icon.tsx';
import { ProjectShell } from '../components/project-shell.tsx';
import { Body, Button, Heading } from '../components/states.tsx';
import { formatAge } from '../lib/format.ts';
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
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
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

  const date = (value: string) =>
    new Date(value).toLocaleDateString(undefined, { dateStyle: 'medium' });

  return (
    <li
      className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-2 px-4 py-3 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_6rem] ${
        row.revoked ? 'text-ink-3' : ''
      }`}
    >
      <span
        className={`truncate font-mono text-label ${row.revoked ? 'text-ink-3 line-through' : 'text-ink'}`}
      >
        mtr_{row.keyPrefix}_••••••••
      </span>
      <span className="col-span-2 text-label text-ink-3 md:col-span-1 md:col-start-2 md:row-start-1">
        Created {date(row.createdAt)}
      </span>
      <span className="col-span-2 text-label text-ink-3 md:col-span-1 md:col-start-3 md:row-start-1">
        {row.revoked && row.revokedAt
          ? `Revoked ${date(row.revokedAt)}`
          : row.lastUsedAt
            ? `Last used ${formatAge(Date.now() - Date.parse(row.lastUsedAt))}`
            : 'Never used'}
      </span>
      <div className="col-start-2 row-start-1 md:col-start-4">
        {row.revoked ? (
          <span className="inline-flex items-center rounded-pill bg-raised px-2 py-px text-label font-medium text-ink-3">
            Revoked
          </span>
        ) : (
          // Outlined at rest, filled only once armed: the one irreversible
          // action in the app should not shout from every row, but the
          // confirming click must look different from the first. The first
          // click only arms it; the second has to land on the same button
          // within REVOKE_ARM_MS.
          <Button
            variant={armed ? 'primary' : 'secondary'}
            tone="danger"
            onClick={handleRevoke}
            onBlur={() => setArmed(false)}
            loading={revoking}
          >
            {revoking ? 'Revoking…' : armed ? 'Confirm revoke' : 'Revoke'}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="col-span-2 text-label text-text-danger md:col-span-4">
          {error}
        </p>
      )}
    </li>
  );
}

function JustCreatedKey({ apiKey, onDone }: { apiKey: string; onDone: () => void }) {
  return (
    // The one popover-level surface on this screen: it holds a secret that will
    // never be shown again, so it is lifted off the page and framed in the
    // caution colour instead of sitting in the list like a row.
    <div className="enter mt-6 overflow-hidden rounded-surface border border-text-caution/50 bg-surface shadow-popover">
      <div className="flex items-start gap-3 border-b border-text-caution/30 bg-text-caution/10 p-4 md:px-6">
        <span className="mt-1 shrink-0 text-text-caution">
          <StatusIcon status="warning" />
        </span>
        <div>
          <Heading>Copy your new key now</Heading>
          <Body>
            This is the only time the full key is shown. Store it wherever your collector reads its
            credentials from - it cannot be recovered once you leave this page.
          </Body>
        </div>
      </div>
      <div className="p-4 md:px-6 md:py-6">
        <label htmlFor="just-created-key" className="text-label font-medium text-ink-2">
          Full key
        </label>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            id="just-created-key"
            type="text"
            readOnly
            spellCheck={false}
            autoComplete="off"
            value={apiKey}
            onFocus={(event) => event.currentTarget.select()}
            className="min-h-11 w-full min-w-0 flex-1 rounded-control border border-control bg-bg px-3 font-mono text-label text-ink sm:w-auto md:min-h-9"
          />
          <CopyButton text={apiKey} />
        </div>
        <Button className="mt-4" variant="primary" onClick={onDone}>
          I&apos;ve saved it
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
            lastUsedAt: summary.lastUsedAt,
            revokedAt: summary.revokedAt,
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
            lastUsedAt: null,
            revokedAt: null,
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
        <main className="enter page flex-1 py-8 md:py-12">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-page font-semibold tracking-tight text-ink">API keys</h1>
              <p className="mt-1 max-w-prose text-body text-ink-2">
                A key authenticates{' '}
                <code className="font-mono text-label text-ink">POST /api/v1/ingest</code> for{' '}
                <span className="font-medium text-ink">{project.name}</span>. Revoking one takes
                effect immediately - a collector still presenting it starts getting 401s on its next
                write.
              </p>
            </div>
            {!justCreated && (keysLoading || keys.length > 0) && (
              <Button
                variant="primary"
                onClick={() => handleCreate(project)}
                loading={creating}
                disabled={keysLoading || keysError !== null}
              >
                {creating ? 'Creating…' : 'Create key'}
              </Button>
            )}
          </div>
          {createError && (
            <p role="alert" className="mt-3 text-label text-text-danger">
              {createError}
            </p>
          )}

          {justCreated && (
            <JustCreatedKey apiKey={justCreated.key} onDone={() => setJustCreated(null)} />
          )}

          <section className="mt-8" aria-labelledby="keys-heading">
            <h2 id="keys-heading" className="sr-only">
              Existing keys
            </h2>

            {keysError && (
              <div
                className="rounded-surface border border-status-critical/40 p-4 md:p-6"
                role="alert"
              >
                <p className="flex items-center gap-2 text-label font-medium text-text-danger">
                  <StatusIcon status="critical" />
                  Could not load API keys
                </p>
                <p className="mt-2 text-body text-ink-2">{keysError}</p>
                <Button
                  className="mt-4"
                  variant="primary"
                  onClick={() => setKeysReloadToken((token) => token + 1)}
                >
                  Try again
                </Button>
              </div>
            )}

            {!keysError && keysLoading && (
              <div
                className="divide-y divide-line overflow-hidden rounded-surface border border-line bg-surface"
                role="status"
                aria-live="polite"
              >
                <span className="sr-only">Loading API keys…</span>
                {[0, 1].map((row) => (
                  <div key={row} className="flex items-center gap-6 px-4 py-4" aria-hidden="true">
                    <div className="h-4 w-48 rounded-control bg-raised" />
                    <div className="h-4 w-28 rounded-control bg-raised" />
                  </div>
                ))}
              </div>
            )}

            {!keysError && !keysLoading && keys.length === 0 && !justCreated && (
              <div className="rounded-surface border border-dashed border-line-strong px-6 py-8">
                <h3 className="text-heading font-semibold tracking-tight text-ink">
                  No keys for this project yet
                </h3>
                <p className="mt-2 max-w-prose text-body text-ink-2">
                  A collector needs one to send metrics here. The key is shown once, right after you
                  create it - copy it before you leave the page.
                </p>
                <Button
                  className="mt-6"
                  variant="primary"
                  onClick={() => handleCreate(project)}
                  loading={creating}
                >
                  {creating ? 'Creating…' : 'Create your first key'}
                </Button>
              </div>
            )}

            {!keysError && !keysLoading && keys.length > 0 && (
              <>
                <div
                  aria-hidden="true"
                  className="hidden px-4 pb-2 text-label font-medium text-ink-3 md:grid md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1fr)_6rem] md:gap-x-6"
                >
                  <span>Key</span>
                  <span>Created</span>
                  <span>Activity</span>
                  <span />
                </div>
                <ul className="divide-y divide-line overflow-hidden rounded-surface border border-line bg-surface">
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
              </>
            )}
          </section>
        </main>
      )}
    </ProjectShell>
  );
}
