# Changelog

## v0.5.3 - 2026-10-10

Patch release: root, agent, ingest, evaluator, shared and db packages go to
0.5.3; the viewer and its client go to 0.7.3.

- The repository now carries `docs/ai` project memory (`AGENTS.md`,
  `CLAUDE.md`, an index, codebase map, the service-grouping decision and
  feature note, active tasks and a session handoff), kept free of server
  addresses and key names because the public mirror exports it.
- The old pre-v0.2.0 changelog block is relabelled "Before v0.2.0" instead of
  claiming to be unreleased. GitHub release pages now exist for every tag.

## v0.5.2 - 2026-10-10

Patch release: root, agent, ingest, evaluator, shared and db packages go to
0.5.2; the viewer and its client go to 0.7.2.

- The deployment runbook now records that the evaluator is copied to the VPS
  by hand rather than deployed by CI, and the order in which to clean up stale
  per-colour status rows after migration 0023. The v0.5.1 grouping fix is live
  in production: Fuwwy Platform evaluates as one service and no threshold is
  non-ok.

## v0.5.1 - 2026-10-04

Bugfix release: root, agent, ingest, evaluator, shared and db packages go to
0.5.1; the viewer and its client go to 0.7.1.

- Blue/green deploys and scaled pods are one service now. The idle colour of a
  blue/green app stops reporting by design, but the evaluator gave it its own
  status row that went critical/no_data and never cleared (Fuwwy Platform sat
  at Critical with "no data" for a day), and the viewer listed blue and green
  as two dashboards. Migration 0023 adds `service_group()`; the evaluator and
  the metrics API group by it, so a service's value is the mean of its running
  pods (each pod averaged first, never summed) and a silent idle colour is
  not a fault. The metrics page gets a "Show all pods" toggle for the
  per-pod lines; `GET /metrics` takes `perInstance=true` for the same.
  Per-colour thresholds and stale per-colour status rows are merged/dropped by
  the migration.

## v0.5.0 - 2026-10-01

Platform release: root, agent, ingest, evaluator, shared and db packages go to
0.5.0; the viewer and its client go to 0.7.0 (next minor of their own line).

- The evaluator's daily per-project email-notification cap default is a real
  ceiling again: 75, up from the original 50, which was too tight and had
  caused false flapping over-sends; the previous release had left it at
  effectively unlimited until this value replaced that placeholder.
- `uptime.ok` alerting now detects in one evaluator cycle instead of two: the
  averaging window dropped from 900s to 300s, the critical bound tightened to
  0.7, the separate warning step was dropped, and the consecutive-breach
  requirement fell to 1. A repeated real outage test confirms the effect:
  detection dropped from roughly 3 minutes to roughly 2, recovery from
  roughly 15 minutes to roughly 4.5 - the remaining floor is the averaging
  math itself (crossing the bound still needs 2 failed checks, regardless of
  breach count), not an implementation limit.
- A new `lastCheck` field exposes each application's single newest raw check,
  independent of the averaged/alerting threshold state, and now surfaces in
  the UI as a secondary "Up/Down · Ns ago" line on dependency-graph nodes,
  the selected-application panel and the status screen's application rows -
  deliberately subordinate to the real status badge (it never borrows
  OK/Warning/Critical wording), so a real outage is visible well before the
  averaged threshold confirms it. Fixed a dependency-graph layout bug this
  line introduced, where nodes overlapped the node below them because the
  layout engine's reserved node height hadn't been updated for the extra
  line; re-measured from the real rendered CSS rather than guessed.
- The dependency graph's connector lines got a real design pass: stroke width
  and arrowhead size now scale with severity, the "outage travelling along
  this edge" indicator actually animates instead of sitting static, and
  hover/selection now dims unrelated nodes to match the edges, which
  previously dimmed alone; the graph canvas's padding was also matched to
  its sibling panel.

## v0.4.0 - 2026-10-01

Platform release: root, agent, ingest, evaluator, shared and db packages go to
0.4.0; the viewer and its client go to 0.6.0 (next minor of their own line).

- The status, dashboard and metrics screens now poll in the background, each
  screen on its own independent interval rather than a shared clock, without
  blanking the page, losing scroll position, open panels, typed form input or
  chart hover state; the dependency graph re-renders from fresh data on every
  refresh.
- The status screen shows a "last updated Ns ago" indicator, with a caution
  state when a background refresh fails; dashboard row order no longer
  shuffles under the cursor on every refresh.
- The status API gained a `lastCheck` field exposing each application's
  single newest raw check, independent of the averaged/alerting threshold
  state - foundation for an instant-status indicator, not yet wired into the
  UI.
- The evaluator's daily per-project email-notification cap default was raised
  from 50 to effectively unlimited: it is a safety valve, not a real limit,
  until real SMTP delivery is configured.
- Breaking: `container.cpu` thresholds are re-anchored from the 95th/99th
  percentile of normal load to 50%/80% of each container's actual configured
  CPU limit, with a wider averaging window (900s, up from 300s) - fixes
  false-positive flapping (179 events in ~33h) caused by bounds that were, by
  construction, exceeded by around 5% of normal minutes.
- A live end-to-end test confirmed the uptime-monitoring pipeline detects a
  real outage, attributes root cause, alerts and recovers correctly; results
  and real measured timings (for example ~3 minutes slower via the averaged
  threshold than the raw first failed check) are recorded in
  `organizational/uptime-alerting.md`.

## v0.3.0 - 2026-09-30

Platform release: root, agent, ingest, evaluator, shared and db packages go to
0.3.0; the viewer and its client go to 0.5.0 (next minor of their own line).

- Uptime history is permanent (ADR 0009): ingest writes every uptime point to
  `uptime_samples` as well as `metrics` in one transaction, a database job
  rebuilds daily and incident rollups every 10 minutes, and a scratch-database
  test proves dropping metrics chunks cannot erase that history.
- Ingest serves a public uptime range endpoint with bucketing, incidents and
  an LRU cache.
- Breaking: the public uptime endpoints only list applications opted in via
  `public_status_visible` (migration 0016, default off); the portfolio's seven
  real monitors are opted in, and the viewer's application PATCH can toggle it.
- Ingest caps each API key at 10,000 permanent uptime rows per hour and answers
  429 beyond that; `scripts/purge-uptime.mjs` is the superuser-only delete path.
  Resource registration is one query instead of one insert per resource.
- The uptime rollup's incident lookback is floored at 30 days and its functions
  pin `search_path` and no longer grant EXECUTE to `PUBLIC`.
- Portfolio uptime history was backfilled from Mongo: once into the permanent
  store (script deleted after the run) and 90 days into the metrics hypertable
  (issue #27), keyed by each monitor's live `metrionKey` and clamped to each
  resource's live-write start so nothing is duplicated.
- Alerting: production thresholds are seeded for Applications Server 01, and
  the `uptime.ok` warning bound moved from 0.995 to 0.9 so a single flapped
  check stays silent while a real outage sends exactly one email.
- Breaking for agent installs: the VPS agent POSTs to Metrion's ingest endpoint
  instead of the deleted Azure append blob and no longer needs the `AZURE_*`
  settings.
- Viewer: the dashboard was rebuilt around an overview band, per-group health
  and activity, a filter and a first-run state, backed by a new owner-scoped
  projects summary endpoint; the status screen, metric strips and API key
  screen were reworked; a saved light theme, Rethink Sans and Chivo Mono type,
  44px phone controls and a pinned footer with a Legal menu landed.
- Viewer copy: the dashboard's "Project" grouping is now "Group", and the scope
  picker's "Whole server" is now "Whole host".
- The viewer redirects its old default Azure hostname to
  `metrion.woofi-developments.at` before an OAuth login starts, since the
  host-only login cookie could never complete across hosts.
- Deploy only runs for a CI push on this repository's own `main`, closing the
  path where a fork PR branch named `main` could start a deploy.
- Privacy Policy and Terms of Use gained the uptime-history storage, retention
  and erasure terms, and their locality was corrected to Fürnitz.
- The VPS uptime checker was retired; the Azure Function is the single writer
  for netviz, nutrilens and portfolio uptime. The README was rewritten around
  the ingest write path with per-language quickstarts.

## v0.2.0 - 2026-09-20

Platform release: root, agent, ingest, evaluator, shared and db packages go to
0.2.0; the viewer and its client go to 0.4.0 (next minor of their own line).

- Ingest runs on the Contabo VPS behind Caddy at
  `https://metrion-ingest.woofi-developments.at`, and the Azure `metrion-ingest`
  app is deleted. Only the viewer stays on Azure (ADR 0008).
- Ingest connects to the database as the least-privilege role `metrion_ingest`
  with a connection limit; `PUBLIC` connect and temp on the database were
  revoked.
- Viewer hardening: state-changing requests must come from the viewer's own
  origin, the session cookie carries the `__Host-` prefix, OAuth logins are
  bound to the browser that started them, and malformed uuid path ids answer 400.
- The ingest deploy gate now asserts ingest privileges on every chunk relation,
  performs a real ingest POST and reads the public uptime endpoint, with
  automatic rollback on failure.
- Postgres `pg_hba` TCP trust rules were dropped, the tunnel sidecar binds
  loopback only, and an `ubuntu` break-glass admin key is documented.
- CI runs a gitleaks working-tree scan.
- Caddy answers plain HTTP for the ingest host with 400 and filters its logs.
- The public uptime endpoint moved from the viewer to ingest; the portfolio
  status page reads it.
- The viewer UI was overhauled (dashboard, project status, API keys, settings,
  shared chrome, design tokens) and the dependency graph was redrawn as a real
  layered graph.

## 2026-09-20 - Azure ingest deleted

- Deleted the Azure `metrion-ingest` Container App and its role assignments
  (the app's own AcrPull on the registry and the two Contributor grants scoped
  to it). The 24 h wait was shortened at the owner's request after about 4 h
  with no request reaching Azure (last one 11:23 UTC) and no sample gap beyond
  the collector cadence. The database was always the single VPS one, so no data
  moved. Rollback notes: `organizational/azure-ingest-removal-2026-09-20.md`.
- A stale, disabled collector env file on the VPS still named the Azure URL and
  was repointed at the VPS host.

## 2026-09-20 - Ingest moved from Azure Container Apps to the VPS

- `metrion-ingest` now runs on the Contabo VPS behind Caddy at
  `https://metrion-ingest.woofi-developments.at`, deployed by CI over an SSH
  forced command with a database round-trip gate and automatic rollback; see
  `docs/adr/0008-ingest-on-the-vps.md` for the measurements and trade-offs.
- Collectors (`uptime.env`, `routing.env`) and the portfolio's
  `METRION_STATUS_URL` point at the VPS host. The public uptime endpoint moved
  from the viewer to ingest.
- Ingest connects as the least-privilege role `metrion_ingest` (migrations
  0012, 0013); the database firewall gained a subnet-scoped ACCEPT for
  `metrion_default`.
- The Azure `metrion-ingest` app received no traffic after the cutover and was
  deleted the same day (entry above).

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

## Before v0.2.0 (earlier entries, kept as written)

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
