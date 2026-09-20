-- Ingest connected as the `metrion` superuser, and 0005's `metrion_app` is
-- no better a fit: that role can SELECT `sessions`, `users` and `identities`
-- - session material an internet-facing service has no business reading. A
-- bug or compromise in ingest should reach only what ingest itself touches.
-- `metrion_ingest` gets exactly what `applications/ingest/src` queries.
--
-- No password is set here, same rule as 0005: a secret never enters a
-- committed SQL file. Set it once, out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metrion_ingest') THEN
    CREATE ROLE metrion_ingest LOGIN;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE metrion TO metrion_ingest;
GRANT USAGE ON SCHEMA public TO metrion_ingest;

-- TimescaleDB propagates a hypertable's grants to its chunks and continuous
-- aggregates, so none are listed here (metrion_app holds grants on chunks no
-- migration ever wrote).
GRANT SELECT, INSERT ON metrics TO metrion_ingest;
GRANT SELECT ON metrics_hourly TO metrion_ingest;

-- api_keys: SELECT to authenticate, and UPDATE limited to last_used_at. The
-- column-level grant is deliberate: a compromised ingest must not be able to
-- clear revoked_at or re-point a key at another project.
GRANT SELECT ON api_keys TO metrion_ingest;
GRANT UPDATE (last_used_at) ON api_keys TO metrion_ingest;

GRANT SELECT ON projects TO metrion_ingest;

-- applications: auto-registers a resource on first metrics.
GRANT SELECT, INSERT ON applications TO metrion_ingest;
