-- Applications registry, and the dependency graph between them.
--
-- Vocabulary: a project is the tenant/workspace and stays the only tenancy
-- boundary. An application is what the existing schema calls `resource` -
-- applications.key IS the value written to metrics.resource. This is a
-- registry for a string the schema already has, not a new axis on the
-- metric. sub_resource keeps its current meaning (a container name under
-- resource = docker) and is not reused as a topology node; the existing
-- SELECT DISTINCT resource, sub_resource, name discovery query keeps
-- working unchanged.

CREATE TABLE applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key           text NOT NULL,              -- == metrics.resource
  display_name  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key),
  UNIQUE (id, project_id)                   -- target for composite FKs below
);

-- A DAG edge table, not a parent_id tree - a real topology has multiple
-- parents ("checkout-api depends on payments-service AND
-- postgres-primary" is not expressible with one parent column). Cycle
-- prevention is not a database trigger: it is one recursive-CTE check in
-- the write handler (a later task), so there is one owner for the rule.
--
-- The composite foreign keys below are the load-bearing detail: they make
-- a dependency edge between two different tenants' applications impossible
-- at the database level, rather than dependent on a handler remembering to
-- check. A plain single-column FK to applications(id) would permit that.
CREATE TABLE application_dependencies (
  project_id    uuid NOT NULL,
  dependent_id  uuid NOT NULL,
  depends_on_id uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dependent_id, depends_on_id),
  CHECK (dependent_id <> depends_on_id),
  FOREIGN KEY (dependent_id,  project_id) REFERENCES applications (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (depends_on_id, project_id) REFERENCES applications (id, project_id) ON DELETE CASCADE
);
CREATE INDEX ON application_dependencies (depends_on_id);

-- Same cross-tenant guarantee for API keys: a key can only be bound to an
-- application in its own project.
ALTER TABLE api_keys ADD COLUMN application_id uuid NULL;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_application_fk
  FOREIGN KEY (application_id, project_id) REFERENCES applications (id, project_id) ON DELETE SET NULL;
