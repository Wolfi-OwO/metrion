# Quickstart: TypeScript

Same global `fetch` as the Node.js page, with a typed envelope so a typo in
a field name is a compile error instead of a `400` at runtime. No SDK, no
dependency beyond a TypeScript toolchain. See `docs/quickstart/README.md`
for the shared reference (body shapes, identifier charset, timestamp
window, caps, error statuses).

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` -
`METRION_API_KEY` below is that token, key prefix and secret together.

## The program

```ts
// quickstart.ts
interface MetricPoint {
  name: string;
  value: number;
  unit: string;
  timestamp: string;
  interval: number;
}

interface MetricEnvelope {
  resource: string;
  subResource?: string;
  metrics: MetricPoint[];
}

interface IngestAccepted {
  accepted: number;
  points: number;
}

const INGEST_URL = process.env.INGEST_URL ?? 'http://localhost:8090/api/v1/ingest';
const API_KEY = process.env.METRION_API_KEY as string;

const body: MetricEnvelope = {
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

async function main(): Promise<void> {
  const response = await fetch(INGEST_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (response.status === 202) {
    const accepted: IngestAccepted = await response.json();
    console.log(response.status, accepted);
    return;
  }

  console.error(response.status, await response.text());
  process.exitCode = 1;
}

await main();
```

## Running it

Node 22.6+ runs `.ts` files directly, stripping types with no build step
(unflagged on Node 23.6+; explicit flag below works on any Node ≥ 22.6):

```bash
METRION_API_KEY=mtr_<prefix>_<secret> node --experimental-strip-types quickstart.ts
```

Executed against a local ingest service (Node v24.11.0, both with and
without the explicit flag) with a seeded test project and key:

```
202 { accepted: 1, points: 1 }
```
