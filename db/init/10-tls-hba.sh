#!/bin/bash
# Runs once, as the docker-library postgres image's own
# docker-entrypoint-initdb.d hook - only on a first init against an empty
# data directory, never again after that (see docker-compose.prod.yml's
# comment on this file). Makes the entrypoint's auto-generated pg_hba.conf
# TLS-only: drops the plain "host ... scram-sha-256" rule it writes by
# default and replaces it with "hostssl", so a client that does not
# negotiate TLS is rejected before authentication is even attempted - "ssl =
# on" alone would still accept a plaintext connection if pg_hba.conf allowed
# one.
set -euo pipefail

HBA="$PGDATA/pg_hba.conf"
# Drops every TCP trust rule the image entrypoint writes, not just the
# all-address one. pg_hba is first-match, and the image also emits
# 127.0.0.1/32 and ::1/128 trust lines; leaving them meant passwordless
# superuser for anything sharing the container's network namespace (measured
# 2026-09-20). `local all all trust` is deliberately kept: init hooks and
# pg_isready use the unix socket, which never leaves the container. This hook
# only runs on an empty data dir; a running database needs the live file fixed
# by hand (runbook).
sed -i -E '/^host[[:space:]]+(all|replication)[[:space:]]+all[[:space:]]+(127\.0\.0\.1\/32|::1\/128|all)[[:space:]]/d' "$HBA"
echo 'hostssl all all all scram-sha-256' >> "$HBA"
