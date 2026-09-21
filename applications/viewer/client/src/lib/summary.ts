/**
 * `GET /api/v1/projects/summary`: one answer for the whole dashboard, so the
 * page costs two requests however many projects the account owns. (The
 * previous dashboard asked `/status` once per visible row.)
 *
 * The parser is tolerant on purpose. The summary is a garnish over the project
 * list, not the list itself, so a field the server one day renames or drops
 * must degrade one row's sparkline, not blank the dashboard: unknown numbers
 * become 0, a bad timestamp becomes null, a bad `worst` is re-derived from the
 * counts, and an entry with no usable id is skipped.
 */

export type SummaryStatus = 'ok' | 'warning' | 'critical' | 'unknown';

export interface ProjectSummary {
  readonly projectId: string;
  readonly applicationCount: number;
  readonly counts: { readonly ok: number; readonly warning: number; readonly critical: number };
  readonly worst: SummaryStatus;
  /** ISO timestamp of the newest sample, or null when nothing ever arrived. */
  readonly lastSampleAt: string | null;
  /** Samples per whole UTC hour, oldest first, always {@link ACTIVITY_BUCKETS} long. */
  readonly activity24h: readonly number[];
}

export const ACTIVITY_BUCKETS = 24;

const STATUSES: readonly SummaryStatus[] = ['ok', 'warning', 'critical', 'unknown'];

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deriveWorst(applicationCount: number, counts: ProjectSummary['counts']): SummaryStatus {
  if (counts.critical > 0) return 'critical';
  if (counts.warning > 0) return 'warning';
  if (applicationCount > 0 || counts.ok > 0) return 'ok';
  return 'unknown';
}

/** Always 24 long: a short array is padded on the old side, a long one keeps the newest hours. */
function normaliseActivity(value: unknown): number[] {
  const raw = Array.isArray(value) ? value.map(count) : [];
  const tail = raw.slice(-ACTIVITY_BUCKETS);
  return [...Array<number>(ACTIVITY_BUCKETS - tail.length).fill(0), ...tail];
}

export function parseProjectsSummary(body: unknown): ProjectSummary[] {
  const list = isRecord(body) && Array.isArray(body.projects) ? body.projects : [];
  const out: ProjectSummary[] = [];
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry.projectId !== 'string' || entry.projectId === '') continue;
    const status = isRecord(entry.status) ? entry.status : {};
    const counts = {
      ok: count(status.ok),
      warning: count(status.warning),
      critical: count(status.critical),
    };
    // `unknown` counts are 0 today; folded into the total so a future
    // "no thresholds" bucket still adds up instead of vanishing.
    const applicationCount = Math.max(
      count(entry.applicationCount),
      counts.ok + counts.warning + counts.critical + count(status.unknown),
    );
    const worst = STATUSES.includes(entry.worst as SummaryStatus)
      ? (entry.worst as SummaryStatus)
      : deriveWorst(applicationCount, counts);
    const last = typeof entry.lastSampleAt === 'string' ? Date.parse(entry.lastSampleAt) : NaN;
    out.push({
      projectId: entry.projectId,
      applicationCount,
      counts,
      worst,
      lastSampleAt: Number.isNaN(last) ? null : new Date(last).toISOString(),
      activity24h: normaliseActivity(entry.activity24h),
    });
  }
  return out;
}
