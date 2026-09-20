# ADR 0008: Move `metrion-ingest` from Azure Container Apps to the VPS

## Status

Accepted, 2026-09-20. Azure ingest deletion pending, TODO(2026-09-21): after
the 24 h clean window (earliest 2026-09-21 ~13:20 CEST) delete the Azure
`metrion-ingest` container app, then change this status to "Accepted,
2026-09-20; Azure ingest deleted 2026-09-21" and fill the cost figure below.
Until then the Azure app still exists and keeps running its old revision;
nothing sends it traffic since the cutover. Partly supersedes ADR 0006 (the
public status endpoint moved from the viewer to ingest).

## Context

The Azure `metrion-ingest` container app ran at `minReplicas: 1`, always
active. The reason is the senders: the VPS collectors `POST` container
metrics every 60 s and uptime checks every 5 min, and the portfolio polls the
public status endpoint, so the app never idled long enough to scale to zero.
Measured Azure billing (2026-09-20, via the cost planner): steady state about
EUR 0.4451/day for the whole resource group, of which the Azure ingest was
about EUR 1.596 month-to-date, against about EUR 0.037 for the viewer, which
does scale to zero.

The database already lives on the same Contabo VPS (ADR 0004), so the Azure
ingest could never write while the VPS was down anyway - it only added a
cross-provider hop and a bill.

Measured VPS headroom before the move (2026-09-20): 6.2 GB RAM free, 79 GB
disk free, load about 2.28.

## Decision

Run ingest as the `ingest` service of `/opt/metrion/docker-compose.prod.yml`
on the VPS, next to `db`.

- `mem_limit: 256m`, no published ports; Caddy terminates TLS and proxies
  `https://metrion-ingest.woofi-developments.at` to it over `edge-net`. The
  site block overrides the security headers with `>`-prefixed directives,
  answers plain HTTP with a 400 (`http://` block, proven safe offline against
  Pebble in `organizational/metrion-caddy-acme-proof`), and the global
  logger is filtered so no client IPs or paths are logged.
- Deployed by CI over an SSH forced command (`/opt/metrion/deploy.sh`; the
  repo copy is `organizational/metrion-deploy/deploy.sh`). The script gates
  on a database round trip - markers `DB_OK 1`, `PRIVS_OK`, `INGEST_POST 202`,
  `UPTIME 200` - and rolls back automatically if any is missing. Images are
  tagged immutably as `<version>-<run_number>`.
- Ingest connects as the least-privilege role `metrion_ingest` (migrations
  0012 and 0013), never as `metrion` or `metrion_app`.
- Database firewall: a `DOCKER-USER` DROP on 5432 plus a subnet-scoped ACCEPT
  for `metrion_default` (`172.23.0.0/16`, pinned in the compose file).
  `br_netfilter` is not loaded on the VPS (measured), so the DROP never saw
  bridge traffic; the ACCEPT makes that not depend on the module staying
  unloaded (commit 55e3570).
- The public uptime endpoint moved from the viewer to ingest (commit
  cfe37c3). The viewer stays on Azure at `minReplicas: 0` and reaches the
  database through its SSH tunnel sidecar.
- Cutover, 2026-09-20 ~13:20 CEST: `uptime.env`, `routing.env` and the
  portfolio's `METRION_STATUS_URL` now point at the VPS host.

### Rejected: keep ingest on Azure with scale-to-zero

The collectors would keep it awake anyway, so the saving would not
materialise, and every cold start would drop or delay a 60 s sample.

## Consequences

- The VPS is now a single host for database and ingest: a VPS outage takes
  both. That is no regression for writes - the Azure ingest could not write
  without the VPS database either - but the read-only status path no longer
  has a separate failure domain.
- Database and ingest share one Docker bridge (`metrion_default`); the
  scoped firewall rule and the `metrion_ingest` role are what keep that
  acceptable.
- Ingest health is only meaningful with the deploy gate: its liveness
  endpoint touches no database, so a broken DB path would otherwise stay
  green.
- Cost after deletion: TODO(2026-09-21) fill from Azure Cost Management, not
  from an estimate. Run `az consumption usage list --start-date 2026-09-21
--end-date 2026-09-22` or open cost analysis for resource group `metrion-rg`
  and record the daily total next to the EUR 0.4451/day baseline above.
- After the deletion window the previous Azure-hosted ingest path is gone;
  rollback then means redeploying an earlier immutable tag on the VPS, not
  switching a hostname back. Runbook: `organizational/agent-deployment-runbook.md`
  ("Metrion ingest on the VPS").
