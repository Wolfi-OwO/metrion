---
summary: How blue/green and pod replicas appear in the evaluator and the metrics page.
updated: 2026-10-10
---

# Service grouping

- Evaluator: `applications/evaluator/src/evaluate.ts` `aggregateWindow` averages each container, then the containers of one `service_group`. Status rows are keyed by the group.
- API: `applications/viewer/src/services/metrics-service.ts`. `getResources` returns `subResources` (one per group) plus `instances` (group to containers). `getSeries` averages per bucket, or returns one series per container with `perInstance`.
- UI: `applications/viewer/client/src/components/resource-picker.tsx` ("Show all N pods"), `routes/project-metrics.tsx` names per-pod lines `metric · container`.
- Tests: `applications/evaluator/tests/blue-green.test.ts`, `applications/viewer/tests/service-group.test.ts`.
- Decision: [0001](../decisions/0001-service-group.md).
