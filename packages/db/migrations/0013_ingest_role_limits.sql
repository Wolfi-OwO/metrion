-- Tightens the connection surface after 0012 split ingest onto its own role.
--
-- * CONNECTION LIMIT 20 on `metrion_ingest`: ingest is internet-facing and its
--   pool is small, so a bug or flood that opens connections without bound
--   should exhaust this role's slots, not the server's (and with them the
--   viewer's and the migration runner's).
-- * CONNECT and TEMP on the database are revoked from PUBLIC. PostgreSQL grants
--   both to PUBLIC by default, so any role created later - by mistake or by an
--   intruder - could connect and create temp tables. The only login roles are
--   `metrion` (superuser, unaffected), `metrion_app` and `metrion_ingest`, both
--   holding an explicit CONNECT (0005, 0012). Nothing relies on TEMP.
--
-- The database name is looked up, not hard-coded: dev and CI use `metrion`
-- today, but this must not break on a differently named database. The DO block
-- also keeps the file runnable inside the single transaction migrate.ts wraps
-- each file in, and re-runnable.
ALTER ROLE metrion_ingest CONNECTION LIMIT 20;

DO $$
BEGIN
  EXECUTE format('REVOKE CONNECT, TEMP ON DATABASE %I FROM PUBLIC', current_database());
END
$$;
