import { useState } from 'react';
import { quickstart, tokenize, type TokenKind } from '../lib/snippet.ts';
import { CopyButton } from './copy-button.tsx';

// Colour is the second channel, never the only one: strings and keys are
// quoted, flags start with a dash, placeholders keep their angle brackets and
// gain a dotted underline, numbers are the only unquoted digits. Every colour
// is an existing token, checked against the code block's own surface by
// scripts/contrast.mjs in both themes.
const KIND_CLASS: Record<TokenKind, string> = {
  command: 'text-accent',
  flag: 'text-accent',
  url: 'text-series-3',
  key: 'text-series-6',
  string: 'text-series-4',
  number: 'text-series-5',
  placeholder: 'text-series-2 underline decoration-dotted underline-offset-2',
  punct: 'text-ink-3',
  plain: 'text-ink',
};

/**
 * `muted` restyles the frame only (see below). The landing page's curl example: a header bar with the copy control, then the
 * highlighted text. The displayed timestamp is taken when the page mounts and
 * the copied one when the button is pressed, so a tab left open overnight still
 * copies a request the ingest API will accept.
 *
 * The block scrolls sideways inside itself on a narrow screen, so it is
 * keyboard-focusable and named - an unlabelled scroll region is a tab stop that
 * announces nothing.
 */
export function CodeSnippet({ muted = false }: { muted?: boolean }) {
  const [shown] = useState(() => quickstart());
  return (
    <div
      className={`min-w-0 overflow-hidden rounded-surface border ${
        // Muted: the same block for a step that is not yet actionable. No
        // fill and a dashed edge say "preview" without dimming the text,
        // which would take the tokens below under their contrast floor.
        muted ? 'border-dashed border-line-strong' : 'border-line bg-surface'
      }`}
    >
      <div className="flex items-center justify-between border-b border-line py-1 pr-1 pl-4">
        <span className="font-mono text-label text-ink-3">curl</span>
        <CopyButton text={() => quickstart()} label="Copy snippet" />
      </div>
      <pre
        tabIndex={0}
        role="region"
        aria-label="curl example, scrolls sideways"
        className="overflow-x-auto p-4 font-mono text-label"
      >
        <code>
          {tokenize(shown).map((token, index) => (
            <span key={index} className={KIND_CLASS[token.kind]}>
              {token.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
