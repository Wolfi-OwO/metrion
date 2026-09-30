import type { Status } from '../api/client.ts';
import {
  formatRelative,
  freshnessOf,
  type Totals,
  type Verdict,
  type VerdictTone,
} from '../lib/dashboard.ts';
import { Ghost } from './ghost.tsx';
import { StatusIcon } from './icon.tsx';
import { FreshnessDot, HealthBar } from './project-visuals.tsx';

/**
 * The account at a glance, as one instrument with three readouts: a verdict
 * (what to do), the health distribution (how bad, how many) and freshness (can
 * I trust it). One bordered surface split by hairlines rather than three cards
 * or five loose numbers.
 *
 * `BandFrame` owns the geometry. The real band and its skeleton both render
 * through it, so their cells have the same padding, gaps and line heights and
 * the swap moves nothing.
 */
const CELL = 'flex min-w-0 flex-col justify-center gap-2 px-4 py-3 lg:px-6 lg:py-4';
// Freshness is two short lines; on a phone they share one row, which takes a
// third row of the band's height back from the small screen.
const FRESH_CELL =
  'max-lg:flex-row max-lg:flex-wrap max-lg:items-center max-lg:gap-x-3 max-lg:gap-y-0';

export function BandFrame({
  verdict,
  distribution,
  freshness,
  className = '',
  children,
}: {
  verdict: React.ReactNode;
  distribution: React.ReactNode;
  freshness: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-label="Overview"
      className={`relative rounded-surface border border-line bg-surface ${className}`}
    >
      <div className="grid divide-y divide-line lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_minmax(0,1fr)] lg:divide-x lg:divide-y-0">
        <div className={CELL}>{verdict}</div>
        <div className={CELL}>{distribution}</div>
        <div className={`${CELL} ${FRESH_CELL}`}>{freshness}</div>
      </div>
      {children}
    </section>
  );
}

const TONE_CHIP: Record<VerdictTone, string> = {
  ok: 'bg-status-ok/12 text-status-ok',
  warning: 'bg-status-warning/12 text-status-warning',
  critical: 'bg-status-critical/12 text-status-critical',
  neutral: 'bg-raised text-ink-3',
};

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

const LEGEND: { status: Status; label: string; tone: string }[] = [
  { status: 'ok', label: 'Healthy', tone: 'text-status-ok' },
  { status: 'warning', label: 'Warning', tone: 'text-status-warning' },
  { status: 'critical', label: 'Critical', tone: 'text-status-critical' },
];

export function OverviewBand({
  verdict,
  totals,
  now,
}: {
  verdict: Verdict;
  totals: Totals;
  now: number;
}) {
  const fresh = freshnessOf(totals.lastSampleAt, now);
  const freshLabel = { fresh: 'Live', stale: 'Stale', none: 'No data yet' }[fresh];
  return (
    <BandFrame
      verdict={
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className={`flex size-8 shrink-0 items-center justify-center rounded-pill [&>svg]:size-4 ${TONE_CHIP[verdict.tone]}`}
          >
            {verdict.tone === 'neutral' ? (
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
                <circle cx="8" cy="8" r="5.5" />
              </svg>
            ) : (
              <StatusIcon status={verdict.tone} />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-heading font-semibold tracking-tight text-ink">
              {verdict.headline}
            </h2>
            <p className="truncate text-label text-ink-3">
              {plural(totals.projects, 'group')} · {plural(totals.applications, 'application')}
            </p>
          </div>
        </div>
      }
      distribution={
        <>
          <dl className="flex flex-wrap gap-x-6 gap-y-1">
            {LEGEND.map(({ status, label, tone }) => {
              const value = totals[status];
              return (
                <div key={status} className="flex items-baseline gap-2">
                  <dt className="flex items-center gap-2 text-label text-ink-3">
                    <span className={value > 0 ? tone : 'text-ink-3'}>
                      <StatusIcon status={status} />
                    </span>
                    {label}
                  </dt>
                  <dd
                    className={`text-body font-medium tabular-nums ${value > 0 ? 'text-ink' : 'text-ink-3'}`}
                  >
                    {value}
                  </dd>
                </div>
              );
            })}
          </dl>
          <HealthBar counts={totals} className="w-full" />
        </>
      }
      freshness={
        <>
          <p className="flex items-center gap-2 text-label font-medium text-ink">
            <FreshnessDot state={fresh} pulse />
            {freshLabel}
          </p>
          <p className="truncate text-label text-ink-3">
            {totals.lastSampleAt === null ? (
              'Waiting for the first sample'
            ) : (
              <>
                Last data{' '}
                <time dateTime={new Date(totals.lastSampleAt).toISOString()}>
                  {formatRelative(now - totals.lastSampleAt)}
                </time>
              </>
            )}
          </p>
        </>
      }
    />
  );
}

/**
 * The band's skeleton. `waking` lays the cold-start explanation over the same
 * box (absolute, so it adds no height): the copy is honest about the 5-15 s
 * wait, and the counter keeps it obviously alive when reduced motion stops the
 * sweep. The status element is always mounted so a screen reader hears the
 * change from "Loading groups" to the wake notice.
 */
export function OverviewBandSkeleton({ waking, seconds }: { waking: boolean; seconds: number }) {
  return (
    <BandFrame
      verdict={
        <div className="flex items-center gap-3" aria-hidden="true">
          <Ghost className="size-8 shrink-0 rounded-pill" />
          <div className="min-w-0">
            <div className="text-heading">
              <Ghost className="w-48 max-w-full" />
            </div>
            <div className="text-label">
              <Ghost className="w-32" />
            </div>
          </div>
        </div>
      }
      distribution={
        <div aria-hidden="true" className="contents">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-body">
            <Ghost className="w-20" />
            <Ghost className="w-20" />
            <Ghost className="w-20" />
          </div>
          <Ghost className="h-2 w-full rounded-pill" />
        </div>
      }
      freshness={
        <div aria-hidden="true" className="contents">
          <div className="text-label">
            <Ghost className="w-16" />
          </div>
          <div className="text-label">
            <Ghost className="w-28" />
          </div>
        </div>
      }
    >
      <div
        role="status"
        aria-live="polite"
        className={
          waking
            ? 'absolute inset-0 flex flex-col justify-center overflow-hidden rounded-surface bg-surface px-4 py-3 lg:px-6 lg:py-4'
            : 'sr-only'
        }
      >
        {waking ? (
          <>
            <p className="text-heading font-semibold tracking-tight text-ink">Waking the server</p>
            <p className="text-body text-ink-2">
              It shuts down when nobody is watching, so the first request takes 5 to 15 seconds.
              Still going after <span className="font-mono text-ink">{seconds}</span>{' '}
              {seconds === 1 ? 'second' : 'seconds'}.
            </p>
            <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
              <div className="sweep absolute inset-y-0 left-0 w-1/4 bg-linear-to-r from-transparent via-accent to-transparent" />
            </div>
          </>
        ) : (
          'Loading groups'
        )}
      </div>
    </BandFrame>
  );
}
