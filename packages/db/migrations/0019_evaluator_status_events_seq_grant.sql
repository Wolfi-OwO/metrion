-- status_events.id is `bigserial` (0007), which is a plain int8 column with
-- a DEFAULT nextval('status_events_id_seq') - granting INSERT on the table
-- (0010, then 0018's UPDATE/DELETE) never implicitly grants USAGE on that
-- sequence; Postgres treats them as separate grantable objects. Confirmed
-- live on Task 9's first real evaluator cycle to actually commit a
-- transition: `permission denied for sequence status_events_id_seq`
-- (SQLSTATE 42501) from `nextval_internal`, on the INSERT inside
-- evaluate.ts's upsertStatus. 0018's grant alone was not enough.
GRANT USAGE, SELECT ON SEQUENCE status_events_id_seq TO metrion_app;
