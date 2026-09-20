-- Same gap as 0009, one migration later: 0007 added thresholds/
-- threshold_status/status_events/application_dependencies after 0005 had
-- already locked metrion_app down to least privilege, so none of the four
-- ever got a grant either. GET /projects/:id/status
-- (status-service.ts#getApplicationStatuses) reads all four as metrion_app
-- and was 500ing on every call - confirmed directly against the live DB
-- (zero rows in information_schema.role_table_grants for metrion_app on
-- any of these four tables) and via the viewer's own Status page, which
-- showed "The metrics API returned 500" for every project before this.
GRANT SELECT, INSERT, UPDATE, DELETE ON thresholds TO metrion_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON threshold_status TO metrion_app;
GRANT SELECT, INSERT ON status_events TO metrion_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON application_dependencies TO metrion_app;
