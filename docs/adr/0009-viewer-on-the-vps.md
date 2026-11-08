# ADR 0009: Move `metrion-viewer` from Azure Container Apps to the VPS

Date: 2026-11-08. Status: accepted. Follows [ADR 0008](0008-ingest-on-the-vps.md).

## Context

Everything except the viewer already ran on the VPS: the database, ingest and the evaluator. The viewer was the only
thing left on Azure Container Apps, and it cost more than it was worth:

- It reached the database through an SSH-tunnel sidecar (`db-tunnel`) holding a private key as a secret, a moving part
  that existed only because the two lived in different places.
- The free-tier credit that kept Container Apps at 0 EUR ends on 2026-12-19; after that, list prices apply with no cap.
- `minReplicas: 0` made the first visit after a quiet period wait for a cold start.

## Decision

Run the viewer as a container in `/opt/metrion/docker-compose.prod.yml` on the VPS, reached by Caddy over `edge-net`
as `metrion-viewer-1:8080`, connecting to the database over the local bridge as the same `metrion_app` role. The image
still comes from the Azure Container Registry. CI deploys it with the same forced-command key as ingest
(`viewer <tag>` in `/opt/metrion/deploy.sh`: pull, restart only the viewer, prove a database round trip, roll back on
failure). Its secrets live in `/opt/metrion/viewer.env` (mode 600), copied from the Container App once.

## Consequences

- The tunnel sidecar, its key and the firewall exception for Azure's outbound addresses are no longer needed.
- The viewer shares the VPS's 8 GB with the other stacks: capped at 384 MB, measured well below that.
- The public hostname is unchanged, so the OAuth redirect addresses at GitHub, Google and Microsoft stay as they are.
  Only its DNS record changed, from a CNAME to the Container App to an A record for the VPS.
- Azure keeps the container registry and the deploy identity that pushes to it, nothing else of Metron.
