import { useEffect, useRef, useState } from 'react';

/**
 * 60 s, matching the real cadence every screen this drives is reporting on -
 * polling faster would never show a newer answer, slower would visibly lag
 * behind it:
 * - checker cron: `portfolio-webpage/application/jobs/src/functions/checkMonitors.js:325`,
 *   `schedule: process.env.CHECK_SCHEDULE || '0 * * * * *'` - once a minute.
 * - `metrion-evaluator.timer`: `OnCalendar=*-*-* *:*:00` - once a minute
 *   (`docs/adr/0006-applications-dependencies-and-alerting.md:114`).
 * - agent collector timer: same `OnCalendar=*-*-* *:*:00`.
 */
export const REFRESH_MS = 60_000;

/**
 * A counter that increments every `ms` while the tab is visible, for a
 * caller to `useEffect` on and trigger a background reload. One timer per
 * page is the point: every screen that polls owns exactly one of these and
 * fans its own tick out to whatever else on the page needs a refresh,
 * instead of each panel running its own `setInterval`.
 *
 * Paused while the tab is hidden - polling a backgrounded tab wastes the
 * request. On return to visible, ticks once immediately if a full interval
 * has already elapsed since the last one, so a tab left backgrounded for an
 * hour catches up in a single request instead of waiting out a fresh
 * interval first; the regular interval then restarts from that moment.
 */
export function useRefreshTick(ms = REFRESH_MS): number {
  const [tick, setTick] = useState(0);
  const lastTickAt = useRef(Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      timer = setInterval(() => {
        lastTickAt.current = Date.now();
        setTick((value) => value + 1);
      }, ms);
    };

    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stop();
        return;
      }
      if (Date.now() - lastTickAt.current >= ms) {
        lastTickAt.current = Date.now();
        setTick((value) => value + 1);
      }
      stop();
      start();
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [ms]);

  return tick;
}
