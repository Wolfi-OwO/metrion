---
summary: Blue/green colours and pod replicas are one service, grouped by the SQL function service_group(); the value is the mean of running pods.
updated: 2026-10-10
status: accepted
---

# 0001 Group blue/green colours and pods into one service

## Context

A blue/green app has one live container at a time; the idle colour stops reporting by design. The evaluator keyed status per `sub_resource`, so the idle colour's row went critical/no_data and never cleared, and an application card showed Critical with "no data" for a day. The viewer also listed blue and green as two dashboards.

## Decision

`service_group(sub)` (migration 0023) strips `-blue|-green` and a trailing `-N` from `container:` names only. The evaluator and the viewer both group by it. A service's value is the mean of its pods' own means (never a sum); a silent pod is simply absent, so no_data needs every pod silent. The metrics API takes `perInstance=true` for one series per pod and the picker has a "Show all N pods" toggle.

## Alternatives rejected

- Suppress no_data for blue/green names in the evaluator: hides a real outage when both colours stop.
- Group in application code only: evaluator and viewer could drift on what a service is; one SQL function is the single owner.

## Consequences

Per-colour thresholds were merged into one per group. After the migration the OLD evaluator recreates per-colour status rows, so deploy the new evaluator and then delete rows where `sub_resource_key <> service_group(sub_resource_key)`. `requests:<host>` names are untouched because they can legally end in digits.
