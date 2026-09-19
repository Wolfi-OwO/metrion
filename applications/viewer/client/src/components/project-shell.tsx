import type { ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import type { Project } from '../api/client.ts';
import type { AuthState } from '../lib/use-auth.ts';
import type { ProjectLookup } from '../lib/use-projects.ts';
import { AccountBar } from './account-bar.tsx';
import { Body, ErrorState, Heading, LoadingState, Panel } from './states.tsx';

/**
 * The AccountBar + breadcrumb row every project screen wraps its content in.
 * `ProjectShell` below renders one for its own (non-ready) phases; the ready
 * state of `project-metrics.tsx` renders its own second instance with
 * `sticky` and an extra row (resource picker, loading bar) passed as
 * `children`, rather than duplicating the AccountBar/nav markup again.
 */
export function ProjectHeader({
  email,
  onSignedOut,
  breadcrumb,
  sticky = false,
  children,
}: {
  email: string;
  onSignedOut: () => void;
  breadcrumb: ReactNode;
  sticky?: boolean;
  children?: ReactNode;
}) {
  return (
    <header className={`border-b border-line bg-bg-900${sticky ? ' sticky top-0 z-10' : ''}`}>
      <AccountBar email={email} onSignedOut={onSignedOut}>
        <nav aria-label="Breadcrumb" className="flex items-center gap-x-2 text-label text-ink-dim">
          {breadcrumb}
        </nav>
      </AccountBar>
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
  breadcrumb,
  children,
}: {
  auth: AuthState;
  lookup: ProjectLookup;
  breadcrumb: ReactNode;
  children: (project: Project, email: string, onSignedOut: () => void) => ReactNode;
}) {
  // Reachable only from a signed-in screen's own links, but a bookmarked or
  // hand-typed URL can still land here signed out - back to the root, which
  // resolves to the landing page for that visitor rather than a 401 behind a
  // chart nothing will ever load into.
  if (auth.status === 'signed-out') return <Navigate to="/" replace />;

  const email = auth.user?.email ?? '';
  const header = <ProjectHeader email={email} onSignedOut={auth.refresh} breadcrumb={breadcrumb} />;

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
              <Link to="/" className="text-series-1 hover:underline">
                Back to your projects
              </Link>
              .
            </Body>
          </Panel>
        </main>
      </>
    );
  }

  return <>{children(lookup.project, email, auth.refresh)}</>;
}
