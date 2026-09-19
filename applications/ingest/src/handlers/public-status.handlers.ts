import type { Request, Response } from 'express';
import { NotFoundError } from '../middlewares/error.js';
import { getPublicUptime } from '../services/public-status-service.js';

/**
 * No `apiKeyContext`, no session - there is no caller identity on this route
 * (`routes/index.ts` mounts it without `requireApiKey`). `:id` is checked
 * directly against `projects.public_status_enabled` inside `getPublicUptime`,
 * which returns `null` for a nonexistent project id AND for an existing-but-
 * unflagged one - the same "404, never 403" shape the viewer's own copy uses.
 */
export async function getPublicProjectUptime(req: Request, res: Response): Promise<void> {
  const projectId = req.params.id!;
  const result = await getPublicUptime(projectId);
  if (result === null) {
    throw new NotFoundError('Project not found.');
  }

  res.status(200).json({
    projectId,
    generatedAt: new Date().toISOString(),
    applications: result.applications,
  });
}
