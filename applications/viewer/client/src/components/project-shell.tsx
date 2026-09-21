import type { ReactNode } from 'react';
import { Link, Navigate, NavLink } from 'react-router-dom';
import type { Project } from '../api/client.ts';
import type { AuthState } from '../lib/use-auth.ts';
import type { ProjectLookup } from '../lib/use-projects.ts';
import { AccountBar } from './account-bar.tsx';
import { Body, ErrorState, Heading, LoadingState, Panel } from './states.tsx';

const TABS = [
  { label: 'Overview', to: '', end: true },
  { label: 'Status', to: '/status', end: false },
  { label: 'Settings', to: '/settings', end: false },
] as const;

/**
 * The AccountBar, breadcrumb and section tabs every project screen wraps its
 * content in. The Status and Settings screens used to render without any of
 * it once their data had loaded - `ProjectShell` drew the header only for its
 * own loading/error/not-found branches - which left a signed-in visitor on
 * those two screens with no logo, no way back and no sign-out. The header now
 * lives here, keyed on the URL's project id, so it is identical in every
 * phase and never flickers between them.
 *
 * `children` is the metrics screen's data toolbar; it sits inside the same
 * sticky block so the tabs and the controls scroll away together.
 */
export function ProjectHeader({
  email,
  onSignedOut,
  projectId,
  projectName,
  sticky = false,
  children,
}: {
  email: string;
  onSignedOut: () => void;
  projectId: string;
  projectName: string | null;
  sticky?: boolean;
  children?: ReactNode;
}) {
  return (
    <header
      className={`border-b border-line bg-surface${sticky ? ' md:sticky md:top-0 md:z-(--z-sticky)' : ''}`}
    >
      <AccountBar email={email} onSignedOut={onSignedOut}>
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-x-2 text-label text-ink-2"
        >
          <Link
            to="/"
            className="inline-flex min-h-11 items-center transition-colors duration-(--duration-fast) hover:text-ink md:min-h-0"
          >
            Projects
          </Link>
          <span aria-hidden="true">/</span>
          <span className="truncate text-ink">{projectName ?? '…'}</span>
        </nav>
      </AccountBar>
      <nav aria-label="Project sections" className="page flex gap-x-6">
        {TABS.map((tab) => (
          <NavLink
            key={tab.label}
            to={`/projects/${encodeURIComponent(projectId)}${tab.to}`}
            end={tab.end}
            className={({ isActive }) =>
              `-mb-px flex min-h-11 min-w-11 items-center justify-center border-b-2 text-label font-medium transition-colors duration-(--duration-fast) ${
                isActive ? 'border-accent text-ink' : 'border-transparent text-ink-2 hover:text-ink'
              }`
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      {children}
    </header>
  );
}

/**
 * What was copy-pasted three times across `project-metrics.tsx`,
 * `project-settings.tsx` and `project-status.tsx`: the signed-out redirect
 * guard, the header, and the four lookup branches (error, loading/waking,
 * not-found, ready). Each route now supplies only its own breadcrumb tail
 * and its ready-state body via `children`.
 */
export function ProjectShell({
  auth,
  lookup,
  projectId,
  ownsHeader = false,
  children,
}: {
  auth: AuthState;
  lookup: ProjectLookup;
  projectId: string;
  /** The metrics screen renders its own header because its data toolbar
   * lives inside it; every other screen gets the plain one from here. */
  ownsHeader?: boolean;
  children: (project: Project, email: string, onSignedOut: () => void) => ReactNode;
}) {
  // Reachable only from a signed-in screen's own links, but a bookmarked or
  // hand-typed URL can still land here signed out - back to the root, which
  // resolves to the landing page for that visitor rather than a 401 behind a
  // chart nothing will ever load into.
  if (auth.status === 'signed-out') return <Navigate to="/" replace />;

  const email = auth.user?.email ?? '';
  const header = (
    <ProjectHeader
      email={email}
      onSignedOut={auth.refresh}
      projectId={projectId}
      projectName={lookup.project?.name ?? null}
    />
  );

  if (lookup.phase === 'error' && lookup.error) {
    return (
      <>
        {header}
        <main className="flex-1">
          <ErrorState error={lookup.error} onRetry={lookup.reload} />
        </main>
      </>
    );
  }

  if (lookup.phase === 'loading' || lookup.phase === 'waking') {
    return (
      <>
        {header}
        <main className="flex-1">
          <LoadingState waking={lookup.phase === 'waking'} seconds={lookup.elapsedSeconds} />
        </main>
      </>
    );
  }

  if (!lookup.project) {
    return (
      <>
        {header}
        <main className="flex-1">
          <Panel>
            <Heading>Project not found</Heading>
            <Body>
              It may have been removed, or it belongs to a different account.{' '}
              <Link to="/" className="text-accent hover:underline">
                Back to your projects
              </Link>
              .
            </Body>
          </Panel>
        </main>
      </>
    );
  }

  if (ownsHeader) return <>{children(lookup.project, email, auth.refresh)}</>;
  return (
    <>
      {header}
      {children(lookup.project, email, auth.refresh)}
    </>
  );
}
