import { useId, useMemo } from 'react';
import type { Status } from '../api/client.ts';
import type { Freshness } from '../lib/dashboard.ts';
import { describeActivity, sparklinePaths } from '../lib/sparkline.ts';

const SEGMENT: Record<Status, string> = {
  critical: 'bg-status-critical',
  warning: 'bg-status-warning',
  ok: 'bg-status-ok',
};

export interface HealthCounts {
  readonly ok: number;
  readonly warning: number;
  readonly critical: number;
}

/**
 * Applications split by health as one stacked bar, worst first so a problem is
 * at the left edge where the eye starts. Colour is a redundant glance: the
 * counts are in the accessible name and the tooltip, and the row's pill names
 * the worst status in words.
 */
export function HealthBar({
  counts,
  className = '',
}: {
  counts: HealthCounts;
  className?: string;
}) {
  const total = counts.ok + counts.warning + counts.critical;
  const parts = (['critical', 'warning', 'ok'] as const).filter((s) => counts[s] > 0);
  const label = total === 0 ? 'No applications' : parts.map((s) => `${counts[s]} ${s}`).join(', ');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={`flex h-2 gap-px overflow-hidden rounded-pill bg-raised ${className}`}
    >
      {parts.map((s) => (
        <span key={s} className={SEGMENT[s]} style={{ width: `${(counts[s] / total) * 100}%` }} />
      ))}
    </span>
  );
}

const SPARK_W = 96;
const SPARK_H = 24;

/**
 * 24 hourly sample counts as a line. The newest hour is still filling, so its
 * segment is dashed: a solid line would read the partial hour as a drop in
 * activity, and it is not one.
 */
export function Sparkline({ values }: { values: readonly number[] }) {
  const { paths, label } = useMemo(
    () => ({ paths: sparklinePaths(values, SPARK_W, SPARK_H), label: describeActivity(values) }),
    [values],
  );
  const { line, area, tail, total } = paths;
  // Unique per instance: two rows sharing one gradient id would share whichever
  // definition the browser found first, which breaks once one is display:none.
  const fade = useId();
  const solid = line.includes(' L') ? line.slice(0, line.lastIndexOf(' L')) : line;
  const stroke = total > 0 ? 'var(--color-accent)' : 'var(--color-ink-3)';
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      width={SPARK_W}
      height={SPARK_H}
      className="block shrink-0 overflow-visible"
    >
      <title>{label}</title>
      {total > 0 && (
        <>
          <defs>
            <linearGradient id={fade} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--color-accent)" stopOpacity={0.24} />
              <stop offset="1" stopColor="var(--color-accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${fade})`} />
        </>
      )}
      <g fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d={solid} />
        <path d={tail} strokeDasharray="2 3" />
      </g>
    </svg>
  );
}

/** The dot beside a freshness label; `pulse` is only for the one in the overview band. */
export function FreshnessDot({ state, pulse = false }: { state: Freshness; pulse?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className="live-dot"
      data-state={state}
      data-still={pulse ? undefined : ''}
    />
  );
}
