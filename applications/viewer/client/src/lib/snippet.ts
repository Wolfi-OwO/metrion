/**
 * The landing page's one code example, as plain text and as coloured tokens.
 *
 * Two rules keep the example honest. It is a real request against the real
 * ingest schema (`applications/ingest/src/schemas/ingest.schemas.ts`): the
 * endpoint is the deployed ingest host, every attribute the schema requires is
 * present, and the timestamp is generated from the clock, because the schema
 * rejects anything older than 24 hours - a hard-coded date would make the
 * example fail for whoever pasted it tomorrow. And the coloured version is
 * derived from the plain text by `tokenize`, never written separately, so what
 * the "Copy" button puts on the clipboard cannot drift from what is on screen.
 */

export const INGEST_URL = 'https://metrion-ingest.woofi-developments.at/api/v1/ingest';

/** UTC, whole seconds: "2026-09-20T17:30:00Z". */
function isoSeconds(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function quickstart(now: Date = new Date()): string {
  return `curl ${INGEST_URL} \\
  -H "Authorization: Bearer mtr_<prefix>_<secret>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "resource": "vps-01",
    "metrics": [
      {
        "name": "cpu.usage",
        "value": 42.5,
        "unit": "percent",
        "intervalSeconds": 60,
        "timestamp": "${isoSeconds(now)}"
      }
    ]
  }'`;
}

export type TokenKind =
  'command' | 'flag' | 'url' | 'key' | 'string' | 'number' | 'placeholder' | 'punct' | 'plain';

export interface Token {
  readonly text: string;
  readonly kind: TokenKind;
}

// One pass, alternatives in priority order. A quoted string is matched whole
// and split afterwards, so a placeholder inside a header value is still found.
const PATTERN =
  /(https?:\/\/[^\s"'\\]+)|("(?:[^"\\]|\\.)*")(\s*:)?|(-[A-Za-z])(?=\s)|(\bcurl\b)|(-?\d+(?:\.\d+)?)|([{}[\],:'\\])/g;
const PLACEHOLDER = /(<[a-z]+>)/;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let last = 0;
  const push = (value: string, kind: TokenKind) => {
    if (value !== '') tokens.push({ text: value, kind });
  };

  for (const match of text.matchAll(PATTERN)) {
    push(text.slice(last, match.index), 'plain');
    const [whole, url, quoted, colon, flag, command, number, punct] = match;
    if (url !== undefined) push(url, 'url');
    else if (quoted !== undefined) {
      // A key is a string followed by a colon; anything else is a value.
      const kind: TokenKind = colon === undefined ? 'string' : 'key';
      for (const part of quoted.split(PLACEHOLDER)) {
        push(part, PLACEHOLDER.test(part) ? 'placeholder' : kind);
      }
      if (colon !== undefined) push(colon, 'punct');
    } else if (flag !== undefined) push(flag, 'flag');
    else if (command !== undefined) push(command, 'command');
    else if (number !== undefined) push(number, 'number');
    else if (punct !== undefined) push(punct, 'punct');
    else push(whole, 'plain');
    last = (match.index ?? 0) + whole.length;
  }
  push(text.slice(last), 'plain');
  return tokens;
}
