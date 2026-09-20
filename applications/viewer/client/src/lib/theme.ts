import { useCallback, useSyncExternalStore } from 'react';

/**
 * Light or dark, with the OS preference as the default and an explicit choice
 * that sticks. The CSS does the actual work: `styles/index.css` carries the
 * light values under both `:root[data-theme='light']` (the explicit choice)
 * and a `prefers-color-scheme: light` media query (no choice made), so the
 * first paint is already right before this script has run. This module only
 * records the choice and sets the attribute.
 */

export type Theme = 'dark' | 'light';

const KEY = 'metrion-theme';
// Matches --color-bg in each theme, for the browser chrome on mobile.
const CHROME: Record<Theme, string> = { dark: '#0b0d10', light: '#f6f6f4' };

function stored(): Theme | null {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'dark' || value === 'light' ? value : null;
  } catch {
    // Storage blocked (private mode, a policy): the OS preference still works.
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function current(): Theme {
  return stored() ?? systemTheme();
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function apply(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme === null) root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  // An explicit choice overrides the media-scoped theme-color tags from
  // index.html; with no choice they keep answering for the OS.
  if (theme !== null) {
    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => meta.setAttribute('content', CHROME[theme]));
  }
}

/** Call once, before the first render. */
export function initTheme(): void {
  apply(stored());
  window
    .matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', () => stored() === null && notify());
}

export function useTheme(): { theme: Theme; toggle: () => void } {
  const theme = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current,
    () => 'dark' as const,
  );
  const toggle = useCallback(() => {
    const next: Theme = current() === 'dark' ? 'light' : 'dark';
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      /* the choice still applies for this page view */
    }
    apply(next);
    notify();
  }, []);
  return { theme, toggle };
}
