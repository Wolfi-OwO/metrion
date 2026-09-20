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
 * Three columns as `1fr auto 1fr`, not flex `space-between`: with unequal
 * left and right zones space-between centres the gap, not the pill. Equal
 * flexible outer tracks are what put the pill on the viewport's midline
 * whatever the zones' widths. Below `md` the tracks collapse to one column
 * and everything centres, pill first.
 *
 * `mt-auto` inside the flex column in `App.tsx` pins it to the bottom of the
 * viewport when a page is short.
 */
// min-h-11 on a phone: the links wrap in rows there and used to measure 18px
// tall. From md up they sit on one line and take their natural height.
const LINK =
  'inline-flex min-h-11 items-center rounded-control px-2 text-ink-2 transition-colors hover:text-ink md:min-h-0 md:px-0';

export function Footer() {
  return (
    <footer aria-label="Site" className="mt-auto border-t border-line bg-surface">
      <div className="page grid grid-cols-1 py-6 items-center justify-items-center gap-y-4 text-meta md:grid-cols-[1fr_auto_1fr] md:gap-x-6">
        <p className="order-3 text-center text-ink-3 md:order-none md:justify-self-start md:text-left">
          © {new Date().getFullYear()} Phillip Kofler
          <br />
          All rights reserved.
        </p>

        {/* The repo is private, so this is text, not a link that would 404
            for everyone else. */}
        <p
          aria-label={`Metrion version ${__APP_VERSION__}`}
          className="order-1 inline-flex items-center gap-2 rounded-pill border border-line bg-bg px-4 py-2 font-mono md:order-none"
        >
          <CodeIcon />
          <span className="text-ink" aria-hidden="true">
            Wolfi-OwO/metrion
          </span>
          <span aria-hidden="true" className="text-line-strong">
            ·
          </span>
          <span className="text-ink-3" aria-hidden="true">
            v{__APP_VERSION__}
          </span>
        </p>

        <nav
          aria-label="Legal and contact"
          className="order-2 grid w-full grid-cols-3 justify-items-center md:order-none md:flex md:w-auto md:items-center md:justify-self-end md:gap-x-4"
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
