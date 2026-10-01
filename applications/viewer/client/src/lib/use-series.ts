import { useEffect, useRef, useState } from 'react';
import { ApiError, fetchSeries, type SeriesResult } from '../api/client.ts';
import type { TimeRange } from './range.ts';

/**
 * Loads every metric of the selected resource in ONE request.
 *
 * This used to issue one request per metric name, capped at three at a time,
 * because `GET /api/v1/metrics` answered for a single name and re-read every
 * day-blob for each call. Measured against the real deployment that was 36
 * requests x ~27 s = about five minutes to fill the page, and the 27 s was
 * almost entirely the 18 MB day-blob transfer from Australia Southeast to
 * West Europe - 36.4 s of download against 98 ms of parsing. The endpoint now
 * takes `name` repeatedly and runs one TimescaleDB query (`name = ANY($n)`
 * against the `metrics`/`metrics_hourly` hypertable, ADR 0004), so the page
 * costs one scan, not one per metric.
 *
 * With a single request there is no partial progress to report, so there is no
 * counter here any more: it is one wait, and the loading state says so.
 */

/** Matches `WAKE_AFTER_MS` in `use-loader.ts` - one cold-start threshold, two callers. */
const WAKE_AFTER_MS = 1200;

export interface SeriesLoad {
  readonly phase: 'loading' | 'waking' | 'ready' | 'error';
  readonly results: SeriesResult[];
  readonly skippedLines: number;
  readonly error: ApiError | null;
  readonly elapsedSeconds: number;
  /**
   * Set when a "slide" (only `range` moved) fails; `results` keeps its last
   * good value and `phase` stays `ready` rather than flipping to `error`, so
   * a background refresh never blanks charts already on screen. Cleared on
   * the next successful load.
   */
  readonly refreshError: ApiError | null;
}

export interface SeriesRequest {
  readonly resource: string;
  readonly subResource?: string | undefined;
  readonly names: readonly string[];
  readonly range: TimeRange;
  readonly stepSeconds: number;
  readonly projectId?: string | undefined;
}

const IDLE: SeriesLoad = {
  phase: 'ready',
  results: [],
  skippedLines: 0,
  error: null,
  elapsedSeconds: 0,
  refreshError: null,
};

export function useSeries(request: SeriesRequest | null, attempt: number): SeriesLoad {
  const [load, setLoad] = useState<SeriesLoad>(IDLE);

  // Split from `range`: everything here staying the same while only the
  // range moves is what makes a request a "slide" rather than a real change
  // of what is being asked for.
  const identityKey = request
    ? JSON.stringify([
        request.resource,
        request.subResource ?? '',
        request.names,
        request.stepSeconds,
        request.projectId ?? '',
      ])
    : '';
  const rangeKey = request
    ? `${request.range.from.toISOString()}/${request.range.to.toISOString()}`
    : '';
  const key = `${identityKey}/${rangeKey}`;

  const phaseRef = useRef(load.phase);
  phaseRef.current = load.phase;
  const loadedIdentityRef = useRef<string | null>(null);

  useEffect(() => {
    if (!request || request.names.length === 0) {
      loadedIdentityRef.current = null;
      setLoad(IDLE);
      return;
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    // Only the range moved since the last successful load, against an
    // already-`ready` panel: fetch without touching what is on screen, so a
    // background slide never sweeps the charts back to a loading state.
    const slide = phaseRef.current === 'ready' && loadedIdentityRef.current === identityKey;

    let ticker: ReturnType<typeof setInterval> | null = null;

    if (!slide) {
      setLoad({
        phase: 'loading',
        results: [],
        skippedLines: 0,
        error: null,
        elapsedSeconds: 0,
        refreshError: null,
      });

      // A cold container answers in about a second; anything past that is
      // worth naming as a wake-up rather than leaving the page looking stuck.
      ticker = setInterval(() => {
        setLoad((current) =>
          current.phase === 'loading' || current.phase === 'waking'
            ? {
                ...current,
                phase: Date.now() - startedAt > WAKE_AFTER_MS ? 'waking' : 'loading',
                elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
              }
            : current,
        );
      }, 500);
    }

    fetchSeries(
      {
        resource: request.resource,
        subResource: request.subResource,
        names: request.names,
        from: request.range.from,
        to: request.range.to,
        stepSeconds: request.stepSeconds,
        projectId: request.projectId,
      },
      controller.signal,
    )
      .then((batch) => {
        if (controller.signal.aborted) return;
        loadedIdentityRef.current = identityKey;
        setLoad({
          phase: 'ready',
          results: batch.series,
          skippedLines: batch.skippedLines,
          error: null,
          elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
          refreshError: null,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const apiError = error instanceof ApiError ? error : new ApiError(null, String(error));
        if (slide) {
          setLoad((current) => ({ ...current, refreshError: apiError }));
        } else {
          setLoad({
            phase: 'error',
            results: [],
            skippedLines: 0,
            error: apiError,
            elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
            refreshError: null,
          });
        }
      })
      .finally(() => {
        if (ticker) clearInterval(ticker);
      });

    return () => {
      controller.abort();
      if (ticker) clearInterval(ticker);
    };
  }, [key, attempt]);

  return load;
}
