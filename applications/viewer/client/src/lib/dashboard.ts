import type { Project } from '../api/client.ts';
import type { ProjectSummary, SummaryStatus } from './summary.ts';

/**
 * The dashboard's own arithmetic, kept out of the components so it can be
 * tested: joining projects to their summaries, sorting, the account verdict,
 * freshness and relative time.
 */

export interface DashboardRow {
  readonly project: Project;
  /** Null when the summary failed or does not know this project yet (created a moment ago). */
  readonly summary: ProjectSummary | null;
}

/** Projects joined to summaries by id. Order is preserved; sorting is a separate step. */
export function buildRows(
  projects: readonly Project[],
  summaries: readonly ProjectSummary[] | null,
): DashboardRow[] {
  const byId = new Map((summaries ?? []).map((s) => [s.projectId, s]));
  return projects.map((project) => ({ project, summary: byId.get(project.id) ?? null }));
}

const RANK: Record<SummaryStatus, number> = { critical: 3, warning: 2, ok: 1, unknown: 0 };

/** Rank of a row's worst status: what needs attention sorts first. */
export function rowRank(row: DashboardRow): number {
  return RANK[row.summary?.worst ?? 'unknown'];
}

function sampleTime(row: DashboardRow): number {
  const at = row.summary?.lastSampleAt;
  return at ? Date.parse(at) : -Infinity;
}

/**
 * Worst status first, then most recent data, then newest project, then name so
 * the order is total and does not jump between renders. Without a summary every
 * row ranks equal and this falls through to newest first, the order the API
 * already returned.
 */
export function sortRows(rows: readonly DashboardRow[]): DashboardRow[] {
  return [...rows].sort(
    (a, b) =>
      rowRank(b) - rowRank(a) ||
      sampleTime(b) - sampleTime(a) ||
      Date.parse(b.project.createdAt) - Date.parse(a.project.createdAt) ||
      a.project.name.localeCompare(b.project.name),
  );
}

export interface Totals {
  readonly projects: number;
  readonly applications: number;
  readonly ok: number;
  readonly warning: number;
  readonly critical: number;
  /** Newest sample across the account, ms since epoch, or null. */
  readonly lastSampleAt: number | null;
}

export function totalsOf(rows: readonly DashboardRow[]): Totals {
  let ok = 0;
  let warning = 0;
  let critical = 0;
  let applications = 0;
  let last: number | null = null;
  for (const { summary } of rows) {
    if (!summary) continue;
    ok += summary.counts.ok;
    warning += summary.counts.warning;
    critical += summary.counts.critical;
    applications += summary.applicationCount;
    if (summary.lastSampleAt) {
      const t = Date.parse(summary.lastSampleAt);
      if (last === null || t > last) last = t;
    }
  }
  return { projects: rows.length, applications, ok, warning, critical, lastSampleAt: last };
}

export type VerdictTone = 'ok' | 'warning' | 'critical' | 'neutral';

export interface Verdict {
  readonly tone: VerdictTone;
  readonly headline: string;
}

/**
 * One sentence for the whole account. "Needs attention" is a project whose
 * worst status is warning or critical; a critical one makes the tone critical.
 * An account with applications nowhere is not "healthy", it is silent, and says so.
 */
export function verdictOf(rows: readonly DashboardRow[]): Verdict {
  const attention = sortRows(rows).filter((r) => rowRank(r) >= RANK.warning);
  if (attention.length > 0) {
    const tone = rowRank(attention[0]!) === RANK.critical ? 'critical' : 'warning';
    if (attention.length === 1) {
      return {
        tone,
        headline: `1 project needs attention: ${attention[0]!.project.name}`,
        detail: null,
      };
    }
    return {
      tone,
      headline: `${attention.length} projects need attention`,
      detail: attention.map((r) => r.project.name).join(', '),
    };
  }
  if (totalsOf(rows).applications === 0) {
    return { tone: 'neutral', headline: 'No applications reporting yet' };
  }
  return { tone: 'ok', headline: 'All systems healthy' };
}

/** The collector posts every 60 s; two minutes is one missed beat plus slack. */
export const FRESH_WITHIN_MS = 120_000;

export type Freshness = 'fresh' | 'stale' | 'none';

export function freshnessOf(at: number | string | null, now: number): Freshness {
  if (at === null) return 'none';
  const t = typeof at === 'string' ? Date.parse(at) : at;
  if (Number.isNaN(t)) return 'none';
  return now - t <= FRESH_WITHIN_MS ? 'fresh' : 'stale';
}

/**
 * "40 s ago", "3 min ago", "5 h ago", "2 d ago". Seconds are shown under a
 * minute because this ticks live and the collector runs every 60 s: "just now"
 * would hide exactly the difference the freshness dot is about. A clock a few
 * seconds ahead of the server clamps to 0 rather than printing a negative age.
 */
export function formatRelative(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** Case-insensitive match on name or slug; an empty query keeps everything. */
export function filterRows(rows: readonly DashboardRow[], query: string): DashboardRow[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...rows];
  return rows.filter(
    (r) => r.project.name.toLowerCase().includes(q) || r.project.slug.toLowerCase().includes(q),
  );
}

/** The filter box only earns its space once the list is long enough to scan slowly. */
export const FILTER_MIN_PROJECTS = 7;
