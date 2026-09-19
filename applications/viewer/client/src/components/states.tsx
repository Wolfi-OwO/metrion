import type { ApiError } from '../api/client.ts';
import { formatTimestamp } from '../lib/format.ts';
import type { TimeRange } from '../lib/range.ts';

/**
 * The three states this app is never allowed to render as a blank page:
 * waking, empty and failed. Each one says what happened and offers the one
 * action that makes sense next.
 */

// Exported: the dashboard and project-settings screens (`routes/`) reuse
// this trio for their own empty and error panels rather than each growing a
// slightly different one.
export function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-64 flex-col items-start justify-center gap-3 px-gutter py-14 sm:px-gutter-lg">
      <div className="max-w-prose">{children}</div>
    </div>
  );
}

export function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-heading font-semibold text-ink">{children}</h2>;
}

export function Body({ children }: { children: React.ReactNode }) {
  return <p className="mt-1.5 text-body leading-relaxed text-ink-dim">{children}</p>;
}

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonTone = 'default' | 'danger';

const BUTTON_BASE =
  'inline-flex items-center justify-center gap-1.5 rounded-control text-label font-medium transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-wait aria-busy:opacity-70';

// Every fragment below is a real, static Tailwind class string (never built
// from a template literal) so the v4 build's source scan can see it - a
// `hover:border-series-${n}` built at runtime would compile to nothing.
// Structure (border/padding/fill/text colour) and tone (which accent hover
// and active reach for) vary independently, so each is named once and
// combined per cell rather than retyped six times.
const VARIANT_STRUCTURE: Record<ButtonVariant, string> = {
  primary: 'border border-transparent px-3 py-1.5 text-bg-950',
  secondary: 'border border-line-strong bg-bg-800 px-3 py-1.5 text-ink',
  quiet: 'border border-line-strong px-2.5 py-1 text-ink-dim',
};

const FILL_TONE: Record<ButtonTone, string> = {
  default: 'bg-series-1 hover:bg-series-1/85 active:bg-series-1/70',
  danger: 'bg-series-8 hover:bg-series-8/85 active:bg-series-8/70',
};

const OUTLINE_TONE: Record<ButtonTone, string> = {
  default: 'hover:border-series-1 hover:text-series-1 active:border-series-1/70 active:text-series-1/70',
  danger: 'hover:border-series-8 hover:text-series-8 active:border-series-8/70 active:text-series-8/70',
};

const VARIANT_CLASS: Record<ButtonVariant, Record<ButtonTone, string>> = {
  primary: {
    default: `${VARIANT_STRUCTURE.primary} ${FILL_TONE.default}`,
    danger: `${VARIANT_STRUCTURE.primary} ${FILL_TONE.danger}`,
  },
  secondary: {
    default: `${VARIANT_STRUCTURE.secondary} ${OUTLINE_TONE.default}`,
    danger: `${VARIANT_STRUCTURE.secondary} ${OUTLINE_TONE.danger}`,
  },
  quiet: {
    default: `${VARIANT_STRUCTURE.quiet} ${OUTLINE_TONE.default}`,
    danger: `${VARIANT_STRUCTURE.quiet} ${OUTLINE_TONE.danger}`,
  },
};

/**
 * Focus is deliberately not styled here: the global `button:focus-visible`
 * rule in `styles/index.css` already draws one ring for every interactive
 * element in the app, so a second, component-local ring would be a second
 * place that colour could drift from the first.
 */
export function buttonClassName(
  variant: ButtonVariant = 'secondary',
  tone: ButtonTone = 'default',
  className = '',
): string {
  return `${BUTTON_BASE} ${VARIANT_CLASS[variant][tone]} ${className}`.trim();
}

export function Button({
  onClick,
  children,
  type = 'button',
  variant = 'secondary',
  tone = 'default',
  disabled = false,
  loading = false,
  className = '',
}: {
  onClick?: () => void;
  children: React.ReactNode;
  type?: 'button' | 'submit';
  variant?: ButtonVariant;
  tone?: ButtonTone;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClassName(variant, tone, className)}
    >
      {children}
    </button>
  );
}

/**
 * The placeholder axis. Sized like a real chart row so nothing jumps when the
 * data lands, and deliberately empty rather than filled with fake bars - a
 * skeleton shaped like data is a small lie about what is coming.
 */
function AxisGhost({ sweeping }: { sweeping: boolean }) {
  return (
    <div className="relative h-28 w-full overflow-hidden border-y border-line" aria-hidden="true">
      <div className="absolute inset-x-0 top-0 flex h-full flex-col justify-between">
        {[0, 1, 2, 3].map((line) => (
          <div key={line} className="h-px w-full bg-bg-800" />
        ))}
      </div>
      {sweeping && (
        <div className="sweep absolute inset-y-0 left-0 w-1/4 bg-linear-to-r from-transparent via-series-1/12 to-transparent" />
      )}
    </div>
  );
}

/**
 * Under `WAKE_AFTER_MS` this is a silent placeholder; past it, it explains the
 * cold start and counts. The counter is the point: an incrementing number is
 * the difference between "still working" and "hung", which a spinner cannot
 * express, and it keeps working when reduced motion stops the sweep.
 */
export function LoadingState({ waking, seconds }: { waking: boolean; seconds: number }) {
  return (
    <div className="px-gutter py-8 sm:px-gutter-lg">
      <div
        role="status"
        aria-live="polite"
        className="mb-5 min-h-12 max-w-prose"
        // The whole block is replaced when it changes, so a screen reader is
        // told once that the server is waking rather than once per second.
      >
        {waking && (
          <>
            <Heading>Waking the server</Heading>
            <Body>
              It shuts down when nobody is watching, so the first request takes 5 to 15 seconds.
              Still going after {seconds} {seconds === 1 ? 'second' : 'seconds'}.
            </Body>
          </>
        )}
      </div>
      <AxisGhost sweeping={waking} />
    </div>
  );
}

export function EmptyState({
  range,
  label,
  onWiden,
}: {
  range: TimeRange;
  label: string;
  onWiden: (() => void) | null;
}) {
  return (
    <Panel>
      <Heading>No samples in this range</Heading>
      <Body>
        The collector writes one sample a minute. Nothing arrived for{' '}
        <span className="font-mono text-ink">{label}</span> between{' '}
        {formatTimestamp(range.from.getTime())} and {formatTimestamp(range.to.getTime())}.
      </Body>
      {onWiden && (
        <Button className="mt-4" onClick={onWiden}>
          Look further back
        </Button>
      )}
    </Panel>
  );
}

/**
 * A dead API does not always look like a dead socket. Behind the Vite dev
 * proxy - and behind Azure Container Apps ingress, which is what runs this in
 * production - a viewer that is not answering comes back as a 502 or a 504
 * from the proxy itself, with a body that is not this API's error envelope. So
 * those two say the same thing as an outright network failure, because to the
 * person reading the screen they are the same thing.
 */
function isGatewayFailure(error: ApiError): boolean {
  return error.status === null || error.status === 502 || error.status === 504;
}

function errorHeading(error: ApiError): string {
  if (isGatewayFailure(error)) return 'No answer from the metrics API';
  if (error.isStorageUnavailable) return 'The metrics store is not configured';
  if (error.status === 429) return 'Too many requests at once';
  if (error.status === 400) return 'The metrics API rejected that request';
  return `The metrics API returned ${error.status}`;
}

function errorBody(error: ApiError): string {
  if (isGatewayFailure(error)) {
    return 'Nothing is listening where the viewer should be. Check that it is running, then try again.';
  }
  if (error.isStorageUnavailable) {
    // The viewer sends its own reason for a 503 and it is the useful one.
    return error.message.length > 0
      ? error.message
      : 'The viewer is up but has no storage account set, so it has nothing to read.';
  }
  if (error.status === 429) {
    return 'The viewer caps how much it will read per minute, and this window asked for more. Wait a minute, or pick a shorter range, then try again.';
  }
  return error.message;
}

export function ErrorState({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <Panel>
      <div role="alert">
        <Heading>{errorHeading(error)}</Heading>
        <Body>{errorBody(error)}</Body>
      </div>
      <Button className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    </Panel>
  );
}
