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

  const handleSignOut = () => {
    setPending(true);
    const controller = new AbortController();
    logout(controller.signal)
      .then(() => {
        onSignedOut();
        navigate('/');
      })
      .catch(() => setPending(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-5 py-2.5 sm:px-8">
      <Brand />
      {children}
      <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-[11px] text-ink-muted">{email}</span>
        <Button variant="quiet" onClick={handleSignOut} loading={pending}>
          {pending ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </div>
  );
}
