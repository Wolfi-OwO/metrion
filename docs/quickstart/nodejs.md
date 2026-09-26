# Quickstart: Node.js

No dependency: Node's own global `fetch` (stable since Node 18). See
`docs/quickstart/README.md` for the shared reference (body shapes,
identifier charset, timestamp window, caps, error statuses).

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` -
`METRION_API_KEY` below is that token, key prefix and secret together.

## The program

```js
// quickstart.mjs
const INGEST_URL = process.env.INGEST_URL ?? 'http://localhost:8090/api/v1/ingest';
const API_KEY = process.env.METRION_API_KEY;

const body = {
  resource: 'vps-01',
  metrics: [
    {
      name: 'cpu.usage',
      value: 42.5,
      unit: 'percent',
      timestamp: new Date().toISOString(),
      interval: 60,
    },
  ],
};

const response = await fetch(INGEST_URL, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const text = await response.text();
console.log(response.status, text);
if (!response.ok) process.exitCode = 1;
```

## Running it

```bash
METRION_API_KEY=mtr_<prefix>_<secret> node quickstart.mjs
```

Executed against a local ingest service (Node v24.11.0) with a seeded test
project and key:

```
202 {"accepted":1,"points":1}
```
