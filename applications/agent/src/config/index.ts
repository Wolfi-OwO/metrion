import os from 'node:os';

/**
 * The only place `process.env` is read. Everything else imports `config`.
 * A missing required var fails loudly at process start, not as `undefined`
 * three calls deep into a request/run.
 *
 * `DRY_RUN=true` is the one documented escape hatch: it lets the collector
 * run locally without a real Metrion API key (self-check / manual smoke
 * test), by making the ingest sink log-and-skip instead of sending. It is
 * never set on the server unit.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const dryRun = process.env.DRY_RUN === 'true';

function requireEnvUnlessDryRun(name: string): string {
  if (dryRun) {
    return process.env[name] ?? '';
  }
  return requireEnv(name);
}

export const config = {
  dryRun,
  host: process.env.COLLECTOR_HOST_OVERRIDE || os.hostname(),

  ingest: {
    /** e.g. `https://metrion-ingest.<domain>/api/v1/ingest`. */
    url: requireEnvUnlessDryRun('METRION_INGEST_URL'),
    /** `mtr_<prefix>_<secret>` - see docs/adr/0005-api-key-determines-tenancy.md. */
    apiKey: requireEnvUnlessDryRun('METRION_API_KEY'),
    sendTimeoutMs: Number(process.env.METRION_SEND_TIMEOUT_MS) || 10_000,
  },

  docker: {
    socketPath: process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock',
    /** The container whose stdout carries Caddy's JSON access log. */
    caddyContainerName: process.env.CADDY_CONTAINER_NAME || 'portfolio-caddy-1',
  },

  /** Where the queue (undelivered samples) and small state files (net counters, log cursor) live. */
  stateDir: process.env.COLLECTOR_STATE_DIR || '/var/lib/vps-metrics-collector',

  queue: {
    /**
     * ponytail: hard cap, FIFO-evict-oldest. 1440 lines is 24h of minute
     * samples at ~250-400 bytes each (worst case ~600KB) - bounded, and a
     * generous enough outage window to not lose data on a routine ingest
     * blip. Longer outages lose their oldest, least-useful minutes first
     * rather than growing the queue file without limit.
     */
    maxLines: Number(process.env.COLLECTOR_QUEUE_MAX_LINES) || 1440,
    /** Stop flushing older queued lines after this budget so one bad run never eats into the next minute's timer. */
    flushBudgetMs: Number(process.env.COLLECTOR_QUEUE_FLUSH_BUDGET_MS) || 15_000,
  },
} as const;
