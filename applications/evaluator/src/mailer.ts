import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { Pool } from 'pg';
import type { CommittedEvent } from './evaluate.js';

/**
 * Metric names and application display names are user-controlled. They are
 * escaped before they enter the HTML body and never used to build a header
 * (the subject is fixed text plus the project name only, see
 * `buildDigestEmail` below) - this is the whole defence against a project
 * or application named e.g. `<script>` or containing a header-injection
 * newline.
 */
export function escapeHtml(value: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };
  return value.replace(/[&<>"']/g, (char) => escapes[char] as string);
}

/** CR/LF stripped before anything reaches a header (subject line). */
export function stripCrLf(value: string): string {
  return value.replace(/[\r\n]+/g, ' ');
}

export function createRealTransport(smtp: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Transporter {
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.password },
  });
}

/**
 * Never sends anything over the network - used both by `EVALUATOR_DRY_RUN`
 * on the real VPS (before real credentials exist) and by every test in
 * this package. nodemailer's own JSON transport, not a hand-rolled fake -
 * it runs the real MIME-composition code path, just skips the socket.
 */
export function createTestTransport(): Transporter {
  return nodemailer.createTransport({ jsonTransport: true });
}

export interface DigestEvent {
  applicationLabel: string;
  metricName: string;
  subResourceKey: string;
  fromState: CommittedEvent['toState'];
  toState: CommittedEvent['toState'];
  reason: CommittedEvent['reason'];
  value: number | null;
}

/**
 * Pure builder - subject is fixed text + the project name with CR/LF
 * stripped, nothing else ever reaches a header. Every user-controlled
 * string in the body goes through `escapeHtml`.
 */
export function buildDigestEmail(params: {
  from: string;
  to: string;
  projectName: string;
  events: DigestEvent[];
  suppressedUntil: Date | null;
}): { from: string; to: string; subject: string; text: string; html: string } {
  const subject = `Metrion alert: ${stripCrLf(params.projectName)}`;

  const lines = params.events.map((event) => {
    const scope = event.subResourceKey || 'default';
    const reasonSuffix = event.reason === 'no_data' ? ' (no data)' : '';
    const value = event.value === null ? 'n/a' : event.value.toFixed(2);
    return `${event.applicationLabel} / ${event.metricName} [${scope}]: ${event.fromState} -> ${event.toState}${reasonSuffix}, value=${value}`;
  });

  const htmlItems = params.events
    .map((event) => {
      const scope = escapeHtml(event.subResourceKey || 'default');
      const reasonSuffix = event.reason === 'no_data' ? ' (no data)' : '';
      const value = event.value === null ? 'n/a' : event.value.toFixed(2);
      return `<li><strong>${escapeHtml(event.applicationLabel)}</strong> / ${escapeHtml(event.metricName)} [${scope}]: ${event.fromState} &rarr; ${event.toState}${reasonSuffix}, value=${value}</li>`;
    })
    .join('\n');

  const suppressionText = params.suppressedUntil
    ? `\n\nThis project has reached its daily alert cap. Further alerts are suppressed until ${params.suppressedUntil.toISOString()}.`
    : '';
  const suppressionHtml = params.suppressedUntil
    ? `<p><strong>This project has reached its daily alert cap.</strong> Further alerts are suppressed until ${params.suppressedUntil.toISOString()}.</p>`
    : '';

  return {
    from: params.from,
    to: params.to,
    subject,
    text: `${lines.join('\n')}${suppressionText}`,
    html: `<ul>\n${htmlItems}\n</ul>${suppressionHtml}`,
  };
}

function nextUtcMidnight(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

async function isCoolingDown(
  pool: Pool,
  event: CommittedEvent,
  cooldownMinutes: number,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT last_notified_at, last_notified_state FROM threshold_status WHERE threshold_id = $1 AND sub_resource_key = $2`,
    [event.thresholdId, event.subResourceKey],
  );
  const row = rows[0];
  if (!row || !row.last_notified_at || row.last_notified_state !== event.toState) return false;
  const cooldownEndsAt = new Date(row.last_notified_at).getTime() + cooldownMinutes * 60_000;
  return Date.now() < cooldownEndsAt;
}

async function countNotifiedToday(pool: Pool, projectId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM status_events
     WHERE project_id = $1 AND notified = true
       AND at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [projectId],
  );
  return rows[0]?.n ?? 0;
}

function groupByProject(events: CommittedEvent[]): Map<string, CommittedEvent[]> {
  const groups = new Map<string, CommittedEvent[]>();
  for (const event of events) {
    const group = groups.get(event.projectId) ?? [];
    group.push(event);
    groups.set(event.projectId, group);
  }
  return groups;
}

/**
 * One digest email per project per cycle, listing every root-cause event -
 * never one email per threshold. Three guards, all documented in the issue
 * as what keeps the free tier alive through a real incident:
 *
 * 1. A 60-minute re-notify cooldown per (threshold, sub_resource, state),
 *    via `threshold_status.last_notified_at`/`last_notified_state`.
 * 2. A hard cap of `dailyEmailCap` notified `status_events` per project per
 *    UTC calendar day, counted straight from `status_events` (not a
 *    separate emails-sent log). The cycle that reaches the cap appends a
 *    suppression notice to its own digest; every cycle after that, for the
 *    rest of the day, sends nothing at all.
 * 3. `alerts_enabled = false` on `projects` skips the project's email
 *    entirely - colour (already written by `runEvaluationCycle`) is
 *    unaffected.
 */
export async function sendDigests(
  pool: Pool,
  transport: Transporter,
  options: { from: string; dailyEmailCap: number; cooldownMinutes: number },
  events: CommittedEvent[],
): Promise<void> {
  const byProject = groupByProject(events.filter((event) => event.rootCause));

  for (const [projectId, projectEvents] of byProject) {
    const first = projectEvents[0];
    if (!first || !first.alertsEnabled) continue;

    const candidates: CommittedEvent[] = [];
    for (const event of projectEvents) {
      if (!(await isCoolingDown(pool, event, options.cooldownMinutes))) {
        candidates.push(event);
      }
    }
    if (candidates.length === 0) continue;

    const dailyCount = await countNotifiedToday(pool, projectId);
    const capacity = Math.max(0, options.dailyEmailCap - dailyCount);
    if (capacity === 0) continue; // already at/over the cap earlier today - stay silent

    const toSend = candidates.slice(0, capacity);
    const reachesCap = dailyCount + toSend.length >= options.dailyEmailCap;

    await transport.sendMail(
      buildDigestEmail({
        from: options.from,
        to: first.ownerEmail,
        projectName: first.projectName,
        events: toSend,
        suppressedUntil: reachesCap ? nextUtcMidnight() : null,
      }),
    );

    for (const event of toSend) {
      await pool.query(`UPDATE status_events SET notified = true WHERE id = $1`, [event.eventId]);
      await pool.query(
        `UPDATE threshold_status SET last_notified_at = now(), last_notified_state = $3
         WHERE threshold_id = $1 AND sub_resource_key = $2`,
        [event.thresholdId, event.subResourceKey, event.toState],
      );
    }
  }
}
