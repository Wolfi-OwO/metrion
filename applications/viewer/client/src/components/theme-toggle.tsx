import { useTheme } from '../lib/theme.ts';
import { MoonIcon, SunIcon } from './icon.tsx';

/**
 * One button that flips to the other theme. It names the destination
 * ("Switch to light theme"), not the current state, because that is what
 * pressing it does; the icon shows the same destination.
 */
export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="inline-flex h-11 w-11 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-raised hover:text-ink md:h-9 md:w-9"
    >
      {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}
