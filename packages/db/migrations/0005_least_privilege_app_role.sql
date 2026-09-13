-- `metrion` is a superuser (Superuser, Create role, Create DB, Replication,
-- Bypass RLS) and both applications connected as it for ordinary CRUD - a
-- bug in either one had the same blast radius as a compromised admin
-- session. `metrion_app` is the least-privilege role the ingest and viewer
-- services actually run as from here on; `metrion` stays reserved for the
-- migration runner (organizational/agent-deployment-runbook.md's SSH-only
-- migrate step) - same "one owner per job" reasoning as everywhere else in
-- this project, applied to database roles.
--
-- No password is set here: a secret has no business in a committed SQL
-- file. It's set once, out of band, the same way POSTGRES_PASSWORD already
-- is (see docker-compose.prod.yml's own comment on that).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrion_app') THEN
    CREATE ROLE metrion_app LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE metrion TO metrion_app;
GRANT USAGE ON SCHEMA public TO metrion_app;

-- metrics: ingest only ever INSERTs, the viewer only ever SELECTs, but the
-- role is shared by both services, so it carries both. TimescaleDB
-- propagates a hypertable's own grants to its chunks (present and future),
-- so nothing extra is needed for the per-chunk child tables.
GRANT SELECT, INSERT ON metrics TO metrion_app;
GRANT SELECT ON metrics_hourly TO metrion_app;

-- api_keys: ingest's requireApiKey middleware SELECTs to authenticate and
-- UPDATEs last_used_at; the viewer's projects handlers INSERT new keys,
-- SELECT to list them, and UPDATE revoked_at to revoke one. No DELETE -
-- revocation is a column flip, not a row removal.
GRANT SELECT, INSERT, UPDATE ON api_keys TO metrion_app;

-- projects: read by both for tenancy/default_resource lookups, created by
-- the viewer.
GRANT SELECT, INSERT ON projects TO metrion_app;

-- users, identities, sessions: the viewer's own OAuth/session flow only -
-- ingest never touches these.
GRANT SELECT, INSERT, UPDATE ON users TO metrion_app;
GRANT SELECT, INSERT, UPDATE ON identities TO metrion_app;
GRANT SELECT, INSERT, DELETE ON sessions TO metrion_app;
