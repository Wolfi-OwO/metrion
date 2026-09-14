-- Per-project off switch for the threshold evaluator's email alerts
-- (issue #22). Colour (threshold_status/status_events) is always computed
-- and always shown regardless of this flag - only the email side checks it.
-- Defaults to true so every existing project keeps receiving alerts it
-- would already have gotten; a project owner opts out, nothing opts in.
ALTER TABLE projects ADD COLUMN alerts_enabled boolean NOT NULL DEFAULT true;
