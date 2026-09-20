#!/usr/bin/env node
// WCAG 2.1 contrast checker for the colour tokens in
// applications/viewer/client/src/styles/index.css, for BOTH themes.
//
// Plain node, no dependencies - this is the tool that css file's comments cite
// by name, and CI runs it. Three checks:
//   1. every text-role token clears 4.5:1 on every surface it can sit on;
//   2. the control border clears 3:1 (WCAG 1.4.11) and text on an accent fill
//      clears 4.5:1;
//   3. the two light blocks (explicit `data-theme` and the OS media query) are
//      identical, because they are the same theme written twice on purpose.
// The token lists are derived from the CSS, not hard-coded here, so adding a
// series colour or a surface extends the matrix without touching this file.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const css = readFileSync(
  path.join(__dirname, '../applications/viewer/client/src/styles/index.css'),
  'utf8',
);

/** The body of the first `{ ... }` block that follows `opener`. */
function block(opener) {
  const at = css.indexOf(opener);
  if (at === -1) throw new Error(`css block not found: ${opener}`);
  const start = css.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  throw new Error(`unterminated css block: ${opener}`);
}

function declarations(body) {
  const map = new Map();
  for (const m of body.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)) map.set(m[1], m[2].trim());
  return map;
}

const dark = declarations(block('@theme {'));
const lightExplicit = declarations(block(":root[data-theme='light']"));
const lightMedia = declarations(block(":root:not([data-theme='dark'])"));

let failed = false;
const fail = (message) => {
  failed = true;
  console.error(`FAIL  ${message}`);
};

// Check 3: the two light blocks must be the same theme.
for (const [name, value] of lightExplicit) {
  if (lightMedia.get(name) !== value) fail(`light blocks differ on ${name}`);
}
for (const name of lightMedia.keys()) {
  if (!lightExplicit.has(name)) fail(`${name} is only in the media-query light block`);
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}
function luminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function ratio(a, b) {
  const la = luminance(hexToRgb(a));
  const lb = luminance(hexToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const SURFACES = ['--color-bg', '--color-surface', '--color-raised'];
const TEXT = /^--color-(ink|ink-2|ink-3|accent|accent-strong|series-\d|status-\w+)$/;

for (const [theme, overrides] of [
  ['dark', new Map()],
  ['light', lightExplicit],
]) {
  const tokens = new Map([...dark, ...overrides]);
  const hex = (name) => {
    let value = tokens.get(name);
    const alias = value?.match(/^var\((--[\w-]+)\)$/);
    if (alias) value = tokens.get(alias[1]);
    if (!value || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new Error(`${theme}: ${name} = ${value}`);
    return value;
  };

  console.log(`\n== ${theme} ==`);
  let worst = Infinity;
  for (const name of tokens.keys()) {
    if (!TEXT.test(name)) continue;
    for (const surface of SURFACES) {
      const r = ratio(hex(name), hex(surface));
      worst = Math.min(worst, r);
      if (r < 4.5) fail(`${theme}: ${name} on ${surface} is ${r.toFixed(2)}:1 (need 4.5)`);
    }
  }
  console.log(`text tokens on bg/surface/raised: worst ${worst.toFixed(2)}:1`);

  for (const surface of SURFACES) {
    const r = ratio(hex('--color-control'), hex(surface));
    if (r < 3) fail(`${theme}: --color-control on ${surface} is ${r.toFixed(2)}:1 (need 3)`);
  }
  const onAccent = ratio(hex('--color-accent-ink'), hex('--color-accent'));
  const onAccentStrong = ratio(hex('--color-accent-ink'), hex('--color-accent-strong'));
  console.log(
    `accent-ink on accent ${onAccent.toFixed(2)}:1, on accent-strong ${onAccentStrong.toFixed(2)}:1`,
  );
  if (onAccent < 4.5) fail(`${theme}: accent-ink on accent is ${onAccent.toFixed(2)}:1`);
  if (onAccentStrong < 4.5)
    fail(`${theme}: accent-ink on accent-strong is ${onAccentStrong.toFixed(2)}:1`);

  // The one deliberate exception: hairlines are decoration, not information.
  console.log(
    `hairline --color-line on surface ${ratio(hex('--color-line'), hex('--color-surface')).toFixed(2)}:1 (decorative, exempt)`,
  );
}

if (failed) {
  console.error('\nContrast check failed.');
  process.exit(1);
}
console.log('\nAll pairs clear their floor in both themes.');
