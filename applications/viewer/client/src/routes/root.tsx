import { useOutletContext } from 'react-router-dom';
import { PublicHeader } from '../components/public-header.tsx';
import type { AuthState } from '../lib/use-auth.ts';
import DashboardRoute from './dashboard.tsx';
import LandingRoute from './landing.tsx';

/**
 * `/` is one URL with two screens behind it: the marketing landing page for
 * a signed-out visitor, the project list for a signed-in one. Splitting them
 * into two routes would need a redirect either way for a bookmark to `/`,
 * which is worse than the one status check this does instead.
 */
export default function RootRoute() {
  const auth = useOutletContext<AuthState>();

  if (auth.status === 'loading') {
    // A header with just the wordmark, not a screen-centred sentence: the
    // auth check this waits on is a single fast request, and every other
    // screen this can resolve into (landing, dashboard) opens with the same
    // header shape, so showing it immediately avoids a layout jump the
    // instant the check finishes.
    return (
      <>
        <PublicHeader />
        <main className="page flex-1 py-16">
          <p role="status" aria-live="polite" className="text-body text-ink-2">
            Checking your session…
          </p>
        </main>
      </>
    );
  }

  if (auth.status === 'signed-in' && auth.user) {
    return <DashboardRoute user={auth.user} onSignedOut={auth.refresh} />;
  }

  return <LandingRoute />;
}
