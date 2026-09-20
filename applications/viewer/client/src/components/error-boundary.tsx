import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { PublicHeader } from './public-header.tsx';
import { StatusIcon } from './icon.tsx';
import { Body, Button, Heading, buttonClassName } from './states.tsx';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render-time crash in whichever route is active so the chrome
 * around it - `App.tsx`'s footer and its legal links - keeps rendering
 * instead of the whole page going blank. A React error boundary must be a
 * class; there is no hook equivalent for `getDerivedStateFromError`.
 */
export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error('A route crashed:', error);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <>
          <PublicHeader />
          <main className="enter page flex-1 py-12">
            <div role="alert" className="max-w-prose">
              {/* `critical` reuses the app's own colour-blind-safe status
                  vocabulary (filled diamond) rather than a fresh glyph. */}
              <div className="flex items-center gap-2 text-label font-medium text-text-danger">
                <StatusIcon status="critical" />
                <span>Error</span>
              </div>
              <div className="mt-2">
                <Heading level="h1">Something went wrong</Heading>
                <Body>
                  This screen hit an unexpected error. Reloading the page usually clears it.
                </Body>
              </div>
              <div className="mt-6 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => window.location.reload()}>
                  Reload page
                </Button>
                <Link to="/" className={buttonClassName('quiet')}>
                  Go home
                </Link>
              </div>
            </div>
          </main>
        </>
      );
    }
    return this.props.children;
  }
}
