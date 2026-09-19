import { Component, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Brand } from './brand.tsx';
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
          <header className="border-b border-line px-gutter py-4 sm:px-gutter-lg">
            <Brand />
          </header>
          <main className="flex-1 px-gutter py-14 sm:px-gutter-lg">
            <div role="alert" className="flex max-w-prose flex-col gap-3">
              {/* `critical` reuses the app's own colour-blind-safe status
                  vocabulary (filled diamond, `components/icon.tsx`) rather
                  than a fresh glyph - this genuinely is that severity, not a
                  borrowed one. */}
              <div className="flex items-center gap-2 font-mono text-meta uppercase tracking-eyebrow text-text-danger">
                <StatusIcon status="critical" />
                <span>Error</span>
              </div>
              <Heading level="h1">Something went wrong</Heading>
              <Body>
                This screen hit an unexpected error. Reloading the page usually clears it.
              </Body>
              <div className="mt-1 flex flex-wrap gap-3">
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
