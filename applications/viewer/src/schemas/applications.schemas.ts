import { z } from 'zod';

/**
 * `IDENTIFIER` is duplicated, not imported, from
 * `applications/ingest/src/schemas/ingest.schemas.ts` - deliberately, the
 * same call that file's own comment already made when it copied the pattern
 * from this app's old ingest schema: `packages/shared` is type-only by
 * design (its `package.json` carries no runtime dependency, and its
 * `index.ts` does `export type *`, which erases completely at compile time -
 * see that package's own comments), so a runtime regex has no correct home
 * there, and `applications/viewer` does not depend on `@metrion/ingest` at
 * runtime either. An application `key` IS the value written to
 * `metrics.resource` (`packages/db/migrations/0006_applications.sql`), so
 * this charset must stay byte-for-byte identical to ingest's - if it
 * drifted, a key could be registered here that no ingest payload could ever
 * produce, or the reverse.
 */
const IDENTIFIER = /^[A-Za-z0-9._:-]+$/;

const applicationKey = z.string().min(1).max(200).regex(IDENTIFIER, {
  message: 'Only letters, digits, dot, underscore, colon and hyphen are allowed.',
});

export const createApplicationSchema = z
  .object({
    key: applicationKey,
    displayName: z.string().min(1).max(200),
  })
  .strict();

/**
 * `key` is immutable - it is the join to every historical `metrics.resource`
 * row already written, and renaming it would orphan all of them, so it is
 * not one of the two fields a PATCH may carry.
 *
 * `publicStatusVisible` (finding 2, security review 2026-09-21) is the
 * per-application opt-in the two public ingest endpoints gate on
 * (`packages/db/migrations/0016_application_public_status_visible.sql`) -
 * this is the one place a project owner can flip it, an explicit action
 * rather than a side effect of ingest auto-registering a resource. Both
 * fields are optional; at least one must be present, or a PATCH would be a
 * silent no-op.
 */
export const updateApplicationSchema = z
  .object({
    displayName: z.string().min(1).max(200).optional(),
    publicStatusVisible: z.boolean().optional(),
  })
  .strict()
  .refine((body) => body.displayName !== undefined || body.publicStatusVisible !== undefined, {
    message: 'At least one of displayName or publicStatusVisible must be provided.',
  });

/** `PUT .../dependencies` replaces the whole set in one call - see
 * `handlers/applications.handlers.ts#replaceDependencies` for the
 * transaction and cycle check this body drives. */
export const replaceDependenciesSchema = z
  .object({
    dependsOn: z.array(z.uuid()).max(500),
  })
  .strict();

export const statusEventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type CreateApplicationBody = z.infer<typeof createApplicationSchema>;
export type UpdateApplicationBody = z.infer<typeof updateApplicationSchema>;
export type ReplaceDependenciesBody = z.infer<typeof replaceDependenciesSchema>;
export type StatusEventsQuery = z.infer<typeof statusEventsQuerySchema>;
