-- Per-application opt-in for the public uptime endpoints (security review
-- finding 2, 2026-09-21).
--
-- `registerResources` (applications/ingest/src/handlers/ingest.handlers.ts)
-- auto-creates an `applications` row for any resource name an API key sends,
-- no display name, no review. Both public endpoints
-- (`services/public-status-service.ts`, `services/public-uptime-range-
-- service.ts`) have, since 0014, listed every application with an
-- `uptime.ok` sample - so a leaked or misused project key could make up a
-- fake public "service", or fake downtime on a real application's own key,
-- permanently and with no review step. Defaults false, same reasoning
-- 0011_project_public_status.sql already gave the project-level flag: this
-- exposes data to callers with no account at all, so a project/application
-- opts in, nothing is public by default.
ALTER TABLE applications ADD COLUMN public_status_visible boolean NOT NULL DEFAULT false;

-- No new grant needed. 0009's `GRANT SELECT, INSERT, UPDATE, DELETE ON
-- applications TO metrion_app` and 0012's `GRANT SELECT, INSERT ON
-- applications TO metrion_ingest` are table-level grants, which Postgres
-- applies to every column of the table, present and future, unless a
-- column-level grant narrows it - neither does. Confirmed live against
-- production: `SELECT grantee, privilege_type FROM
-- information_schema.table_privileges WHERE table_name = 'applications'`
-- lists both roles with no matching row in
-- `information_schema.column_privileges` at all, which is exactly what a
-- table-level (not column-restricted) grant looks like.

-- Opt in the seven real monitors of project
-- 86b02c8c-4357-4655-9835-1897787cdd9a (Applications Server 01) - the ones
-- organizational/uptime-sources.md names as actually having a writer.
-- Verified live before writing this: `SELECT key FROM applications WHERE
-- project_id = '86b02c8c-4357-4655-9835-1897787cdd9a'` returned these seven
-- plus `fuwwy-platform` (zero uptime.ok samples, per uptime-sources.md) and
-- `vmi3556446` (a host-level resource key, not an uptime monitor) - neither
-- of those two is opted in here.
UPDATE applications
   SET public_status_visible = true
 WHERE project_id = '86b02c8c-4357-4655-9835-1897787cdd9a'
   AND key IN (
     'netviz', 'ml-visualizer', 'ml-visualizer-preview', 'portfolio',
     'status-page', 'preussen', 'nutrilens'
   );
