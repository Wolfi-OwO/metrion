import type { Request, Response } from 'express';
import type { MetricEnvelope, MetricPoint } from '@metrion/shared';
import { getPool } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { BadRequestError } from '../middlewares/error.js';
import type { IngestBody } from '../schemas/ingest.schemas.js';

function isBareMetricPoints(body: IngestBody): body is MetricPoint[] {
  return Array.isArray(body) && body.length > 0 && !('metrics' in (body[0] as object));
}

/**
 * Normalizes all three accepted body shapes (`schemas/ingest.schemas.ts`)
 * into envelopes. `resource` on a bare metric-point array falls back to
 * `fallbackResource` - the bound application's own key when the API key is
 * application-scoped, else the project's `default_resource` - never anything
 * read from the body, per ADR 0005: the only thing a caller's key ever
 * decides is `project_id`, and `resource` stays a plain label even on the
 * branch that has to invent one.
 */
function toEnvelopes(body: IngestBody, fallbackResource: string | null): MetricEnvelope[] {
  if (isBareMetricPoints(body)) {
    if (!fallbackResource) {
      throw new BadRequestError(
        'This project has no default_resource configured; a bare metric-point array needs one to fall back to. Send an enveloped body with an explicit "resource" instead.',
      );
    }
    return [{ resource: fallbackResource, metrics: body }];
  }
  return Array.isArray(body) ? body : [body];
}

/**
 * An application-bound key (`api_keys.application_id`) forces `resource` to
 * that application's own `key` for every point, ignoring whatever the body
 * named - ADR 0005's "resource is a plain label, never tenancy" applied one
 * level down: an application token cannot write under a different
 * application's name any more than a project's key can move a row into a
 * different project. A mismatch is silently overridden, not rejected -
 * logged at debug so a confused sender is diagnosable without failing their
 * writes.
 */
function applyApplicationScope(
  envelopes: readonly MetricEnvelope[],
  applicationResource: string | null,
): MetricEnvelope[] {
  if (!applicationResource) return envelopes as MetricEnvelope[];
  return envelopes.map((envelope) => {
    if (envelope.resource === applicationResource) return envelope;
    logger.debug(
      { bodyResource: envelope.resource, applicationResource },
      'application-bound API key: overriding body resource with the bound application',
    );
    return { ...envelope, resource: applicationResource };
  });
}

interface MetricRow {
  readonly time: string;
  readonly resource: string;
  readonly subResource: string | null;
  readonly name: string;
  readonly value: number;
  readonly unit: string;
  readonly intervalSeconds: number;
}

function toRows(envelopes: readonly MetricEnvelope[]): MetricRow[] {
  return envelopes.flatMap((envelope) =>
    envelope.metrics.map((point) => ({
      time: point.timestamp,
      resource: envelope.resource,
      subResource: envelope.subResource ?? null,
      name: point.name,
      value: point.value,
      unit: point.unit,
      intervalSeconds: point.intervalSeconds,
    })),
  );
}

const COLUMNS_PER_ROW = 8;
const UPTIME_COLUMNS_PER_ROW = 7;

/**
 * `uptime.*` points are also kept in `uptime_samples`, the permanent store
 * with no retention (ADR 0009); `metrics` keeps its own copy for 90 days so
 * the viewer's metric screens and thresholds work unchanged.
 */
const isUptime = (row: MetricRow): boolean => row.name.startsWith('uptime.');

/**
 * One parameterised multi-row `INSERT` per table per request, in ONE
 * transaction so a request never lands in `metrics` without its
 * `uptime_samples` twin or the reverse. `projectId` is resolved exactly once,
 * by `requireApiKey`, from the authenticated key - it is the only project a
 * row from this request can ever land in, regardless of what `resource`
 * string the body names (ADR 0005: a `resource` value that happens to match
 * another project's own naming still writes here, under this key's project).
 *
 * `uptime_samples` uses ON CONFLICT DO NOTHING so a replayed envelope does
 * not duplicate history (`metrics` itself has no unique key and keeps its
 * append behaviour).
 */
async function insertRows(projectId: string, rows: readonly MetricRow[]): Promise<void> {
  if (rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const base = index * COLUMNS_PER_ROW;
    values.push(
      row.time,
      projectId,
      row.resource,
      row.subResource,
      row.name,
      row.value,
      row.unit,
      row.intervalSeconds,
    );
    const params = Array.from({ length: COLUMNS_PER_ROW }, (_, i) => `$${base + i + 1}`);
    return `(${params.join(', ')})`;
  });

  const uptimeValues: unknown[] = [];
  const uptimePlaceholders = rows.filter(isUptime).map((row, index) => {
    const base = index * UPTIME_COLUMNS_PER_ROW;
    uptimeValues.push(
      row.time,
      projectId,
      row.resource,
      row.name,
      row.value,
      row.unit,
      row.intervalSeconds,
    );
    const params = Array.from({ length: UPTIME_COLUMNS_PER_ROW }, (_, i) => `$${base + i + 1}`);
    return `(${params.join(', ')})`;
  });

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO metrics (time, project_id, resource, sub_resource, name, value, unit, interval_seconds)
       VALUES ${placeholders.join(', ')}`,
      values,
    );
    if (uptimePlaceholders.length > 0) {
      await client.query(
        `INSERT INTO uptime_samples (time, project_id, resource, name, value, unit, interval_seconds)
         VALUES ${uptimePlaceholders.join(', ')}
         ON CONFLICT (project_id, resource, name, time) DO NOTHING`,
        uptimeValues,
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Registers every distinct `resource` this request wrote as an `applications`
 * row, so the dependency and threshold editors (`applications/viewer`) have
 * something to list for a project that is actively sending data, rather than
 * staying empty until someone creates an application by hand.
 * `display_name` is left null - the UI falls back to `key` until named.
 *
 * ponytail: per-request upsert, no cache; add an in-process seen-set if
 * request rate ever makes this measurable.
 */
async function registerResources(projectId: string, rows: readonly MetricRow[]): Promise<void> {
  const resources = new Set(rows.map((row) => row.resource));
  for (const resource of resources) {
    await getPool().query(
      'INSERT INTO applications (project_id, key) VALUES ($1, $2) ON CONFLICT (project_id, key) DO NOTHING',
      [projectId, resource],
    );
  }
}

/**
 * 202, not 201: the rows are durably written, but nothing is created at a URL
 * the caller can then fetch - same reasoning the viewer's blob-backed ingest
 * endpoint used before this replaced it.
 */
export async function ingestMetrics(req: Request, res: Response): Promise<void> {
  const auth = req.apiKeyContext;
  if (!auth) {
    // requireApiKey is mounted ahead of this handler on every route that
    // reaches it; reaching here without it is a wiring bug, not a client error.
    throw new Error('ingestMetrics reached with no apiKeyContext - requireApiKey did not run.');
  }

  const body = req.body as IngestBody;
  const envelopes = applyApplicationScope(
    toEnvelopes(body, auth.applicationResource ?? auth.defaultResource),
    auth.applicationResource,
  );
  const rows = toRows(envelopes);

  await insertRows(auth.projectId, rows);
  await registerResources(auth.projectId, rows);

  res.status(202).json({
    accepted: envelopes.length,
    points: rows.length,
  });
}
