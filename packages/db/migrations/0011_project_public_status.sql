-- Per-project opt-in for publishing uptime/status data to anonymous callers
-- (portfolio status page reading Metrion as a second source). Defaults to
-- false, the inverse of alerts_enabled's default (0008): alerts_enabled
-- defaults true because it only gates an existing internal notification
-- nobody should silently lose, while this flag exposes a project's data to
-- callers with no account at all - the safe default is that a project opts
-- in, not that every project is public until someone opts out.
ALTER TABLE projects ADD COLUMN public_status_enabled boolean NOT NULL DEFAULT false;

-- No grant change: 0005_least_privilege_app_role.sql's
-- `GRANT SELECT, INSERT ON projects TO metrion_app;` is table-level, not
-- per-column, so it already covers this new column for SELECT/INSERT. It
-- does not grant UPDATE on projects at all (same as alerts_enabled in
-- 0008, which also has no UPDATE grant) - toggling this flag from the
-- viewer is out of this migration's scope and will need its own UPDATE
-- grant when that handler is built.
