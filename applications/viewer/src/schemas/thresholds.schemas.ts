import { z } from 'zod';

const directionEnum = z.enum(['above', 'below']);

/**
 * The same rule `packages/db/migrations/0007_thresholds_and_status.sql`'s
 * `CHECK` constraint already enforces at the database level, duplicated here
 * so a bad request gets a 400 naming the field instead of a 500 from a
 * constraint violation - the database check stays as the backstop for
 * whatever path around this (a direct SQL edit, a future second caller of
 * this table) does not go through this validation.
 */
export interface ThresholdBounds {
  readonly direction: 'above' | 'below';
  readonly warningValue?: number | null | undefined;
  readonly criticalValue?: number | null | undefined;
}

export function thresholdBoundsIssue(value: ThresholdBounds): string | null {
  const warning = value.warningValue ?? null;
  const critical = value.criticalValue ?? null;

  if (warning === null && critical === null) {
    return 'At least one of `warningValue` or `criticalValue` is required.';
  }
  if (warning === null || critical === null) return null;

  const ordered = value.direction === 'above' ? critical >= warning : critical <= warning;
  if (ordered) return null;

  return value.direction === 'above'
    ? '`criticalValue` must be greater than or equal to `warningValue` when direction is "above".'
    : '`criticalValue` must be less than or equal to `warningValue` when direction is "below".';
}

const baseThresholdShape = {
  /** `null`/absent = every application in the project - `thresholds.application_id`'s own meaning. */
  applicationId: z.uuid().nullable().optional(),
  subResource: z.string().min(1).max(200).nullable().optional(),
  metricName: z.string().min(1).max(200),
  direction: directionEnum,
  warningValue: z.number().finite().nullable().optional(),
  criticalValue: z.number().finite().nullable().optional(),
  consecutiveBreaches: z.number().int().min(1).max(10).default(2),
  windowSeconds: z.number().int().min(60).max(86_400).default(300),
  enabled: z.boolean().default(true),
};

export const createThresholdSchema = z
  .object(baseThresholdShape)
  .strict()
  .superRefine((value, ctx) => {
    const message = thresholdBoundsIssue(value);
    if (message) {
      ctx.addIssue({ code: 'custom', path: ['criticalValue'], message });
    }
  });

/**
 * Partial - `applicationId` is deliberately left out. Reassigning a
 * threshold to a different application is not something this task's
 * acceptance criteria ask for, and it would need the same cross-tenant
 * reasoning `PUT .../dependencies` gets; the simplest correct thing today is
 * to not expose it and add it if a real need shows up.
 *
 * Unlike `createThresholdSchema`, this schema does NOT run
 * `thresholdBoundsIssue` itself - a partial update might touch only
 * `warningValue` while `direction` stays whatever it already was, so the
 * check needs the existing row merged in first
 * (`handlers/thresholds.handlers.ts#updateThreshold` does that merge, then
 * calls `thresholdBoundsIssue` on the result).
 */
export const updateThresholdSchema = z
  .object({
    subResource: z.string().min(1).max(200).nullable().optional(),
    metricName: z.string().min(1).max(200).optional(),
    direction: directionEnum.optional(),
    warningValue: z.number().finite().nullable().optional(),
    criticalValue: z.number().finite().nullable().optional(),
    consecutiveBreaches: z.number().int().min(1).max(10).optional(),
    windowSeconds: z.number().int().min(60).max(86_400).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type CreateThresholdBody = z.infer<typeof createThresholdSchema>;
export type UpdateThresholdBody = z.infer<typeof updateThresholdSchema>;
