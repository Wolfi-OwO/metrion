import type { Request, Response } from 'express';
import { getPool } from '../lib/db.js';
import {
  BadRequestError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../middlewares/error.js';
import { scopeProjectIds } from '../middlewares/project-scope.js';
import type { CreateThresholdBody, UpdateThresholdBody } from '../schemas/thresholds.schemas.js';
import { thresholdBoundsIssue } from '../schemas/thresholds.schemas.js';

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';

function pgErrorCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined;
}

interface ThresholdRow {
  id: string;
  application_id: string | null;
  sub_resource: string | null;
  metric_name: string;
  direction: string;
  warning_value: number | null;
  critical_value: number | null;
  consecutive_breaches: number;
  window_seconds: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

function toThresholdJson(row: ThresholdRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
    subResource: row.sub_resource,
    metricName: row.metric_name,
    direction: row.direction,
    warningValue: row.warning_value,
    criticalValue: row.critical_value,
    consecutiveBreaches: row.consecutive_breaches,
    windowSeconds: row.window_seconds,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const THRESHOLD_COLUMNS = `id, application_id, sub_resource, metric_name, direction, warning_value,
       critical_value, consecutive_breaches, window_seconds, enabled, created_at, updated_at`;

export async function listThresholds(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  const projectIds = scopeProjectIds(req, projectId);
  const { rows } = await getPool().query<ThresholdRow>(
    `SELECT ${THRESHOLD_COLUMNS} FROM thresholds WHERE project_id = ANY($1) ORDER BY created_at`,
    [projectIds],
  );
  res.status(200).json({ thresholds: rows.map(toThresholdJson) });
}

/**
 * `direction`/`warning`/`critical` ordering is checked twice on purpose:
 * `thresholds.schemas.ts#createThresholdSchema` rejects it with a 400 naming
 * the field before this ever runs a query, and
 * `packages/db/migrations/0007_thresholds_and_status.sql`'s own `CHECK`
 * constraint is the backstop this handler still has to translate (the
 * `CHECK_VIOLATION` branch below) in case the two ever drift.
 */
export async function createThreshold(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  scopeProjectIds(req, projectId);
  const body = req.body as CreateThresholdBody;

  try {
    const { rows } = await getPool().query<ThresholdRow>(
      `INSERT INTO thresholds
         (project_id, application_id, sub_resource, metric_name, direction,
          warning_value, critical_value, consecutive_breaches, window_seconds, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${THRESHOLD_COLUMNS}`,
      [
        projectId,
        body.applicationId ?? null,
        body.subResource ?? null,
        body.metricName,
        body.direction,
        body.warningValue ?? null,
        body.criticalValue ?? null,
        body.consecutiveBreaches,
        body.windowSeconds,
        body.enabled,
      ],
    );
    res.status(201).json(toThresholdJson(rows[0]!));
  } catch (err) {
    const code = pgErrorCode(err);
    if (code === FOREIGN_KEY_VIOLATION) {
      throw new NotFoundError('Application not found.');
    }
    if (code === UNIQUE_VIOLATION) {
      throw new ConflictError(
        'A threshold for this metric already exists for this application/sub-resource.',
      );
    }
    if (code === CHECK_VIOLATION) {
      throw new BadRequestError('Invalid threshold bounds for the given direction.');
    }
    throw err;
  }
}

/** Merges the request onto the existing row before re-checking
 * `thresholdBoundsIssue` - a `PATCH` that only sends `warningValue` still has
 * to be validated against whatever `direction` and `criticalValue` the row
 * already has, not against nothing. */
export async function updateThreshold(req: Request, res: Response): Promise<void> {
  const thresholdId = req.params.id!;
  const projectIds = req.projectIds ?? [];
  const body = req.body as UpdateThresholdBody;

  const { rows: currentRows } = await getPool().query<ThresholdRow>(
    `SELECT ${THRESHOLD_COLUMNS} FROM thresholds WHERE id = $1 AND project_id = ANY($2)`,
    [thresholdId, projectIds],
  );
  if (currentRows.length === 0) throw new NotFoundError('Threshold not found.');
  const existing = currentRows[0]!;

  const merged = {
    subResource: body.subResource !== undefined ? body.subResource : existing.sub_resource,
    metricName: body.metricName ?? existing.metric_name,
    direction: (body.direction ?? existing.direction) as 'above' | 'below',
    warningValue: body.warningValue !== undefined ? body.warningValue : existing.warning_value,
    criticalValue: body.criticalValue !== undefined ? body.criticalValue : existing.critical_value,
    consecutiveBreaches: body.consecutiveBreaches ?? existing.consecutive_breaches,
    windowSeconds: body.windowSeconds ?? existing.window_seconds,
    enabled: body.enabled ?? existing.enabled,
  };

  const issue = thresholdBoundsIssue(merged);
  if (issue) throw new ValidationError([{ path: 'criticalValue', message: issue }]);

  const { rows } = await getPool().query<ThresholdRow>(
    `UPDATE thresholds
        SET sub_resource = $1, metric_name = $2, direction = $3, warning_value = $4,
            critical_value = $5, consecutive_breaches = $6, window_seconds = $7,
            enabled = $8, updated_at = now()
      WHERE id = $9
      RETURNING ${THRESHOLD_COLUMNS}`,
    [
      merged.subResource,
      merged.metricName,
      merged.direction,
      merged.warningValue,
      merged.criticalValue,
      merged.consecutiveBreaches,
      merged.windowSeconds,
      merged.enabled,
      thresholdId,
    ],
  );
  res.status(200).json(toThresholdJson(rows[0]!));
}

export async function deleteThreshold(req: Request, res: Response): Promise<void> {
  const thresholdId = req.params.id!;
  const projectIds = req.projectIds ?? [];

  const { rows } = await getPool().query<{ id: string }>(
    'DELETE FROM thresholds WHERE id = $1 AND project_id = ANY($2) RETURNING id',
    [thresholdId, projectIds],
  );
  if (rows.length === 0) throw new NotFoundError('Threshold not found.');
  res.status(204).end();
}
