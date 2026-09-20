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

// h2 by default: every other call site (EmptyState, ErrorState, the
// registration panels) sits inside a page that already renders its own h1
// elsewhere, so this is a subheading nested under it. not-found.tsx and
// error-boundary.tsx are the one exception - a standalone page with no other
// heading - and pass `level="h1"` so that page still has a real, single h1
// rather than starting its heading structure at level 2.
export function Heading({
  children,
  level = 'h2',
}: {
  children: React.ReactNode;
  level?: 'h1' | 'h2';
}) {
  const className = 'text-heading font-semibold tracking-tight text-ink';
  return level === 'h1' ? (
    <h1 className={className}>{children}</h1>
  ) : (
    <h2 className={className}>{children}</h2>
  );
}

export function Body({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 max-w-prose text-body text-ink-2">{children}</p>;
}

export type ButtonVariant = 'primary' | 'secondary' | 'quiet';
export type ButtonTone = 'default' | 'danger';

// 44px tall on a phone (a finger), 36px from md up (a cursor). One height
// rule for every button, so no control in the app is under the touch minimum.
const BUTTON_BASE =
  'inline-flex min-h-11 select-none items-center justify-center gap-2 whitespace-nowrap rounded-control px-4 text-label font-medium transition-colors md:min-h-9 md:px-3 disabled:cursor-not-allowed disabled:opacity-50 aria-busy:cursor-wait aria-busy:opacity-70';

// Primary is the one filled brand-colour button on a screen. Secondary is a
// raised chip. Quiet has no chrome at all until hovered - most buttons in a
// dense tool should be quiet, so the one primary action stays findable.
const VARIANT_CLASS: Record<ButtonVariant, Record<ButtonTone, string>> = {
  primary: {
    default: 'bg-accent text-accent-ink hover:bg-accent-strong',
    danger: 'bg-status-critical text-accent-ink hover:brightness-110',
  },
  secondary: {
    default: 'border border-line-strong bg-raised text-ink hover:border-control',
    danger:
      'border border-status-critical/40 text-status-critical hover:border-status-critical hover:bg-status-critical/10',
  },
  quiet: {
    default: 'text-ink-2 hover:bg-raised hover:text-ink',
    danger: 'text-status-critical hover:bg-status-critical/10',
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
  onBlur,
  children,
  type = 'button',
  variant = 'secondary',
  tone = 'default',
  disabled = false,
  loading = false,
  className = '',
}: {
  onClick?: () => void;
  onBlur?: () => void;
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
      onBlur={onBlur}
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
      {/* `py-2` mirrors `MetricChart`'s own `margin={{ top: 8, bottom: 8 }}` -
          without it the top and bottom grid lines sat flush on the border,
          reading as one thick line instead of four evenly spaced ones. */}
      <div className="absolute inset-0 flex flex-col justify-between py-2">
        {[0, 1, 2, 3].map((line) => (
          <div key={line} className="h-px w-full bg-raised" />
        ))}
      </div>
      {sweeping && (
        <div className="sweep absolute inset-y-0 left-0 w-1/4 bg-linear-to-r from-transparent via-accent/12 to-transparent" />
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
              Still going after{' '}
              {/* `font-mono`: the counter ticks over from a 1-digit to a
                  2-digit number partway through nearly every wake, and the
                  same family every other live number in this app uses keeps
                  that digit tabular instead of jittering. */}
              <span className="font-mono text-ink">{seconds}</span>{' '}
              {seconds === 1 ? 'second' : 'seconds'}.
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
        The collector writes one sample a minute, so a gap this size is real and not an artifact of
        coarse bucketing. Nothing arrived for <span className="font-mono text-ink">{label}</span>{' '}
        between{' '}
        {/* `whitespace-nowrap` per timestamp, the same fix the chart legend
            uses for "4 330 MiB": each "19 Sep, 14:32" is one unit, and a wrap
            landing between its date and its time would split it in two. The
            sentence can still wrap around the two timestamps, just not
            inside either one. */}
        <span className="whitespace-nowrap font-mono text-ink">
          {formatTimestamp(range.from.getTime())}
        </span>{' '}
        and{' '}
        <span className="whitespace-nowrap font-mono text-ink">
          {formatTimestamp(range.to.getTime())}
        </span>
        .
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

function errorHeading(error: ApiError, what: string): string {
  if (isGatewayFailure(error)) return `No answer from the ${what} API`;
  if (error.isStorageUnavailable) return `The ${what} store is not configured`;
  if (error.status === 429) return 'Too many requests at once';
  if (error.status === 400) return `The ${what} API rejected that request`;
  return `The ${what} API returned ${error.status}`;
}

// `error.message` is server-written prose of unknown shape - some end in a
// period, an `issues[0]` validation detail usually doesn't. Appending a fixed
// suggested action straight onto it produced sentences that ran together with
// no punctuation between them. One period is cheaper than a second sentence
// this function has to guess the tone of.
function withAction(message: string, action: string): string {
  const trimmed = message.trim();
  const needsStop = trimmed.length > 0 && !/[.!?]$/.test(trimmed);
  return `${trimmed}${needsStop ? '.' : ''} ${action}`;
}

function errorBody(error: ApiError): string {
  if (isGatewayFailure(error)) {
    return 'Nothing is listening where the viewer should be. Check that it is running, then try again.';
  }
  if (error.isStorageUnavailable) {
    // The viewer sends its own reason for a 503 and it is the useful one.
    if (error.message.length > 0) return error.message;
    // Retrying a missing storage account never changes the result, so the
    // fallback names who can actually fix it instead of offering a button
    // that will only fail the same way again.
    return 'The viewer is up but has no storage account set, so it has nothing to read. This is a deployment setting - an operator needs to configure one.';
  }
  if (error.status === 429) {
    return 'The viewer caps how much it will read per minute, and this window asked for more. Wait a minute, or pick a shorter range, then try again.';
  }
  if (error.status === 400) {
    return withAction(error.message, 'Check the selected range or resource, then try again.');
  }
  return withAction(error.message, 'Try again, or check back later if it keeps happening.');
}

export function ErrorState({
  error,
  onRetry,
  what = 'metrics',
}: {
  error: ApiError;
  onRetry: () => void;
  /** Which API failed, in a word, so the heading names the right one. */
  what?: string;
}) {
  return (
    <Panel>
      <div role="alert">
        <Heading>{errorHeading(error, what)}</Heading>
        <Body>{errorBody(error)}</Body>
      </div>
      <Button className="mt-4" onClick={onRetry}>
        Try again
      </Button>
    </Panel>
  );
}
