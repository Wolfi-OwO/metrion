import { parseProjectsSummary, type ProjectSummary } from '../lib/summary.ts';

/**
 * The only place this app talks to the network.
 *
 * Every URL is a bare `/api/...` path: the Vite dev server proxies those to
 * `localhost:8080`, and in production this bundle is meant to be served by the
 * same Express app - so there is no base URL to configure and no CORS on
 * either side. That second half is intent, not yet fact: nothing calls
 * `express.static` in `applications/viewer/src` today, and until it does these
 * paths only resolve behind the dev proxy.
 */

/** Mirrors `ResourceSummary` in `applications/viewer/src/services/metrics-service.ts`. */
export interface ResourceSummary {
  readonly resource: string;
  readonly subResources: string[];
  readonly metricNames: string[];
}

export interface ResourcesResponse {
  readonly resources: ResourceSummary[];
  readonly skippedLines: number;
}

export interface SeriesPoint {
  readonly timestamp: string;
  readonly value: number;
  /** Raw samples behind the bucket mean. An honest 1 beats a smooth-looking lie. */
  readonly count: number;
}

export interface SeriesResult {
  readonly resource: string;
  readonly subResource?: string;
  readonly name: string;
  /** `null` when the range held no point for this metric, so the unit is unknown. */
  readonly unit: string | null;
  readonly stepSeconds: number;
  readonly points: SeriesPoint[];
}

/** What `GET /api/v1/metrics` returns: every requested name, from one scan. */
export interface SeriesBatch {
  readonly series: SeriesResult[];
  readonly skippedLines: number;
}

/**
 * One failure type for the whole app. `status === null` means the request never
 * reached a server - a dropped API, a dead network, a rejected DNS lookup - and
 * the UI says so in those words rather than inventing an HTTP code for it.
 */
export class ApiError extends Error {
  readonly status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  /** 503 is the viewer's own answer when blob storage is not configured. */
  get isStorageUnavailable(): boolean {
    return this.status === 503;
  }
}

interface ErrorBody {
  message?: string;
  issues?: { path: string; message: string }[];
}

// The API's own message names the field that failed validation, which is far
// more useful than "Request failed" - but it is only there when the body
// really is the documented error envelope. Shared by every caller below so a
// mutation's error reads exactly like a read's.
async function parseErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as ErrorBody;
  const detail = body.issues?.[0];
  return detail
    ? `${detail.path}: ${detail.message}`
    : (body.message ?? `HTTP ${response.status}.`);
}

async function getJson<T>(
  path: string,
  params: URLSearchParams,
  signal: AbortSignal,
  // Names the API in the network-failure message: a dead projects call used to
  // tell the dashboard that "the metrics API did not answer".
  api: 'metrics' | 'projects' = 'metrics',
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${path}?${params}`, {
      signal,
      headers: { accept: 'application/json' },
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(null, `The ${api} API did not answer.`);
  }

  if (!response.ok) throw new ApiError(response.status, await parseErrorMessage(response));
  return (await response.json()) as T;
}

/**
 * `POST`/`PUT`/`PATCH`/`DELETE` against the accounts and projects API. Same
 * shape as `getJson`, minus the query string and plus an optional JSON body -
 * the session cookie rides along automatically because every request here is
 * same-origin, exactly like the read calls above.
 */
async function sendJson<T>(
  path: string,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  body: unknown,
  signal: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(null, 'The projects API did not answer.');
  }

  if (!response.ok) throw new ApiError(response.status, await parseErrorMessage(response));
  // `POST /auth/logout` and `DELETE /api/v1/keys/:id` both answer 204 with no
  // body - reading `.json()` on that response throws on the empty string.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/** Mirrors `GET /api/v1/me` in `applications/viewer/src/handlers/auth.handlers.ts`. */
export interface MeResponse {
  readonly id: string;
  readonly email: string;
}

/**
 * `null` on a 401, not a thrown `ApiError` - "no session" is the expected
 * answer for a signed-out visitor, not a failure this app needs a retry
 * button for. Anything else (a 500, a dropped connection) still throws.
 */
export async function fetchMe(signal: AbortSignal): Promise<MeResponse | null> {
  let response: Response;
  try {
    response = await fetch('/api/v1/me', { signal, headers: { accept: 'application/json' } });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new ApiError(null, 'The account API did not answer.');
  }

  if (response.status === 401) return null;
  if (!response.ok) throw new ApiError(response.status, await parseErrorMessage(response));
  return (await response.json()) as MeResponse;
}

export function logout(signal: AbortSignal): Promise<void> {
  return sendJson<void>('/auth/logout', 'POST', undefined, signal);
}

/** Mirrors the row shape `listProjects`/`createProject` return in
 * `applications/viewer/src/handlers/projects.handlers.ts`. */
export interface Project {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly defaultResource: string | null;
  readonly createdAt: string;
}

export function fetchProjects(signal: AbortSignal): Promise<Project[]> {
  return getJson<{ projects: Project[] }>(
    '/api/v1/projects',
    new URLSearchParams(),
    signal,
    'projects',
  ).then((body) => body.projects);
}

/** Health, freshness and a 24 h activity strip for every owned project in one call. */
export function fetchProjectsSummary(signal: AbortSignal): Promise<ProjectSummary[]> {
  return getJson<unknown>(
    '/api/v1/projects/summary',
    new URLSearchParams(),
    signal,
    'projects',
  ).then(parseProjectsSummary);
}

export function createProject(name: string, signal: AbortSignal): Promise<Project> {
  return sendJson<Project>('/api/v1/projects', 'POST', { name }, signal);
}

/** What `POST /api/v1/projects/:id/keys` returns - the only response that
 * ever carries `key`, the plaintext secret. Nothing later re-reveals it: the
 * server stores only `key_hash` (`handlers/projects.handlers.ts`). */
export interface ApiKeyCreated {
  readonly id: string;
  readonly key: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
}

export function createApiKey(projectId: string, signal: AbortSignal): Promise<ApiKeyCreated> {
  return sendJson<ApiKeyCreated>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/keys`,
    'POST',
    undefined,
    signal,
  );
}

export function revokeApiKey(keyId: string, signal: AbortSignal): Promise<void> {
  return sendJson<void>(`/api/v1/keys/${encodeURIComponent(keyId)}`, 'DELETE', undefined, signal);
}

/** `projectId` omitted narrows to nothing; passed, it scopes to just that one
 * project - `GET /api/v1/resources?projectId=`'s own behaviour
 * (`schemas/metrics.schemas.ts`, `middlewares/project-scope.ts`). */
export function fetchResources(
  from: Date,
  to: Date,
  signal: AbortSignal,
  projectId?: string,
): Promise<ResourcesResponse> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  if (projectId) params.set('projectId', projectId);
  return getJson<ResourcesResponse>('/api/v1/resources', params, signal);
}

export interface SeriesQuery {
  readonly resource: string;
  readonly subResource?: string | undefined;
  readonly names: readonly string[];
  readonly from: Date;
  readonly to: Date;
  readonly stepSeconds: number;
  readonly projectId?: string | undefined;
}

/**
 * Every requested metric in ONE request.
 *
 * `name` is repeated rather than joined: sub-resource and metric names are
 * free-form, so any delimiter would eventually appear inside a name. The
 * server runs one parameterised query against the `metrics`/`metrics_hourly`
 * hypertable, matching every name in a single `name = ANY($n)` clause, and
 * answers for all of them in one round trip - it used to take a single name
 * against the append-blob store (ADR 0001, since replaced by ADR 0004), which
 * meant one 18 MB cross-region download per metric per call and a
 * five-minute page for a host with 36 of them.
 */
export function fetchSeries(query: SeriesQuery, signal: AbortSignal): Promise<SeriesBatch> {
  const params = new URLSearchParams({
    resource: query.resource,
    from: query.from.toISOString(),
    to: query.to.toISOString(),
    stepSeconds: String(query.stepSeconds),
  });
  for (const name of query.names) params.append('name', name);
  // `subResource` is `.strict()`-validated upstream: sending it empty is a 400,
  // so an absent sub-resource means an absent parameter.
  if (query.subResource) params.set('subResource', query.subResource);
  if (query.projectId) params.set('projectId', query.projectId);

  return getJson<SeriesBatch>('/api/v1/metrics', params, signal);
}

/** Mirrors the row shape `listApiKeys` returns in
 * `applications/viewer/src/handlers/projects.handlers.ts` - metadata only,
 * never the secret or its hash. */
export interface ApiKeySummary {
  readonly id: string;
  readonly keyPrefix: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

export function fetchApiKeys(projectId: string, signal: AbortSignal): Promise<ApiKeySummary[]> {
  return getJson<{ keys: ApiKeySummary[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/keys`,
    new URLSearchParams(),
    signal,
  ).then((body) => body.keys);
}

/** Mirrors `Status`/`ThresholdStatusEntry`/`ApplicationStatus` in
 * `applications/viewer/src/services/status-service.ts` - the API never
 * returns a colour, only one of these three words. `ok` also covers "nothing
 * has evaluated this yet" on a fresh project, same value a genuinely healthy
 * application would answer once thresholds exist for it - see that file's
 * own comment. */
export type Status = 'ok' | 'warning' | 'critical';

export interface ThresholdStatusEntry {
  readonly id: string;
  readonly metricName: string;
  readonly state: Status;
  readonly reason: 'threshold' | 'no_data';
  readonly value: number | null;
  readonly since: string;
}

/** `causedBy` is `null` when `effectiveStatus` is explained entirely by this
 * application's own thresholds - see `status-service.ts#getApplicationStatuses`.
 * `lastCheck` is the newest raw `uptime.ok` sample, independent of the
 * averaged threshold `status` above it - `null` with no samples yet. */
export interface ApplicationStatus {
  readonly id: string;
  readonly key: string;
  readonly displayName: string | null;
  readonly status: Status;
  readonly effectiveStatus: Status;
  readonly causedBy: { readonly id: string; readonly key: string } | null;
  readonly thresholds: ThresholdStatusEntry[];
  readonly lastCheck: { readonly ok: boolean; readonly at: string } | null;
}

export function fetchProjectStatus(
  projectId: string,
  signal: AbortSignal,
): Promise<ApplicationStatus[]> {
  return getJson<{ applications: ApplicationStatus[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/status`,
    new URLSearchParams(),
    signal,
  ).then((body) => body.applications);
}

/** Mirrors `StatusEvent` in `status-service.ts`. Newest first, already
 * limited server-side (default 50, `statusEventsQuerySchema`). */
export interface StatusEvent {
  readonly id: string;
  readonly applicationId: string | null;
  readonly thresholdId: string;
  readonly metricName: string;
  readonly fromState: string;
  readonly toState: string;
  readonly value: number | null;
  readonly at: string;
}

export function fetchStatusEvents(projectId: string, signal: AbortSignal): Promise<StatusEvent[]> {
  return getJson<{ events: StatusEvent[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/status/events`,
    new URLSearchParams(),
    signal,
  ).then((body) => body.events);
}

export interface ApplicationCreated {
  readonly id: string;
  readonly key: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export function createApplication(
  projectId: string,
  key: string,
  displayName: string,
  signal: AbortSignal,
): Promise<ApplicationCreated> {
  return sendJson<ApplicationCreated>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/applications`,
    'POST',
    { key, displayName },
    signal,
  );
}

/** Direct edges only - `dependsOn` is what `replaceDependencies` writes back;
 * `dependents` is the reverse direction, offered by the same GET but not
 * used by this client today. Mirrors `getDependencies` in
 * `applications.handlers.ts`. */
export interface DependencyEdges {
  readonly dependsOn: string[];
  readonly dependents: string[];
}

export function fetchDependencies(
  projectId: string,
  applicationId: string,
  signal: AbortSignal,
): Promise<DependencyEdges> {
  return getJson<DependencyEdges>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/dependencies`,
    new URLSearchParams(),
    signal,
  );
}

/** Replaces the whole `dependsOn` set - see `replaceDependencies` in
 * `applications.handlers.ts`. A cycle answers 409 with a plain-text message
 * of the shape `Dependency cycle detected: a -> b -> c`; `lib/status.ts`'s
 * `cyclePathFromMessage` is what turns that back into an array of keys, kept
 * separate from this module because it parses `ApiError#message`, not a
 * response body field the API documents as structured. */
export function replaceDependencies(
  projectId: string,
  applicationId: string,
  dependsOn: readonly string[],
  signal: AbortSignal,
): Promise<{ dependsOn: string[] }> {
  return sendJson<{ dependsOn: string[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/applications/${encodeURIComponent(applicationId)}/dependencies`,
    'PUT',
    { dependsOn },
    signal,
  );
}

/** Mirrors `toThresholdJson` in `thresholds.handlers.ts`. */
export interface Threshold {
  readonly id: string;
  readonly applicationId: string | null;
  readonly subResource: string | null;
  readonly metricName: string;
  readonly direction: 'above' | 'below';
  readonly warningValue: number | null;
  readonly criticalValue: number | null;
  readonly consecutiveBreaches: number;
  readonly windowSeconds: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What both `createThreshold` and `updateThreshold` below send - a subset
 * of `Threshold`'s own fields, `id`/`createdAt`/`updatedAt` excluded because
 * the server assigns them. `applicationId` is accepted by `POST` and simply
 * never sent by `PATCH` - `updateThresholdSchema` does not have the field at
 * all, matching that schema's own comment on why reassignment is out of
 * scope. */
export interface ThresholdInput {
  readonly applicationId?: string | null;
  readonly subResource?: string | null;
  readonly metricName: string;
  readonly direction: 'above' | 'below';
  readonly warningValue?: number | null;
  readonly criticalValue?: number | null;
  readonly consecutiveBreaches: number;
  readonly windowSeconds: number;
  readonly enabled: boolean;
}

export function fetchThresholds(projectId: string, signal: AbortSignal): Promise<Threshold[]> {
  return getJson<{ thresholds: Threshold[] }>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/thresholds`,
    new URLSearchParams(),
    signal,
  ).then((body) => body.thresholds);
}

export function createThreshold(
  projectId: string,
  input: ThresholdInput,
  signal: AbortSignal,
): Promise<Threshold> {
  return sendJson<Threshold>(
    `/api/v1/projects/${encodeURIComponent(projectId)}/thresholds`,
    'POST',
    input,
    signal,
  );
}

export function updateThreshold(
  thresholdId: string,
  input: Omit<ThresholdInput, 'applicationId'>,
  signal: AbortSignal,
): Promise<Threshold> {
  return sendJson<Threshold>(
    `/api/v1/thresholds/${encodeURIComponent(thresholdId)}`,
    'PATCH',
    input,
    signal,
  );
}

export function deleteThreshold(thresholdId: string, signal: AbortSignal): Promise<void> {
  return sendJson<void>(
    `/api/v1/thresholds/${encodeURIComponent(thresholdId)}`,
    'DELETE',
    undefined,
    signal,
  );
}
