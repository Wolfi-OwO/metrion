import type { Status } from '../api/client.ts';
import { StatusIcon } from './icon.tsx';
import { STATUS_LABEL } from '../lib/status.ts';

const STATUS_TEXT_CLASS: Record<Status, string> = {
  ok: 'text-status-ok',
  warning: 'text-status-warning',
  critical: 'text-status-critical',
};

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
