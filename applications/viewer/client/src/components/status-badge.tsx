import type { Status } from '../api/client.ts';
import { StatusIcon } from './icon.tsx';
import { STATUS_LABEL } from '../lib/status.ts';

// Colour is the third channel here, after the icon's shape and the word. The
// tinted pill exists so a status reads as a status at a glance in a dense
// list, without a full-width coloured row.
const STATUS_CLASS: Record<Status, string> = {
  ok: 'bg-status-ok/12 text-status-ok',
  warning: 'bg-status-warning/12 text-status-warning',
  critical: 'bg-status-critical/12 text-status-critical',
};

export function StatusBadge({ status, className = '' }: { status: Status; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill py-px pr-2 pl-2 text-label font-medium ${STATUS_CLASS[status]} ${className}`}
    >
      <StatusIcon status={status} />
      {STATUS_LABEL[status]}
    </span>
  );
}
