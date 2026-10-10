---
summary: Blue/green grouping fix shipped in v0.5.1 and verified in production; v0.5.2 followed with docs; GitHub releases created for v0.3.0 to v0.5.2.
updated: 2026-10-10
---

# Session handoff

## Goal

Fix an application card stuck on Critical / "no data", and stop blue and green showing as two dashboards.

## State

Done: migration 0023, evaluator and viewer changes, tests, v0.5.1 and v0.5.2 tagged and deployed, evaluator hand-deployed with a backup, stale status rows deleted, 0 of 29 thresholds non-ok, GitHub release pages created for v0.3.0 to v0.5.2, docs/ai bootstrapped.
Blocked: the pod toggle was never checked in a browser.

## Next step

Open the metrics page for the affected application and confirm one service entry and the pods checkbox.

## Open questions

Should CI deploy the evaluator? The old "Before v0.2.0" CHANGELOG block was kept as written, only renamed.
