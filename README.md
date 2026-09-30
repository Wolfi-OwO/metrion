# metrion

A small multi-tenant metrics platform: any application, in any language,
`POST`s numbers to one authenticated ingest endpoint; a viewer reads them
back as charts. It started as a single-purpose collector for my own Contabo
VPS and grew a real write API once a second use case (uptime checks from
`portfolio-webpage`'s status page, see `docs/adr/0007-*.md`) needed the same
pipeline instead of its own.

New to this - send your first metric in under five minutes with
[`docs/quickstart/`](docs/quickstart/), one complete copy-pasteable program
per language, no SDK required.

I built it because three separate things were about to measure the same
numbers independently (the VPS collector, a planned overload alarm, and a
planned CPU/RAM tile on my status page) - see
`docs/adr/0002-one-metrics-source.md` for why that's exactly the kind of
bug I've hit before and why there's now exactly one source instead.

## Features

- One authenticated write path, `POST /api/v1/ingest`
  (`applications/ingest`), that any sender can use with nothing but an HTTP
  client and a per-project API key (`mtr_<prefix>_<secret>`) - no SDK
  published or implied. Tenancy is resolved from the key alone, never from
  request content - see `docs/adr/0005-api-key-determines-tenancy.md`.
- A generic metric envelope (`docs/adr/0003-generic-metric-envelope.md`):
  `{ resource, subResource?, metrics: [{ name, value, unit, timestamp,
intervalSeconds }] }`. The same shape covers a VPS's CPU%, a container's
  restart count, a website's request latency, or an uptime check's `ok`/`0`
  boolean - see the uptime convention in `docs/quickstart/README.md`.
- Writes land in Postgres/TimescaleDB (`docs/adr/0004-postgres-timescaledb-over-append-blob.md`)
  - a real hypertable with continuous aggregates and retention policies,
    not a growing pile of blobs.
- A viewer (`applications/viewer`) that reads it back: a public query API, a
  React charts client on one shared time axis, and an OpenAPI documentation
  site at `/docs` generated from the same zod schemas the API validates
  with.
- The original VPS collector (`applications/agent`) still runs as the
  reference sender: CPU%, load average, honest RAM usage (not the classic
  `free`-double-counts-cache mistake), root disk usage, Docker's own disk
  footprint, network throughput, per-container stats, and per-hostname
  request counts/status codes/latency from Caddy's access log, reported to
  the ingest endpoint once a minute.
- No client IPs, no user agents, no request paths/query strings anywhere in
  the pipeline - see the delivery report's Privacy section.

## Tech stack

TypeScript/Node, npm workspaces - matching every other project in
`software-engineering/projects/web-apps/`.

The **collector** is deployed as a systemd timer, not a container - see
`organizational/agent-deployment-runbook.md` for why (no image builds on the VPS,
and Node's own `apt` package is already there). It runs on Node 18.19,
which is what Ubuntu 24.04 ships, so the root `engines` floor stays there.

The **ingest** service is Express 4 + zod 4 on Node 22
(`applications/ingest`) - the one write path, deployed as its own container
on the VPS behind Caddy (`https://metrion-ingest.woofi-developments.at`; moved
off Azure Container Apps on 2026-09-20, see `docs/adr/0008-*.md`) so a schema
bug in it can never take the read side down.

The **viewer** is Express 4 + zod 4 on Node 22, with a React 19 / Vite /
Recharts client, built into one image and hosted on Azure Container Apps at
`minReplicas: 0`, reachable at `https://metrion.woofi-developments.at` (a
custom domain in front of the Container Apps default hostname since
2026-09-30 - the old `*.azurecontainerapps.io` hostname now redirects there,
see `organizational/oauth-provider-setup.md`). The server serves the
client's assets itself: one image, one origin, no CORS in production and one
thing to deploy.

Both apps and the collector share `packages/db` (raw `pg`, hand-written
`.sql` migrations - hypertables and continuous aggregates aren't
expressible in an ORM's schema DSL) and `packages/shared` (the
`MetricEnvelope` wire format).

## Project structure

```
applications/
├── agent/         the minute-by-minute VPS collector - the reference sender
├── ingest/        the one write path: POST /api/v1/ingest, API-key auth
└── viewer/        the read side: query API, /docs, client/ (React charts)
packages/
├── db/            Postgres/TimescaleDB schema, migrations, connection pool
└── shared/        MetricEnvelope - the wire format every app agrees on
docs/
├── adr/           architecture decisions (storage type, one metrics source,
│                  the generic envelope, tenancy, uptime-as-metrics)
└── quickstart/    send your first metric in any language, no SDK
organizational/    deployment runbooks
.github/workflows/ lint, format, typecheck, build and test on every push
```

## Getting started

```bash
npm install
npm run typecheck
npm test          # every workspace: agent, ingest, viewer, client
npm run lint && npm run format:check
```

Bring up Postgres/TimescaleDB and run the migrations:

```bash
docker compose -f docker-compose.dev.yml up -d
npm run build --workspace @metrion/db
npm run migrate --workspace @metrion/db
```

Run the ingest service - see `docs/quickstart/` for a first metric in any
language:

```bash
cd applications/ingest
cp .env.example .env
npm start   # http://127.0.0.1:8090
```

Run the viewer:

```bash
cd applications/viewer
cp .env.example .env
npm start   # http://127.0.0.1:8080
npm --workspace @metrion/viewer-client run dev   # the client, on Vite
```

Run the collector locally without a real Metrion API key:

```bash
cd applications/agent
cp .env.example .env   # then set DRY_RUN=true
node --env-file=.env dist/main.js
```

Or build the viewer as the single image that is actually deployed. Note it
builds from the repository root, because npm workspaces need the root
manifest and lockfile:

```bash
docker build -f applications/viewer/Dockerfile -t metrion-viewer .
docker run --rm -p 8080:8080 metrion-viewer
```

## Security

Every write to `/api/v1/ingest` is authenticated with a per-project API key
(`mtr_<prefix>_<secret>`); the secret is only ever checked against a hash,
never stored or logged in the clear. See `SECURITY.md` and
`docs/adr/0005-api-key-determines-tenancy.md`.

## Legal

The viewer is reachable from the public internet, so it carries the same
legal surface as my other public projects. All three are also served by the
running app at `/impressum`, `/privacy` and `/terms` - § 5 ECG wants the
Impressum reachable from the deployed site, and a file in a Git repository
is not that:

- [`IMPRESSUM.md`](IMPRESSUM.md) - Offenlegung per § 5 ECG and § 25 MedienG.
- [`PRIVACY.md`](PRIVACY.md) - what is stored and what deliberately is not,
  with the file and line behind every claim. No cookies, no analytics, no
  tracking, no third-party request from the browser - and therefore no
  consent banner.
- [`TERMS_OF_USE.md`](TERMS_OF_USE.md) - who may use the read API and the
  ingest endpoint, and what a token holder answers for.

## Contributing

See `CONTRIBUTING.md`.

## License

Proprietary - see `LICENSE`.
