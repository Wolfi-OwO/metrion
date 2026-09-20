import { CopyButton } from '../components/copy-button.tsx';
import { PublicHeader } from '../components/public-header.tsx';

/**
 * The signed-out root. A quiet, technical product page rather than a
 * marketing hero: this tool's own audience reads a curl command faster than
 * a tagline, so the quickstart snippet - not an illustration - is the
 * page's proof. The shared-time-axis preview in the hero is the one
 * exception, and it earns its place the same way: it is a real rendering of
 * the product's own pitch (three metrics, one clock), not stock art.
 */

const PROVIDERS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: 'google', label: 'Google' },
  { id: 'microsoft', label: 'Microsoft' },
  { id: 'github', label: 'GitHub' },
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
 * anchor is correct and a click handler would only get in the way. The three
 * providers are equals, so they sit in one row under one sentence instead of
 * three stacked slabs: the decision is "which account", not "which of three
 * big things". */
function SignInButtons() {
  return (
    <div>
      <p className="text-label font-medium text-ink-2" id="sign-in-label">
        Continue with
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-3" role="group" aria-labelledby="sign-in-label">
        {PROVIDERS.map((provider) => (
          <a
            key={provider.id}
            href={`/auth/${provider.id}`}
            className="flex min-h-11 items-center justify-center gap-3 rounded-control border border-line-strong bg-raised px-4 text-body font-medium text-ink transition-colors hover:border-control md:min-h-10"
          >
            <ProviderIcon id={provider.id} />
            {provider.label}
          </a>
        ))}
      </div>
    </div>
  );
}

/** A small deterministic wave: `spike` is where the shared event lands, so
 * the three strips below can all show it at the same x - the whole pitch. */
function wave(seed: number, amplitude: number, spikeHeight: number, width: number, height: number) {
  const points: string[] = [];
  const count = 48;
  for (let i = 0; i <= count; i += 1) {
    const x = (i / count) * width;
    const t = i / count;
    const base = 0.35 + 0.12 * Math.sin(t * 9 + seed) + 0.06 * Math.sin(t * 23 + seed * 2);
    const spike = Math.exp(-(((t - 0.7) / 0.035) ** 2)) * spikeHeight;
    const y = height - (base * amplitude + spike) * height;
    points.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`);
  }
  return points.join(' ');
}

const PREVIEW_STRIPS = [
  {
    name: 'cpu.usage',
    value: '83%',
    color: 'var(--color-series-1)',
    dash: undefined,
    seed: 1,
    spike: 0.5,
  },
  {
    name: 'memory.used',
    value: '6.4 GiB',
    color: 'var(--color-series-2)',
    dash: '5 3',
    seed: 4,
    spike: 0.22,
  },
  {
    name: 'net.rx',
    value: '24 MiB/s',
    color: 'var(--color-series-3)',
    dash: '2 3',
    seed: 7,
    spike: 0.55,
  },
] as const;

/**
 * The hero's right half: three strips on one clock with a crosshair through
 * the same instant, drawn the way the product draws them. A CPU spike, a
 * memory step and a network burst line up because they share an axis - the
 * pitch of the headline, shown rather than described. Static SVG, not
 * recharts: nothing here is interactive, and the chart library is payload a
 * signed-out visitor has not earned yet.
 */
function TimeAxisPreview() {
  const width = 440;
  const height = 64;
  const crosshair = 0.7 * width;
  return (
    <figure
      className="relative rounded-surface border border-line bg-surface p-4 shadow-raised md:p-6"
      aria-label="Three metrics - CPU usage, memory used and network receive rate - plotted on one shared time axis with a crosshair through a single instant"
    >
      <div className="space-y-4" aria-hidden="true">
        {PREVIEW_STRIPS.map((strip) => (
          <div key={strip.name}>
            <div className="flex items-baseline justify-between font-mono text-label">
              <span className="text-ink-2">{strip.name}</span>
              <span className="text-ink">{strip.value}</span>
            </div>
            <svg viewBox={`0 0 ${width} ${height}`} className="mt-1 w-full">
              {[16, 32, 48].map((y) => (
                <line key={y} x1="0" y1={y} x2={width} y2={y} stroke="var(--color-line)" />
              ))}
              <path
                d={wave(strip.seed, 0.8, strip.spike, width, height)}
                fill="none"
                stroke={strip.color}
                strokeWidth="1.5"
                strokeDasharray={strip.dash}
              />
              <line
                x1={crosshair}
                y1="0"
                x2={crosshair}
                y2={height}
                stroke="var(--color-control)"
              />
            </svg>
          </div>
        ))}
      </div>
      <figcaption className="mt-4 flex items-center justify-between font-mono text-label text-ink-3">
        <span>one clock, three metrics</span>
        <span>14:32</span>
      </figcaption>
    </figure>
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
      <PublicHeader>
        <span className="font-mono text-meta text-ink-3">v{__APP_VERSION__}</span>
      </PublicHeader>

      <main className="enter flex-1">
        <section className="border-b border-line">
          <div className="page grid gap-12 py-12 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-16">
            <div>
              <h1 className="max-w-[20ch] text-display font-semibold tracking-tight text-balance text-ink">
                One shared time axis for every server you run.
              </h1>
              <p className="mt-6 max-w-prose text-body text-ink-2">
                metrion collects CPU, memory, disk, network and per-container metrics once a minute
                and lines every reading up against the same clock, so a CPU spike and a network
                spike read as one instant, not two dashboards you have to cross-reference by hand.
              </p>
              <div className="mt-8 max-w-lg">
                <SignInButtons />
                <p className="mt-4 text-label text-ink-3">
                  Signing in creates your account. Then: a project, an API key, one curl.
                </p>
              </div>
            </div>

            <TimeAxisPreview />
          </div>
        </section>

        <section>
          <div className="page grid gap-8 py-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-16">
            <div>
              <h2 className="text-heading font-semibold tracking-tight text-ink">
                Send your first metric
              </h2>
              <p className="mt-2 max-w-prose text-body text-ink-2">
                One authenticated POST per minute per host. No agent lock-in: anything that can run
                curl can report. Sign in, create a project, then mint a key from its Settings tab -
                it is shown once.
              </p>
            </div>
            <div className="min-w-0 overflow-hidden rounded-surface border border-line bg-surface">
              <div className="flex items-center justify-between border-b border-line py-1 pr-1 pl-4">
                <span className="font-mono text-label text-ink-3">curl</span>
                <CopyButton text={QUICKSTART} label="Copy snippet" />
              </div>
              <pre className="overflow-x-auto p-4 font-mono text-label text-ink">
                <code>{QUICKSTART}</code>
              </pre>
            </div>
          </div>
        </section>
      </main>
    </>
  );
}
