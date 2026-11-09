import { config } from '../config/index.js';

/** A message in the form llama.cpp's OpenAI-compatible endpoint takes. */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** @returns True when the language model server answers. */
export async function llmHealthy(): Promise<boolean> {
  if (!config.llm.url) return false;
  try {
    const response = await fetch(new URL('/health', config.llm.url), {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// One answer at a time: the model runs on the server's CPU, and the same model also serves another application.
let queue: Promise<unknown> = Promise.resolve();

/**
 * The model's answer, constrained to `schema` by the server's grammar sampler, so it always parses.
 *
 * @throws {Error} When the model is not configured, does not answer or is cut off.
 */
export function complete(messages: LlmMessage[], schema: Record<string, unknown>): Promise<string> {
  const run = async (): Promise<string> => {
    if (!config.llm.url) throw new Error('LLM_SERVICE_URL is not set.');
    const response = await fetch(new URL('/v1/chat/completions', config.llm.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages,
        stream: false,
        temperature: 0.2,
        max_tokens: config.llm.maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'assistant_turn', strict: true, schema },
        },
      }),
      signal: AbortSignal.timeout(config.llm.timeoutMs),
    });
    if (!response.ok) throw new Error(`llm answered ${String(response.status)}`);
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error('llm answered nothing');
    return text;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
