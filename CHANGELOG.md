# Changelog

## 2026-09-13 — Legal documents: accounts, self-hosted database, alerting (forward-looking)

- Rewrote `PRIVACY.md` sections 1, 2, 4, 5, 6, 7 and 8: retired the
  single-tenant/no-account/no-cookie/Australia-Southeast-Chapter-V position
  now falsified by OAuth accounts (`packages/db/migrations/0002_accounts.sql`),
  the `mtr_session` cookie (`applications/viewer/src/auth/session.ts`), and
  the self-hosted TimescaleDB-on-Contabo database
  (`organizational/agent-deployment-runbook.md:159-183`) that replaced the
  originally planned managed Azure Postgres West Europe store.
- Named Contabo GmbH as a new Art 28 DSGVO processor for the database;
  recorded the VPS's datacentre country (France, Lauterbourg — measured via
  whois + IP geolocation against `<VPS-IP>`) for the first time; named
  Backblaze B2 EU-Central as the stated-but-not-yet-credentialed offsite
  backup target.
- Added the DSAR/deletion cascade (`identities` → `sessions` → `api_keys`
  → `projects` → `metrics` → `users`) and named the three OAuth sign-in
  providers (Google, Microsoft, GitHub) as separate controllers, not Art 28
  processors, in both `PRIVACY.md` and `IMPRESSUM.md`.
- Rewrote `IMPRESSUM.md`'s § 25 MedienG purpose statement and removed "kein
  Nutzerkonto"; added the entgeltlich/gewerblich re-assessment (still no
  billing code in the repository as of this date, so the service remains
  non-commercial under § 5 Abs 1 ECG for now).
- Rewrote `TERMS_OF_USE.md` §1 and §3 for the real per-project API-key
  ingest model (`docs/adr/0005-api-key-determines-tenancy.md`), added an
  operator-as-processor statement for a key holder's own application data,
  a deletion commitment, and a new §7 account-termination clause.
- Added forward-looking (not yet built — GitHub issues #20-#24) coverage
  for the planned threshold-alerting feature: a new Art 28 processor for
  outbound transactional alert email (Brevo tentative, EEA-preferred),
  the Art 6(1)(b) basis for alert delivery, the § 174 TKG 2021
  transactional-not-marketing basis, the extended DSAR cascade to
  `thresholds`/`threshold_status`/`status_events`, a 180-day retention line
  for `status_events`, and a best-effort/no-SLA sentence in
  `TERMS_OF_USE.md` §4 for alert delivery.
- Added a "Third-party components" note to `LICENSE` recording the Timescale
  License (TSL) text actually read and the conclusion that self-hosting
  TimescaleDB behind metrion's HTTP-only API reads as permitted "Value
  Added Products or Services" use under TSL § 2.1(b)/§ 3.10, not the
  prohibited database-as-a-service use under TSL § 2.2.

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
- Replace the `mona-deploy` CI/CD identity with `metrion-deploy`, a new
  identity in `metrion-rg` carrying the same two federated credentials and
  the same three role assignments, and cut `.github/workflows/deploy.yml`
  over to it. Verified with a real, manually-triggered deploy run
  (`workflow_dispatch`, GitHub Actions run `34778998281`) that succeeded end
  to end - migration plus both app deploys - under the new identity before
  the old one was deleted. `mona-deploy` and `mona-rg` are now gone;
  `az group exists -n mona-rg` returns `false`.
