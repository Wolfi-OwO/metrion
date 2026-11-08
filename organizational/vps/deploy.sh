#!/usr/bin/env bash
set -euo pipefail

# Invoked as an SSH forced command (see authorized_keys) - mirrors the
# pattern in /opt/portfolio/deploy.sh and /opt/nutrilens/deploy.sh: the CI
# key can only ever run this one script, never an arbitrary command, even
# though the `deploy` account itself has passwordless sudo. Before this
# script existed, `github-actions-metrion-deploy` was a plain interactive
# shell key with no `command=`/`restrict` in authorized_keys - a straight
# path to root on a box hosting six production stacks, since `deploy` has
# passwordless sudo. This restricts it to exactly what the migrate step in
# .github/workflows/deploy.yml used to run inline over that open shell.
#
# Reads the migration tarball off stdin instead of a separate scp/sftp step.
# Measured directly (`scp -vvv` from this box's own client against this
# host): modern OpenSSH `scp` negotiates the SFTP protocol by default
# ("Executing: ... command sftp"), not the legacy `scp -t <path>` protocol -
# a forced command can't cleanly special-case that subsystem request without
# exec'ing a real sftp-server, which would hand the key filesystem access
# far broader than "write one tarball to /tmp". Piping the tarball over this
# same forced-command session's stdin needs no exception at all: `command=`
# still swaps in this script, but stdin/stdout stay wired to the normal SSH
# channel underneath it.
# Two jobs share this one forced command, told apart by what the client asked
# for (SSH_ORIGINAL_COMMAND, which sshd sets even under command=):
#   (empty)        -> the migrate step: tarball on stdin, run migrations (below)
#   ingest <tag>   -> ship a new metrion-ingest image (deploy_ingest)
#   viewer <tag>   -> ship a new metrion-viewer image (deploy_viewer)
# Anything else is refused rather than falling through to the migrate path,
# where a typo'd command with empty stdin would wipe /opt/metrion/migrate.
cd /opt/metrion

deploy_ingest() {
  local tag=$1 prev image=globalcr01.azurecr.io/metrion-ingest
  local compose=(docker compose -f /opt/metrion/docker-compose.prod.yml)
  # One ingest deploy at a time; a second push must not interleave .env edits.
  exec 9>/opt/metrion/.ingest-deploy.lock
  flock -n 9 || { echo "another ingest deploy is running" >&2; exit 1; }

  prev=$(sed -n 's/^INGEST_IMAGE_TAG=//p' .env)
  echo "ingest: $prev -> $tag"

  # Pull credentials: the deploy user's ~/.docker/config.json holds the ACR
  # login. Pulling first means a missing tag fails before .env or the running
  # container is touched.
  docker pull "$image:$tag"

  set_tag() {
    # Rewrite in place (cat >, not sed -i / mv) so .env keeps its inode and 0600.
    sed "s/^INGEST_IMAGE_TAG=.*/INGEST_IMAGE_TAG=$1/" .env > .env.new
    cat .env.new > .env && rm -f .env.new
  }

  # Liveness alone proves nothing about the DSN, so after "healthy" run a real
  # round trip with the container's own DATABASE_URL. It catches the lost `db`
  # alias (EAI_AGAIN) that a network recreate leaves behind. Three more checks
  # follow, each printing a marker and failing the gate.
  gate() {
    local i state
    for i in $(seq 1 30); do
      state=$(docker inspect -f '{{.State.Health.Status}}' metrion-ingest-1 2>/dev/null || echo missing)
      [ "$state" = healthy ] && break
      sleep 3
    done
    [ "$state" = healthy ] || { echo "gate: health is '$state'" >&2; return 1; }
    docker exec metrion-ingest-1 node -e '
      const { Client } = require("pg");
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      c.connect().then(() => c.query("select 1 as ok")).then(r => { console.log("DB_OK", r.rows[0].ok); return c.end(); })
        .catch(e => { console.error(e.message); process.exit(1); });' || return 1

    # 1. Privileges. The POST below cannot see a missing last_used_at UPDATE
    # grant: middlewares/api-key.ts swallows that failure with .catch(() => {})
    # and still answers 202. So the grants ingest needs are asserted directly,
    # as whatever role DATABASE_URL names. The chunk walk covers every
    # `_hyper_*_chunk` relation (raw metrics, uptime_samples and the continuous aggregate's):
    # SELECT on all, INSERT on the metrics ones. It reads pg_class/pg_inherits
    # only, which any role can. Compression's internal `compress_hyper_*`
    # relations are deliberately not asserted.
    docker exec metrion-ingest-1 node -e '
      const { Client } = require("pg");
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      c.connect().then(() => c.query(`select
          has_table_privilege(current_user, $$metrics$$, $$INSERT$$)
          and has_column_privilege(current_user, $$api_keys$$, $$last_used_at$$, $$UPDATE$$)
          and has_table_privilege(current_user, $$uptime_samples$$, $$INSERT$$)
          and has_table_privilege(current_user, $$applications$$, $$INSERT$$)
          and has_table_privilege(current_user, $$metrics_hourly$$, $$SELECT$$)
          and (select coalesce(bool_and(has_table_privilege(current_user, c.oid, $$SELECT$$)
                     and (i.inhparent is null or has_table_privilege(current_user, c.oid, $$INSERT$$))), true)
                 from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace and n.nspname = $$_timescaledb_internal$$
                 left join pg_inherits i on i.inhrelid = c.oid and i.inhparent in ($$public.metrics$$::regclass, $$public.uptime_samples$$::regclass)
                where c.relkind = $$r$$ and left(c.relname, 7) = $$_hyper_$$ and right(c.relname, 6) = $$_chunk$$) as ok`))
        .then(r => { if (!r.rows[0].ok) throw new Error("PRIVS_MISSING"); console.log("PRIVS_OK"); return c.end(); })
        .catch(e => { console.error(e.message); process.exit(1); });' || return 1

    # 2. A real authenticated ingest POST against a dedicated probe project
    # (slug deploy-probe, public_status_enabled false): one sample of
    # `deploy.probe` per deploy. The key lives only in /opt/metrion/.env; it
    # reaches the container through the environment, never through argv.
    local key
    key=$(sed -n 's/^DEPLOY_PROBE_API_KEY=//p' /opt/metrion/.env)
    [ -n "$key" ] || { echo "gate: DEPLOY_PROBE_API_KEY missing from .env" >&2; return 1; }
    DEPLOY_PROBE_API_KEY="$key" docker exec -e DEPLOY_PROBE_API_KEY metrion-ingest-1 node -e '
      fetch("http://127.0.0.1:8090/api/v1/ingest", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + process.env.DEPLOY_PROBE_API_KEY },
        body: JSON.stringify({ resource: "deploy-probe", metrics: [{ name: "deploy.probe", value: 1, unit: "count", intervalSeconds: 86400, timestamp: new Date().toISOString() }] }),
      }).then(r => { console.log("INGEST_POST", r.status); if (r.status !== 202) process.exit(1); })
        .catch(e => { console.error(e.message); process.exit(1); });' || return 1

    # 3. The public, unauthenticated read the portfolio's status page uses.
    docker exec metrion-ingest-1 node -e '
      fetch("http://127.0.0.1:8090/api/v1/public/projects/86b02c8c-4357-4655-9835-1897787cdd9a/uptime")
        .then(r => { console.log("UPTIME", r.status); if (r.status !== 200) process.exit(1); })
        .catch(e => { console.error(e.message); process.exit(1); });' || return 1
  }

  # --no-deps: the db container must never be recreated by an ingest deploy.
  set_tag "$tag"
  "${compose[@]}" up -d --no-deps ingest
  if gate; then
    echo "ingest $tag is live"
    return 0
  fi
  echo "ingest $tag failed the gate, rolling back to $prev" >&2
  set_tag "$prev"
  "${compose[@]}" up -d --no-deps ingest
  gate || echo "rollback to $prev is also unhealthy" >&2
  return 1
}

deploy_viewer() {
  local tag=$1 prev image=globalcr01.azurecr.io/metrion-viewer
  local compose=(docker compose -f /opt/metrion/docker-compose.prod.yml)
  exec 8>/opt/metrion/.viewer-deploy.lock
  flock -n 8 || { echo "another viewer deploy is running" >&2; exit 1; }

  prev=$(sed -n 's/^VIEWER_IMAGE_TAG=//p' .env)
  echo "viewer: $prev -> $tag"
  # Pull first: a missing tag fails before .env or the running container is touched.
  docker pull "$image:$tag"

  set_tag() {
    sed "s/^VIEWER_IMAGE_TAG=.*/VIEWER_IMAGE_TAG=$1/" .env > .env.new
    cat .env.new > .env && rm -f .env.new
  }

  # Healthy is not enough: the viewer's own DATABASE_URL (role metrion_app) must work, and the pages' first
  # question, the list of projects, must be answerable.
  gate() {
    local i state
    for i in $(seq 1 30); do
      state=$(docker inspect -f '{{.State.Health.Status}}' metrion-viewer-1 2>/dev/null || echo missing)
      [ "$state" = healthy ] && break
      sleep 3
    done
    [ "$state" = healthy ] || { echo "gate: health is '$state'" >&2; return 1; }
    docker exec metrion-viewer-1 node -e '
      const { Client } = require("pg");
      const c = new Client({ connectionString: process.env.DATABASE_URL });
      c.connect().then(() => c.query("select count(*)::int as n from projects")).then(r => { console.log("DB_OK projects", r.rows[0].n); return c.end(); })
        .catch(e => { console.error(e.message); process.exit(1); });' || return 1
    docker exec metrion-viewer-1 node -e '
      fetch("http://127.0.0.1:8080/api/v1/health/liveness")
        .then(r => { console.log("LIVENESS", r.status); if (r.status !== 200) process.exit(1); })
        .catch(e => { console.error(e.message); process.exit(1); });' || return 1
  }

  # --no-deps: neither the database nor ingest is touched by a viewer deploy.
  set_tag "$tag"
  "${compose[@]}" up -d --no-deps viewer
  if gate; then
    echo "viewer $tag is live"
    return 0
  fi
  echo "viewer $tag failed the gate, rolling back to $prev" >&2
  set_tag "$prev"
  "${compose[@]}" up -d --no-deps viewer
  gate || echo "rollback to $prev is also unhealthy" >&2
  return 1
}

if [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^ingest\ ([A-Za-z0-9._-]+)$ ]]; then
  deploy_ingest "${BASH_REMATCH[1]}"
  exit $?
elif [[ "${SSH_ORIGINAL_COMMAND:-}" =~ ^viewer\ ([A-Za-z0-9._-]+)$ ]]; then
  deploy_viewer "${BASH_REMATCH[1]}"
  exit $?
elif [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
  echo "unsupported command" >&2
  exit 2
fi

rm -rf /opt/metrion/migrate/* && mkdir -p /opt/metrion/migrate
tar xz -C /opt/metrion/migrate
cd /opt/metrion/migrate
npm install pg@8.23.0 --omit=dev --no-save --no-audit --no-fund
# The password never leaves the VPS - read straight out of the same .env
# docker compose already uses, never passed in over SSH.
source /opt/metrion/.env
DATABASE_URL="postgres://metrion:${POSTGRES_PASSWORD}@127.0.0.1:5432/metrion?sslmode=require&uselibpqcompat=true" \
  node dist/migrate.js
