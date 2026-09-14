import { Brand } from '../components/brand.tsx';
import { CopyButton } from '../components/copy-button.tsx';

/**
 * The signed-out root. A quiet, technical product page rather than a
 * marketing hero: this tool's own audience reads a curl command faster than
 * a tagline, so the quickstart snippet - not an illustration - is the
 * page's proof. The shared-time-axis preview in the hero is the one
 * exception, and it earns its place the same way: it is a real rendering of
 * the product's own pitch (three metrics, one clock), not stock art.
 */

const PROVIDERS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'microsoft', label: 'Continue with Microsoft' },
  { id: 'github', label: 'Continue with GitHub' },
];

/** Official mark colours, unaltered, per each provider's own brand
 * guidelines (Google: full-colour "G" on a neutral surface; Microsoft: the
 * four-colour squares mark; GitHub: the single-colour Octocat mark, which is
 * the one of the three explicitly licensed for monochrome reuse). The
 * button chrome around them stays this app's own - one accent colour
 * (`series-1`) on hover, the same language every other control here uses -
 * so three brand hues never compete with each other for attention. */
function ProviderIcon({ id }: { id: string }) {
  switch (id) {
    case 'google':
      return (
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" className="shrink-0">
          <path
            fill="#4285F4"
            d="M19.6 10.23c0-.82-.1-1.42-.25-2.05H10v3.72h5.5c-.15.96-.74 2.31-2.04 3.22v2.45h3.16c1.89-1.73 2.98-4.3 2.98-7.34z"
          />
          <path
            fill="#34A853"
            d="M10 20c2.7 0 4.96-.89 6.62-2.42l-3.16-2.45c-.87.59-2.02.98-3.46.98-2.6 0-4.86-1.75-5.66-4.06H1.32v2.53C2.97 17.77 6.16 20 10 20z"
          />
          <path
            fill="#FBBC05"
            d="M4.34 11.98A5.99 5.99 0 0 1 4 10c0-.68.12-1.34.34-1.98V5.49H1.32A9.99 9.99 0 0 0 0 10c0 1.61.39 3.14 1.32 4.51l3.02-2.53z"
          />
          <path
            fill="#EA4335"
            d="M10 3.96c1.47 0 2.79.51 3.83 1.5l2.87-2.87C14.96.99 12.7 0 10 0 6.16 0 2.97 2.23 1.32 5.49l3.02 2.53C5.14 5.71 7.4 3.96 10 3.96z"
          />
        </svg>
      );
    case 'microsoft':
      return (
        <svg viewBox="0 0 21 21" width="16" height="16" aria-hidden="true" className="shrink-0">
          <rect x="1" y="1" width="9" height="9" fill="#F25022" />
          <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
          <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
          <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
        </svg>
      );
    case 'github':
      return (
        <svg
          viewBox="0 0 16 16"
          width="18"
          height="18"
          aria-hidden="true"
          className="shrink-0 text-ink"
        >
          <path
            fill="currentColor"
            fillRule="evenodd"
            clipRule="evenodd"
            d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"
          />
        </svg>
      );
    default:
      return null;
  }
}

/** Real navigations to `GET /auth/:provider` (`routes/auth.routes.ts`), not
 * fetches - the server answers with a redirect to the provider, so a plain
 * anchor is correct and a click handler would only get in the way. Stacked
 * full-width rows, not squeezed side-by-side pills: a sign-in control is
 * read top to bottom, one decision at a time. */
function SignInButtons() {
  return (
    <div className="flex flex-col gap-2.5" aria-label="Sign in">
      {PROVIDERS.map((provider) => (
        <a
          key={provider.id}
          href={`/auth/${provider.id}`}
          className="group flex items-center gap-3 rounded-md border border-line-strong bg-bg-800 px-4 py-3 text-[13px] font-medium text-ink transition-colors duration-150 hover:border-series-1 hover:bg-bg-900"
        >
          <ProviderIcon id={provider.id} />
          <span className="transition-colors duration-150 group-hover:text-series-1">
            {provider.label}
          </span>
        </a>
      ))}
    </div>
  );
}

/**
 * Three monoline glyphs in the same hand as `StatusIcon`
 * (`components/status-badge.tsx`): 16x16 viewBox, `currentColor`, no fill
 * beyond a stroke - so a new icon vocabulary is not invented for one section.
 */
function ScopeIcon({ id }: { id: string }) {
  const common = {
    viewBox: '0 0 16 16',
    width: 18,
    height: 18,
    'aria-hidden': true as const,
    className: 'shrink-0 text-ink-dim',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
  };
  switch (id) {
    case 'host':
      return (
        <svg {...common}>
          <rect x="1.5" y="1.5" width="13" height="4.2" rx="0.8" />
          <rect x="1.5" y="6.9" width="13" height="4.2" rx="0.8" />
          <rect x="1.5" y="12.3" width="13" height="2.2" rx="0.6" />
          <circle cx="4" cy="3.6" r="0.5" fill="currentColor" stroke="none" />
          <circle cx="4" cy="9" r="0.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'container':
      return (
        <svg {...common}>
          <path d="M8 1.3 14.5 5v6L8 14.7 1.5 11V5Z" />
          <path d="M1.5 5 8 8.5l6.5-3.5" />
          <path d="M8 8.5v6.2" />
        </svg>
      );
    case 'request':
      return (
        <svg {...common}>
          <path d="M2 5.5h10" />
          <path d="M9 2.8 11.8 5.5 9 8.2" />
          <path d="M14 10.5H4" />
          <path d="M7 7.8 4.2 10.5 7 13.2" />
        </svg>
      );
    default:
      return null;
  }
}

const RESOURCE_KINDS: ReadonlyArray<{
  readonly id: string;
  readonly scope: string;
  readonly prefix: string | null;
  readonly metrics: readonly string[];
}> = [
  {
    id: 'host',
    scope: 'Host',
    prefix: null,
    metrics: ['cpu.usage', 'memory.used', 'disk.root.usedPercent'],
  },
  {
    id: 'container',
    scope: 'Container',
    prefix: 'container:<name>',
    metrics: ['restarts', 'memory', 'cpu'],
  },
  {
    id: 'request',
    scope: 'Request host',
    prefix: 'requests:<host>',
    metrics: ['latency', 'status counts'],
  },
];

/**
 * The hero's right half: a real rendering of the pitch in the headline
 * above it, not decoration standing in for one - three series sharing one
 * time axis, with a "now" marker where a live feed would still be writing.
 * Static SVG, not `recharts`: nothing here is interactive or bound to real
 * data, so the chart library the dashboard uses for actual metrics would be
 * pure weight on the one screen a signed-out visitor has not earned a
 * dashboard's payload for yet.
 */
function TimeAxisPreview() {
  return (
    <div className="relative overflow-hidden rounded-md border border-line bg-bg-900 p-5 shadow-[0_12px_32px_-18px_rgba(0,0,0,0.65)] sm:p-6">
      <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
        One shared axis
      </p>
      <svg
        viewBox="0 0 400 190"
        className="mt-4 w-full"
        role="img"
        aria-label="Three metrics - CPU usage, memory used and request latency - plotted against the same shared time axis, with a marker for the current instant"
      >
        {[38, 76, 114, 152].map((y) => (
          <line key={y} x1="0" y1={y} x2="400" y2={y} stroke="var(--color-line)" strokeWidth="1" />
        ))}

        <path
          d="M0 130 Q30 120 50 100 T110 90 T170 60 T230 75 T290 40 T350 55 T400 35"
          fill="none"
          stroke="var(--color-series-1)"
          strokeWidth="2"
        />
        <path
          d="M0 160 Q40 155 70 150 T140 145 T210 140 T280 132 T340 128 T400 120"
          fill="none"
          stroke="var(--color-series-4)"
          strokeWidth="2"
        />
        <path
          d="M0 95 Q25 105 60 118 T130 108 T190 128 T250 100 T320 115 T400 90"
          fill="none"
          stroke="var(--color-series-6)"
          strokeWidth="2"
          strokeDasharray="1 5"
          strokeLinecap="round"
        />

        <line
          x1="358"
          y1="10"
          x2="358"
          y2="180"
          stroke="var(--color-series-2)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
        <text
          x="362"
          y="20"
          fill="var(--color-series-2)"
          fontSize="10"
          fontFamily="var(--font-mono)"
        >
          now
        </text>
      </svg>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1.5 font-mono text-[11px] text-ink-dim">
        <li className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-series-1" aria-hidden="true" />
          cpu.usage
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-series-4" aria-hidden="true" />
          memory.used
        </li>
        <li className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-series-6" aria-hidden="true" />
          requests:web-01 latency
        </li>
      </ul>
    </div>
  );
}

/** A real request against the real ingest schema
 * (`applications/ingest/src/schemas/ingest.schemas.ts`) - the placeholder
 * key and host are the only invented parts. `metrion.example.at` matches the
 * placeholder domain already used in `applications/viewer/.env.example`. */
const QUICKSTART = `curl https://ingest.metrion.example.at/api/v1/ingest \\
  -H "Authorization: Bearer mtr_<prefix>_<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "resource": "vps-01",
    "metrics": [
      { "name": "cpu.usage", "value": 42.5, "unit": "percent",
        "intervalSeconds": 60, "timestamp": "2026-09-13T12:00:00Z" }
    ]
  }'`;

export default function LandingRoute() {
  return (
    <>
      <header className="border-b border-line px-5 py-4 sm:px-8">
        <div className="flex items-center justify-between">
          <Brand />
          <span className="font-mono text-[11px] text-ink-muted">v{__APP_VERSION__}</span>
        </div>
      </header>

      <main className="flex-1">
        <section className="border-b border-line px-5 py-16 sm:px-8 sm:py-24">
          <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-center lg:gap-16">
            <div className="max-w-xl">
              <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
                Metrics platform
              </p>
              <h1 className="mt-3 text-[32px] font-semibold leading-[1.15] text-ink sm:text-[42px]">
                One shared time axis for every server you run.
              </h1>
              <p className="mt-5 max-w-prose text-[15px] leading-relaxed text-ink-dim">
                metrion collects CPU, memory, disk, network and per-container metrics once a minute
                and lines every reading up against the same clock, so a CPU spike and a network
                spike read as one instant, not two dashboards you have to cross-reference by hand.
              </p>
              <div className="mt-9">
                <p className="mb-3 text-[12px] text-ink-muted">
                  Sign in to create a project and mint an API key.
                </p>
                <SignInButtons />
              </div>
            </div>

            <TimeAxisPreview />
          </div>
        </section>

        <section className="border-b border-line px-5 py-14 sm:px-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
            What it tracks
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            {RESOURCE_KINDS.map((kind) => (
              <div key={kind.id} className="rounded-md border border-line bg-bg-900 p-5">
                <ScopeIcon id={kind.id} />
                <h3 className="mt-3 text-[14px] font-semibold text-ink">{kind.scope}</h3>
                {kind.prefix && (
                  <p className="mt-1 font-mono text-[11px] text-ink-muted">{kind.prefix}</p>
                )}
                <ul className="mt-3 flex flex-wrap gap-1.5">
                  {kind.metrics.map((metric) => (
                    <li
                      key={metric}
                      className="rounded-sm border border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-dim"
                    >
                      {metric}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>

        <section className="px-5 py-14 sm:px-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-muted">
            Already have a key? Send your first metric.
          </p>
          <div className="mt-5 max-w-2xl rounded-md border border-line bg-bg-900 p-5">
            <pre className="overflow-x-auto rounded-sm border border-line bg-bg-950 p-4 font-mono text-[12px] leading-relaxed text-ink">
              <code>{QUICKSTART}</code>
            </pre>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="text-[12px] text-ink-muted">
                No key yet? Sign in above, create a project, then mint one from its settings page.
              </p>
              <CopyButton text={QUICKSTART} label="Copy snippet" />
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
