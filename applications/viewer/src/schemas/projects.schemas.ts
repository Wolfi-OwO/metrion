import { z } from 'zod';

/**
 * `POST /api/v1/projects`'s body. `slug` is never accepted from the caller -
 * `handlers/projects.handlers.ts` derives it from `name` and owns making it
 * unique - so this is the one schema, unlike `metrics.schemas.ts`'s pair,
 * this task needs.
 */
export const createProjectSchema = z
  .object({
    name: z.string().min(1).max(200),
    defaultResource: z.string().min(1).max(200).optional(),
  })
  .strict();

export type CreateProjectBody = z.infer<typeof createProjectSchema>;

/** `POST /api/v1/projects/:id/keys`'s body - optional, so the pre-#20
 * behaviour (no body at all, a project-wide key) keeps working unchanged.
 * `applicationId` binds the key to one application; ownership of it is
 * enforced by the composite foreign key `applications_fk` on `api_keys`
 * (`packages/db/migrations/0006_applications.sql`), not re-checked here -
 * `handlers/projects.handlers.ts#createApiKey` catches that constraint's
 * rejection and turns it into the same 404 an unowned project id gets. */
export const createApiKeySchema = z.object({ applicationId: z.uuid().optional() }).strict();

export type CreateApiKeyBody = z.infer<typeof createApiKeySchema>;
