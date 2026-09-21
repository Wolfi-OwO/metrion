import { z } from 'zod';

/**
 * Query schema for `GET /api/v1/public/projects/:id/uptime/range`. Same
 * `isoDate` + range-refine pattern as `applications/viewer/src/schemas/
 * metrics.schemas.ts`, but both bounds are optional here (`from` defaults to
 * "whole period", `to` to now) and a bare date is accepted too.
 *
 * Not `.strict()`, unlike the viewer's: the sibling `/uptime` route ignores
 * every query parameter, and a public route that starts rejecting cache-
 * busting or tracking parameters a CDN or browser adds is a worse failure
 * than ignoring them.
 */
const isoInstant = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Nothing before this can be a real sample; also stops absurd ranges early. */
export const MIN_FROM_MS = Date.UTC(2000, 0, 1);

function instant(value: string | undefined, endOfDay: boolean): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  // A date-only `to` names a whole UTC day and is inclusive, so it means the
  // start of the NEXT day (this API's ranges are half-open, [from, to)).
  return endOfDay && DATE_ONLY.test(value) ? ms + DAY_MS : ms;
}

export interface PublicRangeQuery {
  readonly from: number | undefined;
  readonly to: number | undefined;
}

export const publicRangeQuerySchema = z
  .object({ from: isoInstant.optional(), to: isoInstant.optional() })
  .transform((q): PublicRangeQuery => ({ from: instant(q.from, false), to: instant(q.to, true) }))
  .refine((q) => q.from === undefined || q.from >= MIN_FROM_MS, {
    path: ['from'],
    message: '`from` must not be earlier than 2000-01-01.',
  })
  .refine((q) => q.from === undefined || q.to === undefined || q.from < q.to, {
    path: ['to'],
    message: '`to` must be later than `from`.',
  });
