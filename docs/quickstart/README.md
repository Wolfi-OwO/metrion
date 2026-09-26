# Ingest quickstart

`POST /api/v1/ingest` is Metrion's one write path. No SDK is published or
implied - every page here is a complete program using only the language's
standard library or its single most standard HTTP client:

- [`curl.md`](curl.md)
- [`nodejs.md`](nodejs.md) - Node's global `fetch`
- [`typescript.md`](typescript.md) - `fetch` with a typed envelope
- [`dotnet.md`](dotnet.md) - `HttpClient` + `System.Text.Json`
- [`python.md`](python.md) - `urllib.request`, no `requests`
- [`go.md`](go.md) - `net/http`
- [`java.md`](java.md) - `java.net.http.HttpClient`
- [`bash-system-metrics.md`](bash-system-metrics.md) - the smallest real
  integration: CPU/memory/disk off `/proc` and `df`

Everything below is verified against
`applications/ingest/src/schemas/ingest.schemas.ts`, the actual runtime
validator - not derived from a spec that could drift from it.

## Authentication

`Authorization: Bearer mtr_<prefix>_<secret>`. `key_prefix` is an indexed,
non-secret lookup value; `secret` is checked with a constant-time hash
compare (`applications/ingest/src/middlewares/api-key.ts`). An unknown
prefix, a revoked key and a right-prefix-wrong-secret key all answer the
same `401` - nothing about the response tells a caller which of the three it
hit.

Tenancy (which project a row is written under) comes **only** from the
authenticated key, never from anything in the request body - see
`docs/adr/0005-api-key-determines-tenancy.md`. A body's `resource` field is
a free-text label, not an access-control claim.

## Body shapes

Three shapes are accepted, and the endpoint tells them apart by looking at
the JSON's own structure, not a header:

1. **One envelope** - an object:

   ```json
   { "resource": "vps-01", "subResource": "container:caddy-1", "metrics": [/* MetricPoint[] */] }
   ```

   `subResource` is optional.

2. **An array of envelopes** - up to 200 per request:

   ```json
   [
     { "resource": "vps-01", "metrics": [/* ... */] },
     { "resource": "vps-02", "metrics": [/* ... */] }
   ]
   ```

3. **A bare array of metric points** - up to 1000 per request, with no
   `resource` wrapper at all:
   ```json
   [
     {
       "name": "cpu.usage",
       "value": 42.5,
       "unit": "percent",
       "timestamp": "2026-01-01T00:00:00Z",
       "interval": 60
     }
   ]
   ```
   `resource` is filled in from the authenticated project's own
   `default_resource`. If the project has none configured, this shape
   answers `400` - send an enveloped body with an explicit `resource`
   instead. This is the shape a sender with no SDK writes most naturally,
   and the one `bash-system-metrics.md` demonstrates.

A metric point is:

| Field             | Type                                                        | Notes                                                                                                                 |
| ----------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `name`            | identifier (see below)                                      | Dotted metric name, e.g. `cpu.usage`.                                                                                 |
| `value`           | finite number                                               |                                                                                                                       |
| `unit`            | string, 1-32 chars                                          | Freeform, e.g. `percent`, `MiB`, `bytes/s`, `count`, `ms`, `boolean`.                                                 |
| `timestamp`       | ISO-8601 datetime, with a timezone offset (`Z` or `+00:00`) | See the timestamp window below.                                                                                       |
| `intervalSeconds` | positive integer, ≤ 86400 (24h)                             | Also accepted under the alias `interval` - the field name the bare metric-point shape is written with most naturally. |

Unknown keys on an envelope are silently stripped, not rejected - a sender
running a newer client that adds a field keeps working.

## Identifier charset

`resource`, `subResource` and `name` all use the same rule: 1-200
characters, matching `^[A-Za-z0-9._:-]+$` - letters, digits, dot,
underscore, colon and hyphen. Nothing that could become a path segment or
worse. `:` and `.` are allowed because real senders already write things
like `container:portfolio-caddy-1` or `cpu.usage`.

## Timestamp window

`timestamp` must be no more than **5 minutes in the future** (normal clock
skew) and no more than **24 hours in the past**. Anything older is rejected
rather than silently accepted.

## Per-request caps

| Cap                                              | Value                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Metric points per envelope (or bare array)       | 1000                                                                                  |
| Envelopes per request (array-of-envelopes shape) | 200                                                                                   |
| Request body size                                | 256 KB                                                                                |
| Requests per API key                             | 120 per 60 seconds (default; `INGEST_RATE_LIMIT_MAX` / `INGEST_RATE_LIMIT_WINDOW_MS`) |

A request over the body-size cap is rejected before validation even runs
(`413`); a request within limits but validation-invalid is a `400` naming
the field.

## Response

A successful write answers `202 Accepted` - the rows are durably written,
but nothing is created at a URL the caller can then fetch:

```json
{ "accepted": 1, "points": 1 }
```

`accepted` is the number of envelopes the body normalized to; `points` is
the number of rows actually inserted.

## Error statuses

Every error is `{ "error": "<Name>", "message": "<...>", "statusCode": <n> }`;
a validation failure additionally carries `issues`, one entry per failed
field with a dot-joined `path` (e.g. `metrics.0.value`):

| Status | Meaning                                                                                                                                                 |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`  | The body failed validation (bad shape, identifier, timestamp, cap, ...), or a bare metric-point array was sent to a project with no `default_resource`. |
| `401`  | Missing, malformed, unknown or revoked API key.                                                                                                         |
| `404`  | No route matches.                                                                                                                                       |
| `413`  | Request body over the 256 KB cap.                                                                                                                       |
| `429`  | Too many requests for this API key in the current rate-limit window.                                                                                    |
| `500`  | Unhandled server error.                                                                                                                                 |

## The uptime convention

A generic checker for any application's uptime should follow this exact
convention, so one tenant's checker output renders identically to any
other's in the viewer (`docs/adr/0007-uptime-monitoring-as-metrics.md`):

- `uptime.ok` - `1` (up) or `0` (down), unit `boolean`. Always emitted, for
  every check.
- `uptime.latency` - response latency in `ms`. Emit this **only** when the
  check was a real network probe of the monitored endpoint - omit it
  entirely for a check performed through a cloud provider's control-plane
  API rather than an actual HTTP request, since that duration measures the
  control-plane call, not the monitored service.
- `resource` is the logical application/service name; `sub_resource`
  distinguishes instances of the same logical service (e.g. production vs.
  preview) where relevant.
- `avg(uptime.ok) * 100` over any time window **is** the uptime percentage
  for that window - this is deliberate, and is why `uptime.ok` is `0`/`1`
  rather than a status string.
- `interval_seconds` on an uptime check is a **nominal** value (the
  checker's intended cadence, e.g. `60`), not a guarantee. Never compute
  uptime as "checks received ÷ checks expected" from this field - a
  scheduler that fires more or less often than its nominal interval (a
  common real-world case) produces a percentage above 100% or an
  artificially low one. Always compute uptime as the share of received
  checks that passed.

Worked example - a checker reporting one passing probe:

```bash
curl -X POST https://<ingest-fqdn>/api/v1/ingest \
  -H "Authorization: Bearer mtr_<prefix>_<secret>" \
  -H "Content-Type: application/json" \
  -d '[{"name":"uptime.ok","value":1,"unit":"boolean","timestamp":"2026-01-01T00:00:00Z","interval":60}]'
```

## Running the examples locally

Every example on these pages defaults to `http://localhost:8090/api/v1/ingest`
(override with `INGEST_URL`) and reads its key from `METRION_API_KEY`. To
stand up that local instance:

```bash
docker compose -f docker-compose.dev.yml up -d   # TimescaleDB
npm run build --workspace @metrion/db --workspace @metrion/shared --workspace @metrion/ingest
cd applications/ingest && npm start              # http://localhost:8090
```

A project and API key still need to exist - seed one directly against the
database with the same pattern `applications/ingest/tests/ingest.test.ts`
uses (insert a `users` row, a `projects` row with the `default_resource` you
want the bare-array shape to fall back to, then an `api_keys` row whose
`key_hash` is `sha256(secret)`, `key_prefix` containing no underscore).
There is no account/project API yet to do this through instead.
