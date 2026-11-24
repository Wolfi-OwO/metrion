import { useEffect, useRef, useState } from 'react';
import { ChevronIcon, CodeIcon } from './icon.tsx';

/**
 * The one piece of chrome every screen shares, including error and not-found
 * states - `App.tsx` renders it as a sibling of the routed content, outside
 * any branch that could replace the page. § 5 ECG wants the Impressum
 * "leicht und unmittelbar zugaenglich", which it would not be if reaching it
 * depended on a route's own data loading successfully. Legal links are plain
 * anchors, not router links: they are server-rendered documents, not screens
 * of this app, so a full page load is correct.
 *
 * Pinned to the bottom edge of the viewport (`position: fixed`) on every
 * screen, so the Impressum is reachable without scrolling. Fixed rather than a
 * scrolling-main flex shell because the page keeps its natural document scroll
 * (browser chrome collapsing, find-in-page, anchor jumps all keep working).
 * The price is that content must not hide behind it, which is paid once, in
 * `styles/index.css`: `--footer-h` is the bar's height, `App.tsx` reserves it
 * as bottom padding, and `scroll-padding-bottom` keeps a focused control from
 * scrolling underneath it (WCAG 2.4.11). The footer's own `height` is that
 * same variable, so the reserved space and the bar cannot drift apart.
 *
 * Two variants because a pinned bar has to be cheap. From `lg` (1024px) one
 * 53px row, three columns as `1fr auto 1fr` rather than flex `space-between`:
 * with unequal left and right zones space-between centres the gap, not the
 * pill; equal outer tracks put the pill on the viewport midline. Below `lg`
 * the five links and the (c) line would need 117px of stacked rows - 14% of a
 * phone screen, permanently - so they fold into a "Legal" disclosure and the
 * bar is one 45px row: the version pill and one 44px control.
 */
const LINK =
  'inline-flex min-h-11 items-center rounded-lg px-2 font-medium text-ink-2 transition-colors duration-200 hover:text-ink lg:min-h-0 lg:px-0';

function LegalLinks({ onNavigate, className }: { onNavigate?: () => void; className: string }) {
  return (
    <nav aria-label="Legal and contact" className={className}>
      <a
        href="https://status.woofi-developments.at"
        target="_blank"
        rel="noopener noreferrer"
        className={LINK}
        onClick={onNavigate}
      >
        <span aria-hidden="true" className="animate-live mr-2 size-1.5 rounded-full bg-status-ok" />
        Status
      </a>
      {/* The Impressum keeps its German name: it is the word an Austrian
          reader looks for. `lang` so a screen reader does not read it with an
          English voice. */}
      <a lang="de" href="/impressum" className={LINK} onClick={onNavigate}>
        Impressum
      </a>
      <a href="/privacy" className={LINK} onClick={onNavigate}>
        Privacy Policy
      </a>
      <a href="https://www.woofi-developments.at/contact" className={LINK} onClick={onNavigate}>
        Contact
      </a>
      <a href="/terms" className={LINK} onClick={onNavigate}>
        Terms of use
      </a>
    </nav>
  );
}

const COPYRIGHT = `© ${new Date().getFullYear()} Woofi-Developments All Rights Reserved.`;

/** The phone/tablet disclosure. Closes on Escape (focus returns to the button), on a press outside, and on any link. */
function LegalDisclosure() {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    };
    const onPress = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPress);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPress);
    };
  }, [open]);

  return (
    <div ref={root} className="relative lg:hidden">
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls="footer-legal"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex min-h-11 items-center gap-1 rounded-control pr-1 pl-3 text-label font-medium text-ink-2 transition-colors hover:text-ink"
      >
        Legal
        <ChevronIcon
          className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-90' : '-rotate-90'}`}
        />
      </button>
      {open && (
        <div
          id="footer-legal"
          className="absolute right-0 bottom-full z-(--z-popover) mb-2 w-64 rounded-surface border border-line bg-surface p-2 shadow-popover"
        >
          <LegalLinks onNavigate={() => setOpen(false)} className="flex flex-col" />
          <p className="border-t border-line px-2 pt-2 pb-1 text-meta text-ink-3">{COPYRIGHT}</p>
        </div>
      )}
    </div>
  );
}

export function Footer() {
  return (
    <footer
      aria-label="Site"
      className="fixed inset-x-0 bottom-0 z-(--z-footer) h-(--footer-h) border-t border-line bg-surface pb-[env(safe-area-inset-bottom,0px)]"
    >
      <div className="flex h-full items-center justify-between px-4 text-[13px] sm:px-6 lg:grid lg:grid-cols-[1fr_auto_1fr] lg:justify-items-center lg:gap-x-4 lg:px-8">
        <p className="hidden whitespace-nowrap text-ink-2 lg:block lg:justify-self-start">
          {COPYRIGHT}
        </p>

        <a
          href="https://github.com/Wolfi-OwO/metrion"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Metrion version ${__APP_VERSION__}, source on GitHub`}
          className="group inline-flex rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span className="inline-flex items-center gap-2 rounded-lg border border-transparent bg-bg px-2.5 py-1 font-mono leading-5 text-ink-3 transition-colors duration-200 group-hover:border-accent">
            <CodeIcon />
            <span className="text-ink" aria-hidden="true">
              Wolfi-OwO/metrion
            </span>
            <span aria-hidden="true" className="text-line">
              ·
            </span>
            <span aria-hidden="true">v{__APP_VERSION__}</span>
          </span>
        </a>

        <LegalDisclosure />
        <LegalLinks className="hidden items-center gap-x-4 lg:flex lg:justify-self-end" />
      </div>
    </footer>
  );
}
