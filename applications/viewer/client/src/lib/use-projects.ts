import { fetchProjects, fetchProjectsSummary, type Project } from '../api/client.ts';
import type { ProjectSummary } from './summary.ts';
import { useLoader, type LoadState } from './use-loader.ts';

/**
 * One key ('projects') for every screen that needs the caller's own
 * projects - the dashboard, a project's metrics view and its settings screen
 * all resolve the same list; only the `:projectId` in the URL decides which
 * one a given screen renders. There is no `GET /api/v1/projects/:id`, so a
 * single project is found by filtering this list rather than fetched on its
 * own.
 */
export function useProjects(enabled = true): LoadState<Project[]> {
  return useLoader('projects', (signal) => fetchProjects(signal), enabled);
}

/**
 * The dashboard's health layer, loaded beside `useProjects` rather than after
 * it: the two answer independently, so a slow or failing summary never holds
 * back the list of names.
 */
export function useProjectsSummary(): LoadState<ProjectSummary[]> {
  return useLoader('projects-summary', (signal) => fetchProjectsSummary(signal));
}

export interface ProjectLookup {
  readonly phase: LoadState<Project[]>['phase'];
  readonly project: Project | null;
  readonly error: LoadState<Project[]>['error'];
  readonly elapsedSeconds: number;
  readonly reload: () => void;
}

/**
 * `project` is `null` both while the list is still loading and when the id
 * genuinely does not name one of the caller's own projects - `phase` is what
 * tells those two apart.
 *
 * `enabled` defaults to true but the two project screens pass
 * `auth.status !== 'loading'`: firing this while the one-time `/api/v1/me`
 * check is still in flight would 401 for a signed-out visitor who hit a
 * project URL directly, and flash that error for one render before the
 * auth-driven redirect (`<Navigate to="/" />`) takes over.
 */
export function useProject(projectId: string, enabled = true): ProjectLookup {
  const projects = useProjects(enabled);
  const project = projects.data?.find((candidate) => candidate.id === projectId) ?? null;
  return {
    phase: projects.phase,
    project,
    error: projects.error,
    elapsedSeconds: projects.elapsedSeconds,
    reload: projects.reload,
  };
}
