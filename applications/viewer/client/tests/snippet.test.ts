import assert from 'node:assert/strict';
import test from 'node:test';
import { INGEST_URL, quickstart, tokenize } from '../src/lib/snippet.ts';

const NOW = new Date('2026-09-20T17:30:00.123Z');

test('tokens rebuild the exact plain text, so the copy button and the screen cannot differ', () => {
  const text = quickstart(NOW);
  assert.equal(
    tokenize(text)
      .map((token) => token.text)
      .join(''),
    text,
  );
});

test('every JSON attribute has its own line and the body is valid JSON', () => {
  const text = quickstart(NOW);
  const body = /-d '([\s\S]*)'$/.exec(text)?.[1];
  assert.ok(body, 'the -d body is single-quoted and last');
  const parsed = JSON.parse(body) as { resource: string; metrics: Record<string, unknown>[] };
  const lines = body.split('\n');
  for (const attribute of ['resource', 'name', 'value', 'unit', 'intervalSeconds', 'timestamp']) {
    assert.equal(lines.filter((line) => line.includes(`"${attribute}":`)).length, 1, attribute);
  }
  // Nothing after a comma on the same line except the end of it.
  assert.ok(
    lines.every((line) => !/,\s*"/.test(line)),
    'no two attributes share a line',
  );
  assert.equal(parsed.metrics[0]?.['timestamp'], '2026-09-20T17:30:00Z');
});

test('the example targets the deployed ingest host and its timestamp comes from the clock', () => {
  assert.ok(quickstart(NOW).startsWith(`curl ${INGEST_URL} \\`));
  // The ingest schema rejects anything older than 24 h or more than 5 min ahead,
  // so a default-argument call must land inside that window.
  const stamp = /"timestamp": "([^"]+)"/.exec(quickstart())?.[1] ?? '';
  const offset = Date.now() - Date.parse(stamp);
  assert.ok(offset >= 0 && offset < 5000, `timestamp is ${offset} ms old`);
});

test('keys, string values, numbers, flags and the placeholder are told apart', () => {
  const kinds = (needle: string) =>
    tokenize(quickstart(NOW)).find((token) => token.text === needle)?.kind;
  assert.equal(kinds('curl'), 'command');
  assert.equal(kinds('-H'), 'flag');
  assert.equal(kinds('"resource"'), 'key');
  assert.equal(kinds('"vps-01"'), 'string');
  assert.equal(kinds('42.5'), 'number');
  assert.equal(kinds('<prefix>'), 'placeholder');
  assert.equal(kinds(INGEST_URL), 'url');
});
