import { useEffect, useRef, useState } from 'react';

/**
 * True once the element has come within `margin` pixels of the viewport, and
 * stays true. The dashboard uses it to hold each row's status request until
 * the row is near the screen: with 40 projects the page used to fire 40
 * requests on mount, one per row, whether or not the row was ever scrolled to.
 */
export function useInView<T extends Element>(margin = 240) {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element || seen) return;
    // No IntersectionObserver (an old WebView): fall back to "visible", which
    // is the previous behaviour rather than a row that never loads.
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setSeen(true);
          observer.disconnect();
        }
      },
      { rootMargin: `${margin}px` },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [margin, seen]);

  return [ref, seen] as const;
}
