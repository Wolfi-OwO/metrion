import { Link } from 'react-router-dom';
import { Brand } from '../components/brand.tsx';
import { Body, Heading, buttonClassName } from '../components/states.tsx';

/**
 * The catch-all route. `App.tsx`'s footer still renders around this, so the
 * legal links stay reachable from a mistyped URL exactly as they do from
 * every other screen. Its own header repeats just the wordmark - not the
 * full signed-in chrome, since a 404 has no account or breadcrumb to show -
 * so there is still a way back to `/` above the fold instead of one link
 * buried in a paragraph.
 */
export default function NotFoundRoute() {
  return (
    <>
      <header className="border-b border-line px-gutter py-4 sm:px-gutter-lg">
        <Brand />
      </header>
      <main className="flex-1 px-gutter py-14 sm:px-gutter-lg">
        <div className="flex max-w-prose flex-col gap-3">
          <p className="font-mono text-meta uppercase tracking-eyebrow text-ink-muted">404</p>
          <Heading level="h1">Page not found</Heading>
          <Body>
            There is nothing at this address. It may have moved, or the link was mistyped.
          </Body>
          <Link to="/" className={buttonClassName('primary', 'default', 'mt-1 self-start')}>
            Go back home
          </Link>
        </div>
      </main>
    </>
  );
}
