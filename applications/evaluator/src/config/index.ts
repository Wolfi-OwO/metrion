/**
 * The only place `process.env` is read - same convention as
 * `applications/agent/src/config/index.ts`. A missing required var fails
 * loudly at process start, not as `undefined` three calls deep into a cycle.
 *
 * `EVALUATOR_DRY_RUN=true` is the escape hatch that lets the evaluator run
 * (against a real or local database) with no real SMTP credentials at all -
 * `src/mailer.ts` swaps in nodemailer's own JSON transport instead of a real
 * one, so a cycle can be exercised end-to-end on the VPS before a Brevo
 * account exists. Never set on the real server unit once real credentials
 * are wired.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dryRun = process.env.EVALUATOR_DRY_RUN === 'true';

function requireEnvUnlessDryRun(name: string): string {
  if (dryRun) {
    return process.env[name] ?? '';
  }
  return requireEnv(name);
}

export const config = {
  dryRun,

  smtp: {
    host: requireEnvUnlessDryRun('SMTP_HOST'),
    port: Number(process.env.SMTP_PORT) || 587,
    user: requireEnvUnlessDryRun('SMTP_USER'),
    /** Never logged, never put in a test fixture - see .env.example. */
    password: requireEnvUnlessDryRun('SMTP_PASSWORD'),
  },
  /** Envelope/header From address - not a secret, but still env-driven since it's provider-specific. */
  alertFrom: requireEnvUnlessDryRun('ALERT_FROM'),

  quota: {
    /**
     * Hard cap on `status_events.notified` rows per project per UTC calendar
     * day, enforced in `mailer.ts`'s `sendDigests`. Unset by default -
     * `Number.MAX_SAFE_INTEGER` so a project's daily count never reaches it
     * in practice, rather than deleting the enforcement path. Hit a real
     * cap of 50 on 2026-10-01 during an unrelated `container.cpu` flapping
     * incident; nothing about normal usage should be silently dropped by a
     * default nobody chose. Set `EVALUATOR_DAILY_EMAIL_CAP` to a real
     * number to opt back into a cap.
     */
    dailyEmailCap: Number(process.env.EVALUATOR_DAILY_EMAIL_CAP) || Number.MAX_SAFE_INTEGER,
    /** Re-notify cooldown per (threshold, sub_resource, state), minutes. */
    cooldownMinutes: Number(process.env.EVALUATOR_COOLDOWN_MINUTES) || 60,
  },

  /** `DELETE FROM status_events WHERE at < now() - this` runs once per cycle. */
  statusEventRetentionDays: Number(process.env.EVALUATOR_STATUS_EVENT_RETENTION_DAYS) || 180,
} as const;
