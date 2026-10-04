import { z } from 'zod';

/**
 * Query schemas for the read endpoints. Also the source the OpenAPI document
 * is generated from, so what the spec advertises is literally what runs.
 */

/**
 * `from`/`to` stay required rather than defaulted - a caller who forgets them
 * gets a 400 naming the field, not a silent all-time query - but there is no
 * upper bound on the range any more. The old 31-day cap existed to keep the
 * in-memory blob scan bounded (an O(days) walk with no index); a range query
 * against an indexed hypertable, falling back to the `metrics_hourly`
 * continuous aggregate past 7 days (`services/metrics-service.ts`), has no
 * equivalent failure mode a query-string cap needs to guard against.
 */
const isoDate = z.iso.datetime({ offset: true });

const rangeShape = {
  from: isoDate,
  to: isoDate,
};

/**
 * Absent means "every project the caller owns" (`req.projectIds` as-is,
 * `middlewares/project-scope.ts`'s existing behaviour) - present means "just
 * this one", checked against that same list in the handler, never trusted
 * from the query string on its own. Only shape validation lives here; a
 * well-formed id that is not the caller's own is a 404 the handler raises,
 * not something a schema can know.
 */
const projectIdShape = { projectId: z.uuid().optional() };

function refineRange<T extends { from: string; to: string }>(schema: z.ZodType<T>) {
  return schema.refine((value) => Date.parse(value.from) <= Date.parse(value.to), {
    path: ['to'],
    message: '`to` must not be earlier than `from`.',
  });
}

export const resourcesQuerySchema = refineRange(
  z.object({ ...rangeShape, ...projectIdShape }).strict(),
);

/**
 * `stepSeconds` is the downsampling bucket width. Floored at the collector's
 * own 60s interval - a smaller bucket cannot reveal anything that was never
 * sampled, it only multiplies the points a chart has to draw.
 */
export const metricsQuerySchema = refineRange(
  z
    .object({
      ...rangeShape,
      ...projectIdShape,
      resource: z.string().min(1).max(200),
      subResource: z.string().min(1).max(200).optional(),
      /** `true`: one series per container behind `subResource`'s group, not their mean. */
      perInstance: z
        .enum(['true', 'false'])
        .transform((value) => value === 'true')
        .optional(),
      /**
       * Repeatable. `?name=cpu.usage&name=memory.used` returns both series
       * from ONE round trip; the client used to issue one request per metric
       * name against the old blob-backed endpoint, and each of those
       * re-downloaded every day-blob in the range. Measured against that
       * deployment: 18 MB per scan pulled from Australia to West Europe, 36
       * metric names, ~27 s each - a five-minute page. Batching survives the
       * move to Postgres because the same reasoning applies to a query: one
       * `name = ANY($n)` beats 36 separate round trips. `query parser:
       * 'simple'` gives an array for a repeated key and a string for a single
       * one, so both shapes have to be accepted here.
       */
      name: z
        .union([z.string().min(1).max(200), z.array(z.string().min(1).max(200)).min(1).max(100)])
        .transform((value) => (Array.isArray(value) ? value : [value])),
      stepSeconds: z.coerce.number().int().min(60).max(86_400).default(60),
    })
    .strict(),
);

export type ResourcesQuery = z.infer<typeof resourcesQuerySchema>;
export type MetricsQuery = z.infer<typeof metricsQuerySchema>;
