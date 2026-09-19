#!/usr/bin/env node
// WCAG 2.1 contrast checker for the --color-* custom properties in
// applications/viewer/client/src/styles/index.css. Plain node, no deps -
// this is the tool that css file's comments cite by name.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cssPath = path.join(__dirname, '../applications/viewer/client/src/styles/index.css');
const css = readFileSync(cssPath, 'utf8');

// Every "--color-xxx: value;" declaration, in source order.
const tokens = new Map();
for (const m of css.matchAll(/(--color-[\w-]+):\s*([^;]+);/g)) {
  tokens.set(m[1], m[2].trim());
}

// Resolve one level of var(--other-token) aliasing (status tokens alias
// series tokens).
function resolve(value) {
  const aliasMatch = value.match(/^var\((--[\w-]+)\)$/);
  if (aliasMatch) {
    const aliased = tokens.get(aliasMatch[1]);
    if (!aliased) throw new Error(`unresolved alias ${aliasMatch[1]}`);
    return aliased;
  }
  return value;
}

function hexToRgb(hex) {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function relativeLuminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexToRgb(hexA));
  const lB = relativeLuminance(hexToRgb(hexB));
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

const surfaces = [];
const textTokens = [];
for (const [name, rawValue] of tokens) {
  const hex = resolve(rawValue);
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) continue; // skip non-colour tokens
  if (/^--color-bg-/.test(name)) {
    surfaces.push({ name, hex });
  } else if (/^--color-(ink|series|status)-/.test(name) || name === '--color-ink') {
    textTokens.push({ name, hex });
  }
}

const FLOOR = 4.5;
let failed = false;
const rows = [];
for (const text of textTokens) {
  for (const surface of surfaces) {
    const ratio = contrastRatio(text.hex, surface.hex);
    if (ratio < FLOOR) failed = true;
    rows.push({ token: text.name, surface: surface.name, ratio });
  }
}

const tokenWidth = Math.max(...rows.map((r) => r.token.length));
const surfaceWidth = Math.max(...rows.map((r) => r.surface.length));
for (const { token, surface, ratio } of rows) {
  const mark = ratio < FLOOR ? '  FAIL' : '';
  console.log(
    `${token.padEnd(tokenWidth)}  ${surface.padEnd(surfaceWidth)}  ${ratio.toFixed(2)}${mark}`,
  );
}

if (failed) {
  console.error(`\nOne or more pairs fell below the ${FLOOR}:1 AA floor.`);
  process.exit(1);
}
