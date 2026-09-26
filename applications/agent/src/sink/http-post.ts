import type { MetricEnvelope } from '@metrion/shared';

export interface HttpPostSinkConfig {
  readonly ingestUrl: string;
  /** `mtr_<prefix>_<secret>`, sent as `Authorization: Bearer <apiKey>` - see ingest's `middlewares/api-key.ts`. */
  readonly apiKey: string;
  readonly timeoutMs: number;
}

/**
 * POSTs one queued line's envelope array to `POST /api/v1/ingest`, replacing
 * the old Azure append-blob write (ADR: storage moved off Azure Blob, see
 * `organizational/agent-deployment-runbook.md`). Global `fetch` only - the
 * agent keeps zero runtime dependencies.
 *
 * Throws on any non-2xx response or network/timeout failure, same contract
 * `appendLine` had: `main.ts`'s `flushQueue` treats a throw here as "stop
 * flushing, leave this and every later line queued", not per-line.
 */
export async function sendEnvelopes(
  config: HttpPostSinkConfig,
  envelopes: readonly MetricEnvelope[],
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(config.ingestUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(envelopes),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ingest POST failed: HTTP ${res.status} ${body}`);
    }
  } finally {
    clearTimeout(timer);
  }
}
