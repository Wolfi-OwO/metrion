import { CodeIcon } from './icon.tsx';

/**
 * The one piece of chrome every screen shares, including error and not-found
 * states - `App.tsx` renders it as a sibling of the routed content, outside
 * any branch that could replace the page. § 5 ECG wants the Impressum
 * "leicht und unmittelbar zugaenglich", which it would not be if reaching it
 * depended on a route's own data loading successfully. Legal links are plain
 * anchors, not router links: they are server-rendered documents, not screens
 * of this app, so a full page load is correct.
 *
 * One slim status-bar row on desktop (12px padding, 28px pill: 53px with the
 * border). It was 89px because the (c) block was two lines (40px) inside
 * py-6, and 247px on a phone because five 44px links wrapped in a 3-column
 * grid.
 *
 * Three columns as `1fr auto 1fr`, not flex `space-between`: with unequal
 * left and right zones space-between centres the gap, not the pill. Equal
 * flexible outer tracks are what put the pill on the viewport's midline
 * whatever the zones' widths. Below `lg` (1024px: at 768 the 1fr tracks are 220px, too narrow for the five links, which pushed the pill off-centre) the tracks collapse to one column
 * and everything centres, pill first.
 *
 * `mt-auto` inside the flex column in `App.tsx` pins it to the bottom of the
 * viewport when a page is short.
 */
// min-h-11 on a phone: the anchor carries the 44px target, not the row, so the
// visible row stays tight (the nav overlaps only non-interactive text). From
// lg up they sit on one line and take their natural height.
const LINK =
  'inline-flex min-h-11 items-center rounded-control px-2 text-ink-2 transition-colors hover:text-ink lg:min-h-0 lg:px-0';

export function Footer() {
  return (
    <footer aria-label="Site" className="mt-auto border-t border-line bg-surface">
      <div className="page grid grid-cols-1 items-center justify-items-center gap-y-1 py-2 text-meta lg:grid-cols-[1fr_auto_1fr] lg:gap-x-6 lg:py-3">
        <p className="order-3 whitespace-nowrap text-center text-ink-3 lg:order-none lg:justify-self-start lg:text-left">
          © {new Date().getFullYear()} Phillip Kofler · All rights reserved.
        </p>

        {/* The repo is private, so this is text, not a link that would 404
            for everyone else. */}
        <p
          aria-label={`Metrion version ${__APP_VERSION__}`}
          className="order-1 inline-flex items-center h-7 gap-2 rounded-pill border border-line bg-bg px-3 font-mono lg:order-none"
        >
          <CodeIcon />
          <span className="text-ink" aria-hidden="true">
            Wolfi-OwO/metrion
          </span>
          <span aria-hidden="true" className="text-ink-3">
            ·
          </span>
          <span className="text-ink-3" aria-hidden="true">
            v{__APP_VERSION__}
          </span>
        </p>

        <nav
          aria-label="Legal and contact"
          className="order-2 w-[calc(100%+1rem)] flex-wrap -mx-2 flex justify-center lg:mx-0 lg:w-auto lg:order-none lg:items-center lg:justify-self-end lg:gap-x-3"
        >
          <a
            href="https://status.woofi-developments.at"
            target="_blank"
            rel="noopener noreferrer"
            className={LINK}
          >
            Status
          </a>
          <a href="/privacy" className={LINK}>
            Privacy Policy
          </a>
          {/* The Impressum keeps its German name: it is the word an Austrian
              reader looks for. `lang` so a screen reader does not read it
              with an English voice. */}
          <a lang="de" href="/impressum" className={LINK}>
            Impressum
          </a>
          <a href="/terms" className={LINK}>
            Terms of use
          </a>
          <a href="mailto:koflerphillip@outlook.com" className={LINK}>
            Contact
          </a>
        </nav>
      </div>
    </footer>
  );
}
