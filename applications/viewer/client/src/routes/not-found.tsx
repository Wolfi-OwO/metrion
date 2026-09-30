import { Link } from 'react-router-dom';
import { PublicHeader } from '../components/public-header.tsx';
import { Body, buttonClassName, Heading } from '../components/states.tsx';

/**
 * The catch-all route. `App.tsx`'s footer still renders around this, so the
 * legal links stay reachable from a mistyped URL exactly as they do from
 * every other screen. The header repeats the wordmark only - a 404 has no
 * account or breadcrumb to show - so there is a way back above the fold
 * instead of one link buried in a paragraph.
 */
export default function NotFoundRoute() {
  return (
    <>
      <PublicHeader />
      <main className="enter page flex-1 py-12">
        <p className="text-display font-semibold tracking-tight text-line-strong">404</p>
        <div className="mt-4 max-w-prose">
          <Heading level="h1">There is nothing at this address</Heading>
          <Body>
            It may have moved, or the link was mistyped. Your groups are one click away.
          </Body>
          <Link to="/" className={buttonClassName('primary', 'default', 'mt-6')}>
            Back to your groups
          </Link>
        </div>
      </main>
    </>
  );
}
