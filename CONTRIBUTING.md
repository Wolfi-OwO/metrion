# Contributing

Single-maintainer project (metrion); this document exists mainly so the rules
are written down once instead of re-derived per change.

## Contributions

Contributions are accepted only if you grant the maintainer a perpetual, irrevocable licence to use and relicense them.

## Setup

```bash
npm install
```

## Workflow

```bash
npm run typecheck   # tsc -b, project references across packages/shared + applications/agent
npm run lint         # eslint
npm run format:check # prettier
npm --workspace applications/agent test  # builds, then runs the node:test self-check
```

## Deploying the collector

There is no CI/CD pipeline for this yet - the collector is deployed by hand:
build (`npm run build`), copy `applications/agent/dist/` to
`/opt/vps-metrics-collector/dist` on the VPS, restart nothing (it's a
systemd-timer one-shot, next tick picks up the new code). See the delivery
report for the exact systemd units and directory layout.

The server-side paths and unit names still say `vps-metrics` even though
the repo is now metrion - `organizational/agent-deployment-runbook.md` records why
under "Why the server still says vps-metrics".
