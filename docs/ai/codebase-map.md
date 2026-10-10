---
summary: Entry points, module boundaries and how data flows.
updated: 2026-10-10
---

# Codebase map

## Entry points

- `applications/agent/`: per-host collector that emits metric envelopes.
- `applications/ingest/`: authenticated ingest and the public uptime endpoint.
- `applications/evaluator/src/main.ts`: one-minute evaluation tick (thresholds to status and alert emails).
- `applications/viewer/src/main.ts` and `applications/viewer/client/`: Express API and React UI.

## Modules

- `packages/db/`: pool, forward-only migrations (`migrations/NNNN_*.sql`), no app logic.
- `packages/shared/`: the metric envelope wire format.

## Flows

- Metrics: agent -> ingest -> `metrics` hypertable (+ `metrics_hourly` rollup) -> viewer `metrics-service.ts` -> metrics page.
- Alerts: `thresholds` + `metrics` -> evaluator `evaluate.ts` -> `threshold_status`/`status_events` -> `mailer.ts` digests; viewer `status-service.ts` reads the same tables.

## Unknowns

- Server layout and deploy steps live in the private organizational/ runbooks, deliberately not here.
