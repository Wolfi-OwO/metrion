import type { Status } from '../api/client.ts';
import { STATUS_LABEL } from '../lib/status.ts';

const STATUS_TEXT_CLASS: Record<Status, string> = {
  ok: 'text-status-ok',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
};

/**
 * Shape carries the state on its own, independent of hue: circle, triangle,
 * diamond are three different silhouettes in a greyscale screenshot, which a
 * colour swap alone never would be - and red/green confusion is the single
 * most common colour-vision deficiency, the one pair this app's whole status
 * vocabulary (ok -> critical) rests on.
 */
function StatusIcon({ status }: { status: Status }) {
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

/**
 * Every application row and the dashboard's project card render this, never
 * a bare colour swatch: icon shape + colour + the word itself are three
 * independent channels, so the state still reads with any one of them
 * removed (greyscale print, colour-blind vision, a screen reader that skips
 * `aria-hidden` icons and reads only the text).
 */
export function StatusBadge({ status, className = '' }: { status: Status; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 font-mono text-[11px] font-medium ${STATUS_TEXT_CLASS[status]} ${className}`}
    >
      <StatusIcon status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}
