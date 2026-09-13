# Changelog

## Unreleased

- Add the metrics collector (`applications/collector`): reads CPU, RAM,
  disk, network throughput, per-container stats and per-hostname request
  counts off the VPS once a minute (systemd timer) and appends them to an
  Azure Blob Storage append blob, with local queueing/retry if Azure is
  briefly unreachable.
- Add `packages/shared`: the `MetricEnvelope` wire format
  (`resource`/`subResource`/`metrics[]`) both the collector and the future
  viewer read/write. The pre-cutover `MetricsSample` shape survives as
  `LegacyMetricsSample`, read-only, so the viewer can still parse blob
  lines written before the switch - see `docs/adr/0003-*.md`.
- Rename the project to mona. The server-side deploy path, state/config
  directories, systemd units and Azure container keep the `vps-metrics`
  name on purpose - see `organizational/agent-deployment-runbook.md`.
- Add the viewer (`applications/viewer`): an Express 4 app that reads the
  day-blobs back and serves a public query API (`/api/v1/resources`,
  `/api/v1/metrics`, range required and capped at 31 days), a
  token-authenticated `POST /api/v1/ingest` for senders that hold no blob
  SAS, and an OpenAPI document plus Swagger UI at `/openapi.json` and
  `/docs` generated from the same zod schemas the API validates with.
  Reads both wire formats, detecting the shape per blob line, so a chart
  spanning the cutover is continuous.
- Add the React charts client (`applications/viewer/client`) and serve it
  from the viewer itself, so the whole app ships as one image with one
  origin and needs no CORS in production.
- Serve `IMPRESSUM.md`, `PRIVACY.md` and `TERMS_OF_USE.md` as HTML at
  `/impressum`, `/privacy` and `/terms`. § 5 ECG requires the Impressum to
  be reachable from the deployed site; a Markdown file in a Git repository
  is not. Both are exempt from the rate limiter.
- Harden the Caddy request aggregation against a hostile `Host:` header:
  a request with `Host: __proto__` polluted `Object.prototype` and threw,
  silently dropping that whole minute's `requests.*` metrics for as long as
  it kept being sent. Distinct hosts are now capped per minute and must
  match the same charset the ingest endpoint enforces.
- Add CI (`.github/workflows/ci.yml`): lint, format, typecheck, build and
  test on every push and pull request.
- Decommission the pre-Metrion pipeline (`mona-viewer`/`mona-rg`, the
  `vps-metrics` blob container): deleted after the new VPS agent -> Metrion
  ingest -> self-hosted TimescaleDB pipeline showed real data arriving in
  Postgres, re-confirmed immediately before teardown and again after. Last
  day-blob `2026-09-13.jsonl` (`<REDACTED-STORAGE-ACCOUNT>/vps-metrics`, last modified
  `2026-09-13T16:43:04Z`, the same instant Postgres's `metrics.time` starts)
  - not migrated into the database, a deliberate call, not an oversight; see
    `organizational/agent-deployment-runbook.md`'s "Old Azure sink retirement"
    and `organizational/viewer-deployment-runbook.md`'s "Teardown, as actually
    executed" for the full record, including one live incident found and
    fixed along the way (a hung collector run) and one live dependency
    (`mona-deploy`, still used by Metrion's own deploy workflow) that kept
    `mona-rg` itself from being deleted.
