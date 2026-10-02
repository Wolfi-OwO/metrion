-- projects.hidden: keep a project out of the owner's dashboard lists.
--
-- The deploy gate (organizational/metrion-deploy/deploy.sh, INGEST_POST 202)
-- posts to the `deploy-probe` project on every deploy, so it cannot be
-- deleted - it only cluttered the dashboard next to the real project.
-- Ingest authenticates by API key and never reads this column, so hiding
-- leaves the gate untouched. Viewer list queries filter `hidden = false`;
-- lookups by id (direct URL) are unaffected.
ALTER TABLE projects ADD COLUMN hidden boolean NOT NULL DEFAULT false;

UPDATE projects SET hidden = true WHERE slug = 'deploy-probe';
