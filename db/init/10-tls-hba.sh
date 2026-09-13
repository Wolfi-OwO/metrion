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
sed -i '/^host[[:space:]]\+all[[:space:]]\+all[[:space:]]\+all[[:space:]]\+/d' "$HBA"
echo 'hostssl all all all scram-sha-256' >> "$HBA"
