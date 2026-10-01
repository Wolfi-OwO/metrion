import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';

/**
 * One request, one state machine, used by both loads in the app.
 *
 * `waking` is the reason this exists as its own phase. `metrion-viewer` runs
 * on Azure Container Apps at `minReplicas: 0`
 * (`organizational/viewer-deployment-runbook.md`) - measured on that
 * deployment, the replica itself comes up in under a second, but a cold read
 * of a wide range can still run past that, bounded by the query and transfer,
 * not the start. A spinner is indistinguishable from a hung request past
 * `WAKE_AFTER_MS`, so the UI switches to a state that says what is happening
 * and counts the seconds out loud.
 */
export type LoadPhase = 'loading' | 'waking' | 'ready' | 'error';

/**
 * Long enough that an already-warm replica (single-digit milliseconds on the
 * blob cache, tens on a cold scan) never shows the waking copy, short enough
 * that a real cold start is explained before it starts to feel broken.
 */
const WAKE_AFTER_MS = 1200;

export interface LoadState<T> {
  readonly phase: LoadPhase;
  readonly data: T | null;
  readonly error: ApiError | null;
  /** Whole seconds since the in-flight request started; frozen once it settles. */
  readonly elapsedSeconds: number;
  /** Ms epoch of the last successful load, `null` before the first one lands. */
  readonly updatedAt: number | null;
  /**
   * Set when a background refresh (same key, already `ready`) fails; `data`
   * keeps its last good value and `phase` stays `ready` rather than flipping
   * to `error`, so a transient failure never blanks a page already showing
   * something. Cleared on the next successful load.
   */
  readonly refreshError: ApiError | null;
  readonly reload: () => void;
}

function asApiError(cause: unknown): ApiError {
  if (cause instanceof ApiError) return cause;
  return new ApiError(null, cause instanceof Error ? cause.message : 'Unknown failure.');
}

/**
 * `key` is what decides a re-fetch: change it and the previous request is
 * aborted, so a slow answer for last week can never land after a fast answer
 * for today and quietly overwrite the chart.
 */
export function useLoader<T>(
  key: string,
  run: (signal: AbortSignal) => Promise<T>,
  enabled = true,
): LoadState<T> {
  const runRef = useRef(run);
  runRef.current = run;

  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<LoadPhase>('loading');
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [refreshError, setRefreshError] = useState<ApiError | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  // Read inside the effect without joining its dependency list - `phase`
  // changes every time the effect itself calls `setPhase`, so depending on it
  // would refire the effect and fetch in a loop.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  // The key `data` on screen actually came from, separate from `key` above:
  // a background refresh (same key, already `ready`) must not blank the page
  // the way a real key change does.
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    const startedAt = Date.now();
    const background = phaseRef.current === 'ready' && loadedKeyRef.current === key;

    let ticker: ReturnType<typeof setInterval> | null = null;
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;

    if (!background) {
      setPhase('loading');
      setError(null);
      setElapsedSeconds(0);
      ticker = setInterval(
        () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000)),
        1000,
      );
      wakeTimer = setTimeout(() => setPhase('waking'), WAKE_AFTER_MS);
    }

    runRef
      .current(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setData(result);
        setPhase('ready');
        setError(null);
        setRefreshError(null);
        setUpdatedAt(Date.now());
        loadedKeyRef.current = key;
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        const apiError = asApiError(cause);
        if (background) {
          setRefreshError(apiError);
        } else {
          setError(apiError);
          setPhase('error');
        }
      })
      .finally(() => {
        if (ticker) clearInterval(ticker);
        if (wakeTimer) clearTimeout(wakeTimer);
      });

    return () => {
      controller.abort();
      if (ticker) clearInterval(ticker);
      if (wakeTimer) clearTimeout(wakeTimer);
    };
  }, [key, attempt, enabled]);

  const reload = useCallback(() => setAttempt((value) => value + 1), []);

  return { phase, data, error, refreshError, elapsedSeconds, updatedAt, reload };
}
