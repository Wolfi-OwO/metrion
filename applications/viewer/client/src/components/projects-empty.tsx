import { CodeSnippet } from './code-snippet.tsx';
import { Button } from './states.tsx';

/**
 * What the screen will look like, in outline: three project rows drawn with the
 * real row's parts (a name and slug, a trace, a status dot). The first one has
 * a pulse on it and a live dot, the way a row does once a collector reports;
 * the other two are empty. Made of the product's own structure rather than an
 * illustration, and plain surface behind it. Static and decorative, so
 * aria-hidden; token colours only.
 */
function RowEcho() {
  return (
    <div aria-hidden="true" className="flex h-full flex-col justify-center gap-2 p-4 lg:p-8">
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className={`items-center gap-4 rounded-surface border border-dashed border-line-strong px-4 py-3 ${
            index === 0 ? 'flex' : 'hidden lg:flex'
          }`}
        >
          <div className="grid flex-1 gap-1">
            <span className="h-2 w-24 rounded-pill bg-raised" />
            <span className="h-2 w-16 rounded-pill bg-raised" />
          </div>
          {index === 0 ? (
            <svg viewBox="0 0 96 24" className="h-6 w-24 shrink-0" fill="none">
              <path
                d="M0 14 H30 L38 14 L46 3 L56 21 L64 9 L70 14 H96"
                stroke="var(--color-accent)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span className="h-px w-24 shrink-0 bg-line-strong" />
          )}
          <span
            className={`size-2 shrink-0 rounded-pill ${index === 0 ? 'bg-accent' : 'bg-raised'}`}
          />
        </div>
      ))}
    </div>
  );
}

const STEPS = [
  {
    title: 'Create a group',
    body: 'One per environment: production, staging, a home lab.',
  },
  {
    title: 'Create an API key',
    body: 'On the group’s Settings tab. The full key is shown once, so copy it then.',
  },
  {
    title: 'Post a metric',
    body: 'Send a POST with the key. The first sample appears here within a minute.',
  },
] as const;

/**
 * First run: no projects yet. Says what a project is and how data gets in, and
 * offers the one action that starts it. The curl block is the same component as
 * the landing page's, shown as a preview of step 3 (it cannot work before a key
 * exists).
 */
export function ProjectsEmpty({ onCreate, creating }: { onCreate: () => void; creating: boolean }) {
  return (
    <section
      aria-labelledby="first-run-title"
      className="overflow-hidden rounded-surface border border-line bg-surface"
    >
      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="order-last p-6 lg:order-first lg:p-8">
          <h2 id="first-run-title" className="text-page font-semibold tracking-tight text-ink">
            Create your first group
          </h2>
          <p className="mt-2 max-w-prose text-body text-ink-2">
            A group is one environment you want to watch. It owns the API keys and the applications
            behind them: a collector on your server posts metrics with a key, and the group turns
            them into health, thresholds and charts.
          </p>
          {!creating && (
            <Button className="mt-6" variant="primary" onClick={onCreate}>
              New group
            </Button>
          )}
        </div>
        <div className="order-first border-b border-line bg-bg lg:order-last lg:border-b-0 lg:border-l">
          <RowEcho />
        </div>
      </div>

      <div className="grid gap-6 border-t border-line p-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] lg:gap-8 lg:p-8">
        <ol className="grid content-start gap-6">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex size-6 shrink-0 items-center justify-center rounded-pill border border-line-strong font-mono text-label text-ink-2"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-body font-medium text-ink">{step.title}</p>
                <p className="text-body text-ink-2">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
        <div className="min-w-0">
          <p className="mb-2 text-label text-ink-3">
            After you create a key, step 3 is this request
          </p>
          <CodeSnippet muted />
        </div>
      </div>
    </section>
  );
}
