import { Outlet } from 'react-router-dom';
import { RouteErrorBoundary } from './components/error-boundary.tsx';
import { Footer } from './components/footer.tsx';
import { useAuth } from './lib/use-auth.ts';

/**
 * The shared chrome around every screen. Nothing but the footer is common to
 * the landing page, the dashboard, a project's two screens and the not-found
 * route, so this file owns only that plus the one `/api/v1/me` check every
 * route below reads via `useOutletContext` - one request per page load, not
 * one per screen.
 *
 * A router is new here (`main.tsx`): the single-screen app this replaces had
 * exactly one thing to look at and a route would have been a second way to
 * express state a `useState` pair already held. Five screens with distinct
 * URLs worth linking to and refreshing on - landing, dashboard, a project's
 * metrics, its settings, not-found - is what changed that.
 */
export default function App() {
  const auth = useAuth();

  return (
    <div className="flex min-h-dvh flex-col pb-(--footer-h)">
      <RouteErrorBoundary>
        <Outlet context={auth} />
      </RouteErrorBoundary>
      <Footer />
    </div>
  );
}
