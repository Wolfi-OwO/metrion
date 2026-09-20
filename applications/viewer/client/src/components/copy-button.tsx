import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard.ts';
import { Button } from './states.tsx';

/**
 * Used both for the landing page's quickstart snippet and the one-time API
 * key reveal - two different pieces of text, one control. `aria-live` on the
 * label itself (rather than the whole button) is what makes "Copied" get
 * announced without the button's own accessible name flickering mid-click.
 */
export function CopyButton({
  text,
  label = 'Copy',
}: {
  /** A function is read at click time, for text that must be fresh when
   * copied (the landing example's timestamp expires after 24 hours). */
  text: string | (() => string);
  label?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      variant="quiet"
      onClick={() => void copyText(typeof text === 'function' ? text() : text).then(setCopied)}
    >
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}
