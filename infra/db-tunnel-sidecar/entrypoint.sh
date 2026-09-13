#!/bin/sh
# Keeps a local-port-forward open to the VPS Postgres, so the main container
# in this Container App can reach it at 127.0.0.1:5432 - see
# organizational/deployment-runbook.md for why this exists (Container Apps
# Consumption has no stable outbound IP to allowlist on the VPS firewall,
# measured against a ~275-address shared pool, and a NAT Gateway is
# cost-ruled-out per ADR 0004). Containers in one Container App share a
# network namespace, so this sidecar's listener is reachable by the main
# container on localhost.
set -eu
mkdir -p /tmp/ssh
umask 077
printf '%s\n' "$TUNNEL_PRIVATE_KEY" > /tmp/ssh/key
chmod 600 /tmp/ssh/key
exec autossh -M 0 -N \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=/tmp/ssh/known_hosts \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -i /tmp/ssh/key \
  -L 0.0.0.0:5432:127.0.0.1:5432 \
  "metrion-tunnel@${TUNNEL_HOST}"
