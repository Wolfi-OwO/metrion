/**
 * A deliberately small Markdown-to-HTML converter for the three legal
 * documents at the repo root.
 *
 * No dependency: it covers exactly the constructs those files use - headings,
 * bold, emphasis, inline code, unordered and ordered lists, one table,
 * horizontal rules, autolinks and paragraphs - and nothing else. The input is
 * trusted repo content, not user input, so the bar here is rendering
 * correctly, not surviving hostile Markdown. It still escapes HTML, because
 * getting that wrong in a document whose entire purpose is to be publicly
 * readable is not worth the saved line.
 *
 * ponytail: a subset converter. Anything it does not know - nested lists,
 * reference links, images, code fences - degrades to plain text rather than
 * breaking. `tests/legal.test.ts` asserts that no visible text from the real
 * documents is ever dropped, which is the property that actually matters for
 * a legally required disclosure. Upgrade path if the documents grow features:
 * add `marked` as a viewer dependency and delete this file, rather than
 * growing this into a general Markdown parser.
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * One ordered-alternation pass rather than a chain of `.replace` calls, so
 * that code spans win over everything inside them: `container:<name>` in
 * backticks stays literal text instead of being read as an autolink, and
 * asterisks inside a code span are not emphasis. A chain would have needed
 * placeholder tokens to get the same result.
 */
const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)|<(https?:\/\/[^>\s]+)>|<([^\s@<>]+@[^\s@<>]+)>|\*([^*\n]+)\*/g;

function renderInline(text: string): string {
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE)) {
    result += escapeHtml(text.slice(lastIndex, match.index));

    const [full, code, bold, linkText, linkHref, url, email, emphasis] = match;
    if (code !== undefined) {
      result += '<code>' + escapeHtml(code) + '</code>';
    } else if (bold !== undefined) {
      result += '<strong>' + escapeHtml(bold) + '</strong>';
    } else if (linkText !== undefined && linkHref !== undefined) {
      result +=
        '<a href="' +
        escapeHtml(linkHref) +
        '" rel="noopener noreferrer">' +
        escapeHtml(linkText) +
        '</a>';
    } else if (url !== undefined) {
      result +=
        '<a href="' + escapeHtml(url) + '" rel="noopener noreferrer">' + escapeHtml(url) + '</a>';
    } else if (email !== undefined) {
      result += '<a href="mailto:' + escapeHtml(email) + '">' + escapeHtml(email) + '</a>';
    } else if (emphasis !== undefined) {
      result += '<em>' + escapeHtml(emphasis) + '</em>';
    }

    lastIndex = match.index + full.length;
  }

  return result + escapeHtml(text.slice(lastIndex));
}

function tableRow(line: string, cell: 'th' | 'td'): string {
  const cells = line
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((value) => '<' + cell + '>' + renderInline(value.trim()) + '</' + cell + '>');
  return '<tr>' + cells.join('') + '</tr>';
}

/** A table's `| --- | --- |` separator carries no content and is dropped. */
function isTableDivider(line: string): boolean {
  return /^\|[\s|:-]+\|$/.test(line.trim());
}

export function renderMarkdown(markdown: string): string {
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let inTable = false;

  const closeParagraph = (): void => {
    if (paragraph.length > 0) {
      html.push('<p>' + renderInline(paragraph.join(' ')) + '</p>');
      paragraph = [];
    }
  };
  const closeList = (): void => {
    if (list !== null) {
      html.push('</' + list + '>');
      list = null;
    }
  };
  const closeTable = (): void => {
    if (inTable) {
      html.push('</tbody></table>');
      inTable = false;
    }
  };
  const closeAll = (): void => {
    closeParagraph();
    closeList();
    closeTable();
  };

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd();

    if (line.trim().length === 0) {
      closeAll();
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null && heading[1] !== undefined && heading[2] !== undefined) {
      closeAll();
      const level = heading[1].length;
      html.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      continue;
    }

    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      closeAll();
      html.push('<hr />');
      continue;
    }

    if (line.trimStart().startsWith('|')) {
      if (isTableDivider(line)) continue;
      closeParagraph();
      closeList();
      if (!inTable) {
        // The first row of a table is its header; these documents have no
        // headerless tables.
        html.push('<table><thead>' + tableRow(line.trim(), 'th') + '</thead><tbody>');
        inTable = true;
        continue;
      }
      html.push(tableRow(line.trim(), 'td'));
      continue;
    }
    closeTable();

    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (unordered !== null && unordered[1] !== undefined) {
      closeParagraph();
      if (list !== 'ul') {
        closeList();
        html.push('<ul>');
        list = 'ul';
      }
      html.push('<li>' + renderInline(unordered[1]) + '</li>');
      continue;
    }

    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered !== null && ordered[1] !== undefined) {
      closeParagraph();
      if (list !== 'ol') {
        closeList();
        html.push('<ol>');
        list = 'ol';
      }
      html.push('<li>' + renderInline(ordered[1]) + '</li>');
      continue;
    }

    // A wrapped line inside a list continues the previous item. Without this,
    // the second line of a wrapped bullet would become its own paragraph and
    // read as if it were a separate statement.
    if (list !== null) {
      const previous = html.pop() ?? '';
      html.push(previous.replace(/<\/li>$/, '') + ' ' + renderInline(line.trim()) + '</li>');
      continue;
    }

    paragraph.push(line.trim());
  }

  closeAll();
  return html.join('\n');
}

/** Wraps rendered body HTML in a complete, readable standalone page. */
export function renderDocumentPage(title: string, lang: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
/* The same tokens as the app (applications/viewer/client/src/styles/index.css):
   dark by default, light for a visitor whose OS asks for it. This page ships no
   script, so it follows the OS preference only - the app's own toggle is not
   readable here. It also uses the system font stack: the app's Geist files are
   emitted with content hashes, so there is no stable URL to point a
   @font-face at from server-rendered HTML. */
:root {
  color-scheme: dark;
  --bg: #0b0d10; --surface: #12151a; --raised: #1a1e25;
  --line: #262b33; --line-strong: #363d48;
  --ink: #e8ebef; --ink-2: #9ba4af; --accent: #7c98ff;
}
@media (prefers-color-scheme: light) {
  :root {
    color-scheme: light;
    --bg: #f6f6f4; --surface: #ffffff; --raised: #eef0f2;
    --line: #dfe2e6; --line-strong: #c3c9d0;
    --ink: #12161b; --ink-2: #465059; --accent: #3450d6;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-font-smoothing: antialiased; overflow-wrap: break-word;
}
header.site { background: var(--surface); border-bottom: 1px solid var(--line); }
header.site nav {
  display: flex; align-items: center; flex-wrap: wrap; gap: 0 1.5rem;
  max-width: 46rem; margin: 0 auto; padding: 0.5rem 1.5rem; font-size: 0.875rem;
}
header.site a { color: var(--ink-2); text-decoration: none; padding: 0.625rem 0; }
header.site a:hover { color: var(--ink); }
header.site a.brand {
  display: inline-flex; align-items: center; gap: 0.5rem; margin-right: auto;
  color: var(--ink); font-size: 1rem; font-weight: 600; letter-spacing: -0.01em;
}
main { max-width: 46rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
h1, h2, h3, h4 { line-height: 1.25; margin: 2.5rem 0 0.75rem; color: var(--ink); letter-spacing: -0.01em; }
h1 { margin-top: 0; font-size: 1.75rem; }
h2 { font-size: 1.25rem; }
h3 { font-size: 1.0625rem; }
a { color: var(--accent); text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
code {
  font-family: ui-monospace, "SFMono-Regular", "Cascadia Mono", monospace; font-size: 0.875em;
  background: var(--raised); padding: 0.1em 0.35em; border-radius: 6px; overflow-wrap: anywhere;
}
/* A wide table scrolls inside itself instead of widening the page: this was
   the 989px-wide document on a 390px phone. */
table { display: block; max-width: 100%; overflow-x: auto; border-collapse: collapse; margin: 1.25rem 0; }
th, td { border: 1px solid var(--line); padding: 0.5rem 0.75rem; text-align: left; vertical-align: top; }
th { background: var(--surface); }
hr { border: 0; border-top: 1px solid var(--line); margin: 2.5rem 0; }
li { margin: 0.35rem 0; }
@media (prefers-reduced-motion: no-preference) { a { transition: color 150ms cubic-bezier(0.16, 1, 0.3, 1); } }
</style>
</head>
<body>
<header class="site"><nav aria-label="Site"><a class="brand" href="/"><svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 10.5h4l2.5-6.5 4 12 2.5-5.5h4"/></svg>metrion</a><a href="/impressum">Impressum</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></nav></header>
<main>
${bodyHtml}
</main>
</body>
</html>
`;
}
