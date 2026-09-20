import type { ReactNode } from 'react';
import { Brand } from './brand.tsx';
import { ThemeToggle } from './theme-toggle.tsx';

/**
 * The header for screens with no signed-in account to show: landing, 404, the
 * crash screen and the auth check. Same container, same height and same
 * wordmark position as the signed-in `AccountBar`, so moving between the two
 * does not shift the logo.
 */
export function PublicHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="page flex items-center gap-x-4 py-1">
        <Brand />
        <div className="ml-auto flex items-center gap-x-2">
          {children}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
