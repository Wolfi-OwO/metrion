import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { getPool } from '../lib/db.js';
import { BadRequestError, ConflictError, NotFoundError } from '../middlewares/error.js';
import { scopeProjectIds } from '../middlewares/project-scope.js';
import type {
  CreateApplicationBody,
  ReplaceDependenciesBody,
  StatusEventsQuery,
  UpdateApplicationBody,
} from '../schemas/applications.schemas.js';
import { getApplicationStatuses, getStatusEvents } from '../services/status-service.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

/**
 * List/create/update/delete are all straight ownership-scoped CRUD on
 * `applications`, following the same "404, never 403" rule
 * `handlers/projects.handlers.ts` and `handlers/metrics.handlers.ts` already
 * apply - `scopeProjectIds`/`req.projectIds` throw or filter before any row
 * from another tenant's project is ever visible.
 */

export async function listApplications(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  const projectIds = scopeProjectIds(req, projectId);
  const statuses = await getApplicationStatuses(projectIds);
  res.status(200).json({
    applications: statuses.map((app) => ({
      id: app.id,
      key: app.key,
      displayName: app.displayName,
      status: app.status,
    })),
  });
}

export async function createApplication(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  scopeProjectIds(req, projectId);
  const body = req.body as CreateApplicationBody;

  try {
    const { rows } = await getPool().query<{ id: string; created_at: Date }>(
      `INSERT INTO applications (project_id, key, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, created_at`,
      [projectId, body.key, body.displayName],
    );
    const row = rows[0]!;
    res.status(201).json({
      id: row.id,
      key: body.key,
      displayName: body.displayName,
      createdAt: row.created_at,
    });
  } catch (err) {
    if (pgErrorCode(err) === UNIQUE_VIOLATION) {
      throw new ConflictError(`An application with key "${body.key}" already exists in this project.`);
    }
    throw err;
  }
}

export async function updateApplication(req: Request, res: Response): Promise<void> {
  const applicationId = req.params.id!;
  const body = req.body as UpdateApplicationBody;
  const projectIds = req.projectIds ?? [];

  const { rows } = await getPool().query<{
    id: string;
    key: string;
    display_name: string | null;
    created_at: Date;
  }>(
    `UPDATE applications
        SET display_name = $1
      WHERE id = $2 AND project_id = ANY($3)
      RETURNING id, key, display_name, created_at`,
    [body.displayName, applicationId, projectIds],
  );
  if (rows.length === 0) throw new NotFoundError('Application not found.');

  const row = rows[0]!;
  res.status(200).json({
    id: row.id,
    key: row.key,
    displayName: row.display_name,
    createdAt: row.created_at,
  });
}

/** Cascades edges/thresholds/status via the `ON DELETE CASCADE` foreign keys
 * `packages/db/migrations/0006`/`0007` already declare - nothing here has to
 * delete them one table at a time. Historical `metrics` rows under this
 * application's `key` are untouched (there is no foreign key from `metrics`
 * to `applications` at all), which is why the response says so explicitly. */
export async function deleteApplication(req: Request, res: Response): Promise<void> {
  const applicationId = req.params.id!;
  const projectIds = req.projectIds ?? [];

  const { rows } = await getPool().query<{ id: string }>(
    'DELETE FROM applications WHERE id = $1 AND project_id = ANY($2) RETURNING id',
    [applicationId, projectIds],
  );
  if (rows.length === 0) throw new NotFoundError('Application not found.');

  res.status(200).json({
    id: applicationId,
    deleted: true,
    message:
      'The application, its dependency edges, thresholds and status were removed. ' +
      'Historical metrics rows recorded under this application are not deleted.',
  });
}

export async function getDependencies(req: Request, res: Response): Promise<void> {
  const applicationId = req.params.id!;
  const projectIds = req.projectIds ?? [];

  const { rows: ownedRows } = await getPool().query<{ id: string }>(
    'SELECT id FROM applications WHERE id = $1 AND project_id = ANY($2)',
    [applicationId, projectIds],
  );
  if (ownedRows.length === 0) throw new NotFoundError('Application not found.');

  const [dependsOnResult, dependentsResult] = await Promise.all([
    getPool().query<{ depends_on_id: string }>(
      'SELECT depends_on_id FROM application_dependencies WHERE dependent_id = $1',
      [applicationId],
    ),
    getPool().query<{ dependent_id: string }>(
      'SELECT dependent_id FROM application_dependencies WHERE depends_on_id = $1',
      [applicationId],
    ),
  ]);

  res.status(200).json({
    dependsOn: dependsOnResult.rows.map((row) => row.depends_on_id),
    dependents: dependentsResult.rows.map((row) => row.dependent_id),
  });
}

/**
 * Walks forward from `applicationId`'s newly-written `dependsOn` edges,
 * looking for a path back to `applicationId` itself. `path` accumulates the
 * visited ids so a repeat (other than the closing return to the start) stops
 * that branch - without it, an already-existing cycle elsewhere in the graph
 * (should never happen, since this same check is what prevents one from ever
 * being written) would recurse forever instead of just failing to reach back
 * to `applicationId`.
 *
 * Runs on `client`, the same transaction the edges were just inserted on, so
 * it sees the uncommitted rows.
 *
 * ponytail: one recursive CTE per write, O(edges) in the project - fine up
 * to the ~1k-application ceiling `packages/db/migrations/0006_applications.sql`
 * was sized for; materialise a closure table if a project ever exceeds that.
 */
async function findCyclePath(
  client: PoolClient,
  applicationId: string,
  projectId: string,
): Promise<string[] | null> {
  const { rows } = await client.query<{ path: string[] }>(
    `WITH RECURSIVE reachable AS (
       SELECT depends_on_id AS id, ARRAY[$1::uuid, depends_on_id] AS path
         FROM application_dependencies
        WHERE dependent_id = $1 AND project_id = $2
       UNION ALL
       SELECT ad.depends_on_id, r.path || ad.depends_on_id
         FROM application_dependencies ad
         JOIN reachable r ON ad.dependent_id = r.id
        WHERE ad.project_id = $2
          AND (ad.depends_on_id = $1::uuid OR NOT ad.depends_on_id = ANY(r.path))
     )
     SELECT path FROM reachable WHERE id = $1::uuid LIMIT 1`,
    [applicationId, projectId],
  );
  if (rows.length === 0) return null;

  const ids = rows[0]!.path;
  const { rows: keyRows } = await client.query<{ id: string; key: string }>(
    'SELECT id, key FROM applications WHERE id = ANY($1)',
    [ids],
  );
  const keyById = new Map(keyRows.map((row) => [row.id, row.key]));
  return ids.map((id) => keyById.get(id) ?? id);
}

/**
 * Replaces the whole `dependsOn` set in one transaction: one write path, one
 * cycle check, no partially-applied edit a series of add/remove calls could
 * leave behind. Any failure - the application not being the caller's own, an
 * edge referencing an application outside this project (the composite
 * foreign key `packages/db/migrations/0006_applications.sql` declares is
 * what actually rejects that, this handler only translates its error into a
 * 404), or a cycle - rolls the whole transaction back, so the edge set is
 * exactly what it was before the request on every rejected write.
 */
export async function replaceDependencies(req: Request, res: Response): Promise<void> {
  const applicationId = req.params.id!;
  const body = req.body as ReplaceDependenciesBody;
  const projectIds = req.projectIds ?? [];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const { rows: appRows } = await client.query<{ project_id: string }>(
      'SELECT project_id FROM applications WHERE id = $1 AND project_id = ANY($2)',
      [applicationId, projectIds],
    );
    if (appRows.length === 0) throw new NotFoundError('Application not found.');
    const projectId = appRows[0]!.project_id;

    await client.query('DELETE FROM application_dependencies WHERE dependent_id = $1', [
      applicationId,
    ]);

    for (const dependsOnId of body.dependsOn) {
      try {
        await client.query(
          `INSERT INTO application_dependencies (project_id, dependent_id, depends_on_id)
           VALUES ($1, $2, $3)`,
          [projectId, applicationId, dependsOnId],
        );
      } catch (err) {
        const code = pgErrorCode(err);
        if (code === FOREIGN_KEY_VIOLATION) {
          throw new NotFoundError(
            'One or more dependencies reference an application that does not exist in this project.',
          );
        }
        if (code === CHECK_VIOLATION) {
          throw new BadRequestError('An application cannot depend on itself.');
        }
        if (code === UNIQUE_VIOLATION) {
          // A duplicate id in the same `dependsOn` array - harmless, not an error.
          continue;
        }
        throw err;
      }
    }

    const cyclePath = await findCyclePath(client, applicationId, projectId);
    if (cyclePath) {
      throw new ConflictError(`Dependency cycle detected: ${cyclePath.join(' -> ')}`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  res.status(200).json({ dependsOn: body.dependsOn });
}

export async function getProjectStatus(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  const projectIds = scopeProjectIds(req, projectId);
  const applications = await getApplicationStatuses(projectIds);
  res.status(200).json({ applications });
}

export async function getProjectStatusEvents(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  const projectIds = scopeProjectIds(req, projectId);
  const query = req.query as unknown as StatusEventsQuery;
  const events = await getStatusEvents(projectIds, query.limit);
  res.status(200).json({ events });
}
