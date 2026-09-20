import type { Status } from '../api/client.ts';

/**
 * The app's whole glyph vocabulary, in one file, as two deliberately
 * different families rather than one unified icon component:
 *
 * - Line icons (`ScopeIcon`): 16x16 viewBox, `currentColor`, no fill beyond
 *   a 1.25 stroke. `ICON_STROKE_PROPS` below is that contract as an actual
 *   props object, not prose repeated at every call site - a new line icon
 *   spreads it and only supplies its own `path`/`rect`/`circle` children.
 * - `StatusIcon`: filled silhouettes (circle/triangle/diamond), never
 *   stroked - see the comment on the component itself for why the fill is
 *   load-bearing there rather than decoration, and why it keeps its own
 *   shape instead of joining the stroke family above.
 *
 * The three OAuth provider marks in `routes/landing.tsx` are NOT here: they
 * are licensed brand marks under each provider's own guidelines, not this
 * app's icon language, and stay exactly where and as they are.
 */

export const ICON_STROKE_PROPS = {
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.25,
} as const;

export type ScopeIconId = 'host' | 'container' | 'request';

export function ScopeIcon({
  id,
  className = 'shrink-0 text-ink-2',
}: {
  id: ScopeIconId;
  className?: string;
}) {
  const props = { ...ICON_STROKE_PROPS, width: 18, height: 18, className };
  switch (id) {
    case 'host':
      return (
        <svg {...props}>
          <rect x="1.5" y="1.5" width="13" height="4.2" rx="0.8" />
          <rect x="1.5" y="6.9" width="13" height="4.2" rx="0.8" />
          <rect x="1.5" y="12.3" width="13" height="2.2" rx="0.6" />
          <circle cx="4" cy="3.6" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="4" cy="9" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'container':
      return (
        <svg {...props}>
          <path d="M8 1.3 14.5 5v6L8 14.7 1.5 11V5Z" />
          <path d="M1.5 5 8 8.5l6.5-3.5" />
          <path d="M8 8.5v6.2" />
        </svg>
      );
    case 'request':
      return (
        <svg {...props}>
          <path d="M2 5.5h10" />
          <path d="M9 2.8 11.8 5.5 9 8.2" />
          <path d="M14 10.5H4" />
          <path d="M7 7.8 4.2 10.5 7 13.2" />
        </svg>
      );
  }
}

/**
 * Shape carries the state on its own, independent of hue: circle, triangle,
 * diamond are three different silhouettes in a greyscale screenshot, which a
 * colour swap alone never would be - and red/green confusion is the single
 * most common colour-vision deficiency, the one pair this app's whole status
 * vocabulary (ok -> critical) rests on. Filled, not stroked, unlike
 * `ScopeIcon` above: here the shape itself carries meaning, the one case the
 * "no fill" rule of the stroke family exists to exclude.
 */
export function StatusIcon({ status }: { status: Status }) {
  switch (status) {
    case 'ok':
      return (
        <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true" className="shrink-0">
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
        </svg>
      );
    case 'warning':
      return (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="shrink-0">
          <path d="M8 1 L15.5 14.5 H0.5 Z" fill="currentColor" />
        </svg>
      );
    case 'critical':
      return (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true" className="shrink-0">
          <path d="M8 0.5 L15.5 8 L8 15.5 L0.5 8 Z" fill="currentColor" />
        </svg>
      );
  }
}

/** The `</>` glyph in the footer's build-info pill. */
export function CodeIcon({ className = 'shrink-0 text-accent' }: { className?: string }) {
  return (
    <svg {...ICON_STROKE_PROPS} width={14} height={14} className={className}>
      <path d="m5 4.5-3.5 3.5L5 11.5M11 4.5 14.5 8 11 11.5M9.2 3 6.8 13" />
    </svg>
  );
}

export function ChevronIcon({ className = 'shrink-0 text-ink-3' }: { className?: string }) {
  return (
    <svg {...ICON_STROKE_PROPS} width={16} height={16} strokeWidth={1.5} className={className}>
      <path d="m6 3.5 4.5 4.5L6 12.5" />
    </svg>
  );
}
