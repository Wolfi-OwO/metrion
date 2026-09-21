import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { CreateApiKeyBody, CreateProjectBody } from '../schemas/projects.schemas.js';
import { getPool } from '../lib/db.js';
import { NotFoundError } from '../middlewares/error.js';
import { scopeProjectIds } from '../middlewares/project-scope.js';
import { getProjectsSummary as loadProjectsSummary } from '../services/project-summary-service.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION
  );
}

function isForeignKeyViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === FOREIGN_KEY_VIOLATION
  );
}

/** `projects.slug` is `UNIQUE NOT NULL`, and no route ever accepts one from
 * a caller - it is derived from `name` here, and made unique here, so a
 * project named the same as an existing one still gets a project rather than
 * a 409 the caller could not have anticipated from the field they actually
 * sent. */
function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'project';
}

async function insertProjectWithUniqueSlug(
  ownerUserId: string,
  name: string,
  defaultResource: string | null,
): Promise<{ id: string; slug: string; createdAt: Date }> {
  const base = slugify(name);
  const pool = getPool();

  // The base slug first, then `-2`, `-3`, ... on a real collision. Retried
  // against the INSERT's own unique-violation rather than checked with a
  // separate SELECT first: a check-then-insert has a race two concurrent
  // requests for the same `name` can both pass, this doesn't.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
    try {
      const { rows } = await pool.query<{ id: string; slug: string; created_at: Date }>(
        `INSERT INTO projects (owner_user_id, name, slug, default_resource)
         VALUES ($1, $2, $3, $4)
         RETURNING id, slug, created_at`,
        [ownerUserId, name, slug, defaultResource],
      );
      const row = rows[0]!;
      return { id: row.id, slug: row.slug, createdAt: row.created_at };
    } catch (err) {
      if (!isUniqueViolation(err) || attempt === 4) throw err;
    }
  }
  // Unreachable - the loop above always returns or throws.
  throw new Error('Failed to allocate a unique project slug.');
}

export async function listProjects(req: Request, res: Response): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT id, name, slug, default_resource AS "defaultResource", created_at AS "createdAt"
       FROM projects
      WHERE owner_user_id = $1
      ORDER BY created_at`,
    [req.userId],
  );
  res.status(200).json({ projects: rows });
}

export async function getProjectsSummary(req: Request, res: Response): Promise<void> {
  // Same ownership seam as every other read: only the session-derived ids.
  const projects = await loadProjectsSummary(scopeProjectIds(req, undefined));
  res.status(200).json({ projects });
}

export async function createProject(req: Request, res: Response): Promise<void> {
  const body = req.body as CreateProjectBody;
  const project = await insertProjectWithUniqueSlug(
    req.userId!,
    body.name,
    body.defaultResource ?? null,
  );
  res.status(201).json({
    id: project.id,
    name: body.name,
    slug: project.slug,
    defaultResource: body.defaultResource ?? null,
    createdAt: project.createdAt,
  });
}

/** `mtr_<prefix>_<secret>`, hashed the same way
 * `applications/ingest/src/middlewares/api-key.ts` checks it - a key minted
 * here must be readable by the ingest service with no format mismatch. */
function generateApiKey(): { prefix: string; secret: string; hash: Buffer } {
  const prefix = randomBytes(8).toString('hex');
  const secret = randomBytes(24).toString('hex');
  const hash = createHash('sha256').update(secret, 'utf8').digest();
  return { prefix, secret, hash };
}

async function findOwnedProject(projectId: string, ownerUserId: string): Promise<boolean> {
  const { rows } = await getPool().query(
    'SELECT 1 FROM projects WHERE id = $1 AND owner_user_id = $2',
    [projectId, ownerUserId],
  );
  return rows.length > 0;
}

/** Displayed exactly once, in this response, and never again - only
 * `key_hash` is stored, so there is nothing left to re-reveal even to the
 * project's own owner.
 *
 * `applicationId` (issue #20) is optional - absent, the key stays
 * project-wide, exactly the pre-#20 behaviour. When present, its ownership
 * is enforced by the composite foreign key on `api_keys.application_id`
 * (`packages/db/migrations/0006_applications.sql`): an id from another
 * project cannot be inserted at all, so there is nothing to re-check here -
 * `isForeignKeyViolation` below only translates that constraint's rejection
 * into the same 404 an unowned project id already gets, rather than a raw
 * 500. */
export async function createApiKey(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  const { applicationId } = req.body as CreateApiKeyBody;

  const pool = getPool();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { prefix, secret, hash } = generateApiKey();
    try {
      const { rows } = await pool.query<{
        id: string;
        created_at: Date;
        application_id: string | null;
      }>(
        // Ownership is part of the statement, not a separate check before it:
        // the row exists only if the project is this caller's.
        `INSERT INTO api_keys (project_id, key_prefix, key_hash, application_id)
         SELECT p.id, $2::text, $3::bytea, $4::uuid FROM projects p WHERE p.id = $1 AND p.owner_user_id = $5
         RETURNING id, created_at, application_id`,
        [projectId, prefix, hash, applicationId ?? null, req.userId!],
      );
      const row = rows[0];
      if (!row) {
        // Same 404 whether the project does not exist or simply is not this
        // caller's - never confirms another owner's project id is real.
        throw new NotFoundError('Project not found.');
      }
      res.status(201).json({
        id: row.id,
        key: `mtr_${prefix}_${secret}`,
        keyPrefix: prefix,
        createdAt: row.created_at,
        applicationId: row.application_id,
        scope: row.application_id ? 'application' : 'project',
      });
      return;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        throw new NotFoundError('Application not found.');
      }
      if (!isUniqueViolation(err) || attempt === 2) throw err;
    }
  }
}

/** Row shape for `GET /api/v1/projects/:id/keys`. */
interface ApiKeyRow {
  id: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** Metadata only - `key_hash` never leaves this file, and the plaintext
 * secret never existed anywhere but the single response `createApiKey`
 * returns it in. A caller who lost that response has no way back to the
 * secret from here, only proof the key still exists and whether it is
 * revoked - the "shown once" property this list has to keep, not undo. */
export async function listApiKeys(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  if (!(await findOwnedProject(projectId, req.userId!))) {
    throw new NotFoundError('Project not found.');
  }

  const { rows } = await getPool().query<ApiKeyRow>(
    `SELECT id, key_prefix AS "keyPrefix", created_at AS "createdAt",
            last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
       FROM api_keys
      WHERE project_id = $1
      ORDER BY created_at DESC`,
    [projectId],
  );
  res.status(200).json({ keys: rows });
}

export async function revokeApiKey(req: Request, res: Response): Promise<void> {
  const keyId = req.params.id!;
  const { rows } = await getPool().query<{ id: string }>(
    `UPDATE api_keys ak
        SET revoked_at = now()
      WHERE ak.id = $1
        AND ak.revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM projects p
           WHERE p.id = ak.project_id AND p.owner_user_id = $2
        )
      RETURNING ak.id`,
    [keyId, req.userId],
  );
  if (rows.length === 0) {
    throw new NotFoundError('API key not found.');
  }
  res.status(204).end();
}
