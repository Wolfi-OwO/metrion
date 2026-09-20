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
# Pinned, not TOFU'd: /tmp/ssh/known_hosts is created empty on every
# container start, so the previous `accept-new` trusted whatever key the
# server presented on every single boot - no pinning ever actually
# happened. Baked in literally instead, captured once via
# `ssh-keyscan -t ed25519 <VPS-IP>` (same fingerprint deploy.yml now
# pins for its own SSH step), and StrictHostKeyChecking=yes so a changed
# key hard-fails the tunnel instead of silently re-trusting it.
printf '%s\n' "${TUNNEL_HOST} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIL0EZSmAYeYlrrvypv8MGUoUHVyFlDnWFf6rDKQkdD2C" > /tmp/ssh/known_hosts
# The forward binds loopback, not 0.0.0.0: the app shares this network
# namespace, so nothing else needs it. Takes effect at the next sidecar image
# build (the published 0.1.0 image still binds 0.0.0.0).
exec autossh -M 0 -N \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile=/tmp/ssh/known_hosts \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -i /tmp/ssh/key \
  -L 127.0.0.1:5432:127.0.0.1:5432 \
  "metrion-tunnel@${TUNNEL_HOST}"
