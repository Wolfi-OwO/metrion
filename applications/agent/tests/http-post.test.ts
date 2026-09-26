import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import type { MetricEnvelope } from '@metrion/shared';
import { sendEnvelopes } from '../dist/sink/http-post.js';

const envelopes: MetricEnvelope[] = [
  {
    resource: 'vps-contabo-01',
    metrics: [
      {
        name: 'cpu.usage',
        value: 12.5,
        unit: 'percent',
        intervalSeconds: 60,
        timestamp: new Date().toISOString(),
      },
    ],
  },
];

/** Starts a local server on an ephemeral port and returns its base URL plus a closer. */
async function startServer(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('expected a bound TCP address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test('sendEnvelopes: POSTs the envelope array as JSON with a Bearer auth header', async () => {
  let received: { method?: string; auth?: string; contentType?: string; body: string } | undefined;
  const { url, close } = await startServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received = {
        method: req.method,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      };
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accepted: 1, points: 1 }));
    });
  });

  try {
    await sendEnvelopes(
      { ingestUrl: url, apiKey: 'mtr_abc123_secret', timeoutMs: 2000 },
      envelopes,
    );
  } finally {
    await close();
  }

  assert.equal(received?.method, 'POST');
  assert.equal(received?.auth, 'Bearer mtr_abc123_secret');
  assert.equal(received?.contentType, 'application/json');
  assert.deepEqual(JSON.parse(received?.body ?? '[]'), envelopes);
});

test('sendEnvelopes: throws on a non-2xx response', async () => {
  const { url, close } = await startServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'UnauthorizedError' }));
  });

  try {
    await assert.rejects(
      () => sendEnvelopes({ ingestUrl: url, apiKey: 'mtr_bad_key', timeoutMs: 2000 }, envelopes),
      /HTTP 401/,
    );
  } finally {
    await close();
  }
});

test('sendEnvelopes: throws when the endpoint is unreachable', async () => {
  // Nothing is listening on this port - a real "ingest is down" case, the
  // one the queue's retry behavior (main.ts's flushQueue) depends on.
  const { url, close } = await startServer(() => {});
  await close(); // close immediately so the port is refused, not just idle

  await assert.rejects(() =>
    sendEnvelopes({ ingestUrl: url, apiKey: 'mtr_abc_secret', timeoutMs: 2000 }, envelopes),
  );
});
