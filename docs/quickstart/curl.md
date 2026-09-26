# Quickstart: curl

The whole client in one command - no language runtime, no dependency, just
`curl` and a here-string. This is one of the per-language quickstart pages
(issue #10); see `docs/quickstart/README.md` for the shared reference (body
shapes, identifier charset, timestamp window, caps, error statuses).

It POSTs a single **enveloped** metric point - `resource` names the sender,
`metrics` is a one-element array. See
`docs/quickstart/bash-system-metrics.md` for the other accepted shape, the
bare array of metric points with no `resource` wrapper.

Every request needs `Authorization: Bearer mtr_<prefix>_<secret>` - the
`METRION_API_KEY` env var below is that whole header value's token, key
prefix and secret together.

## The command

```bash
#!/usr/bin/env bash
set -euo pipefail

INGEST_URL="${INGEST_URL:-http://localhost:8090/api/v1/ingest}"
API_KEY="${METRION_API_KEY:?set METRION_API_KEY=mtr_<prefix>_<secret>}"

TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

curl -sS -w '\nHTTP %{http_code}\n' \
  -X POST "${INGEST_URL}" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H 'Content-Type: application/json' \
  -d '{
        "resource": "vps-01",
        "metrics": [
          {
            "name": "cpu.usage",
            "value": 42.5,
            "unit": "percent",
            "timestamp": "'"${TIMESTAMP}"'",
            "interval": 60
          }
        ]
      }'
```

## Running it

```bash
METRION_API_KEY=mtr_<prefix>_<secret> ./ingest.sh
```

Executed against a local ingest service (`docker compose -f
docker-compose.dev.yml up -d`, then `applications/ingest`) with a seeded test
project and key, this answered:

```
{"accepted":1,"points":1}
HTTP 202
```

`accepted` is the number of envelopes the body normalized to (one, here);
`points` is the number of rows written.
