<!-- project-memory:start -->

## Project memory

- Purpose: Metrion is a self-hosted metrics, uptime and threshold-alerting platform: an agent and ingest service collect metrics into Postgres/TimescaleDB, an evaluator turns thresholds into status and alert emails, and a viewer (Express API + React client) shows them.
- Critical commands: `npm run build`, `npm test` (DB-backed tests need a migrated TimescaleDB at DATABASE_URL), `npm run lint`, `npx prettier --check .` (CI fails on it).
- Conventions: Migrations are forward-only `.sql` files in packages/db/migrations. CI deploys only the viewer and ingest; the evaluator is copied to the server by hand (see organizational/agent-deployment-runbook.md, private). Releases bump 7 package.json files plus package-lock.json and CHANGELOG.md, then an annotated tag and a GitHub release.
- Knowledge tree: docs/ai/ (index.md routes to architecture, features, decisions, tasks, sessions).
- Protocol: record decisions as short ADRs in docs/ai/decisions/, task state in docs/ai/tasks/active.md, and write a handoff to docs/ai/sessions/latest.md before stopping. Link instead of duplicating.
- Read docs/ai/index.md and docs/ai/sessions/latest.md, then continue the current task.

<!-- project-memory:end -->
