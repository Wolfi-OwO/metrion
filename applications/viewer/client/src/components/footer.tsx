/**
 * The one piece of chrome every screen shares, including error and not-found
 * states - `App.tsx` renders it as a sibling of the routed content, outside
 * any branch that could replace the page. § 5 ECG wants the Impressum
 * "leicht und unmittelbar zugaenglich", which it would not be if reaching it
 * depended on a route's own data loading successfully. Plain anchors, not
 * router links: these are three server-rendered documents, not screens of
 * this app, so a full page load is correct.
 *
 * `mt-auto` inside the flex column in `App.tsx` pins it to the bottom of the
 * viewport when a page is short, instead of leaving it floating under a
 * single short panel.
 */
export function Footer() {
  return (
    <footer className="mt-auto border-t border-line bg-bg-900 px-gutter py-3 sm:px-gutter-lg">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-meta text-ink-muted">
        <span>© {new Date().getFullYear()} Phillip Kofler</span>
        <span aria-hidden="true" className="text-line-strong">
          ·
        </span>
        <span>v{__APP_VERSION__}</span>

        <nav aria-label="Legal" className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1">
          {/* The Impressum keeps its German name: it is the word an Austrian
              reader looks for, and translating it would hide it. `lang` so a
              screen reader does not read it with an English voice. */}
          <a
            lang="de"
            href="/impressum"
            className="text-ink-dim transition-colors duration-(--duration-fast) hover:text-ink"
          >
            Impressum
          </a>
          <span aria-hidden="true" className="text-line-strong">
            ,
          </span>
          <a
            href="/privacy"
            className="text-ink-dim transition-colors duration-(--duration-fast) hover:text-ink"
          >
            Privacy
          </a>
          <span aria-hidden="true" className="text-line-strong">
            ,
          </span>
          <a
            href="/terms"
            className="text-ink-dim transition-colors duration-(--duration-fast) hover:text-ink"
          >
            Terms of use
          </a>
        </nav>
      </div>
    </footer>
  );
}
