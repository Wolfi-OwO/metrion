import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { logout } from '../api/client.ts';
import { Brand } from './brand.tsx';
import { Button } from './states.tsx';

/**
 * The identity row on every signed-in screen - dashboard, a project's
 * metrics view, its settings - so "who am I" and "sign out" live in one
 * place rather than three. `children` is the breadcrumb slot: a project name
 * and its own settings link on the two project screens, nothing on the
 * dashboard.
 *
 * Below `sm` this used to `flex-wrap` the whole row, which broke the line
 * wherever the browser happened to run out of width - sometimes splitting
 * the email from the sign-out button it belongs with. It now stacks into two
 * deliberate rows instead: identity (brand + breadcrumb) on top, account
 * controls (email + sign-out) below, each internally consistent rather than
 * wherever the wrap landed. At `sm` and up both rows rejoin into the single
 * row this always was.
 */
export function AccountBar({
  email,
  onSignedOut,
  children,
}: {
  email: string;
  onSignedOut: () => void;
  children?: React.ReactNode;
}) {
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const handleSignOut = () => {
    setPending(true);
    setFailed(false);
    const controller = new AbortController();
    logout(controller.signal)
      .then(() => {
        onSignedOut();
        navigate('/');
      })
      .catch(() => {
        // Server-side session is still live here - don't navigate, that would
        // show a signed-out-looking shell over a session that never actually
        // ended. Surface it and let the button be pressed again instead.
        setPending(false);
        setFailed(true);
      });
  };

  return (
    <div className="flex items-center gap-x-4 px-gutter py-1 sm:gap-x-6 sm:px-gutter-lg">
      <div className="flex min-w-0 items-center gap-x-4">
        <Brand />
        {children}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-x-2 sm:gap-x-4">
        <span className="min-w-0 truncate font-mono text-meta text-ink-3 max-sm:sr-only">
          {email}
        </span>
        {failed && (
          <p role="alert" className="text-label text-text-danger">
            Could not sign out. Try again.
          </p>
        )}
        <Button variant="quiet" onClick={handleSignOut} loading={pending}>
          {pending ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </div>
  );
}
