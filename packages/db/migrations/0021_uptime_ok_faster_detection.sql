-- uptime.ok: faster detection, user-accepted trade-off.
--
-- Supersedes 0020's inherited 900/0.9/0.8/2 (set manually, not by a
-- migration, documented in organizational/uptime-alerting.md's "Task 8"
-- section - this is the first time these columns move via a tracked
-- migration). At 900s/2 consecutive breaches, a real outage took two
-- full evaluator cycles over a 900s window to commit - up to ~15 minutes
-- from first failure to alert, and another ~15 to recovery. The user
-- explicitly accepted the trade-off below to cut that to one committed
-- cycle at a 300s window.
--
-- window_seconds 900 -> 300, consecutive_breaches 2 -> 1, critical_value
-- 0.8 -> 0.7, warning_value 0.9 -> NULL (drops the intermediate 'warning'
-- step entirely - see applications/evaluator/src/evaluate.ts's
-- candidateState: a null bound never matches, so direction='below' with
-- only critical_value set can only ever read 'ok' or 'critical').
--
-- Why 0.7 holds across the real sample-count jitter a 300s window sees at
-- the measured 1/minute cadence (nominally 5 samples, but a cycle that
-- runs slightly off the collector's schedule can see 4 or 6): avg() of
-- (N-1)/N for one failed check is 0.75/0.8/0.8333 at N=4/5/6, all >= 0.7
-- so a single flap stays 'ok'; avg() for two failed checks is
-- 0.5/0.6/0.6667 at N=4/5/6, all < 0.7 so two failures inside the window
-- always commit 'critical'. With consecutive_breaches=1, that commit
-- happens in the SAME evaluator cycle the candidate first differs from
-- the stored state (applyHysteresis: nextBreachCount = storedBreachCount
-- + 1 = 1 >= consecutiveBreaches, commits immediately) - no second cycle
-- to confirm, which is the detection-speed trade this migration ships.
-- Recovery is symmetric: the first cycle whose window again averages
-- >= 0.7 commits straight back to 'ok', also in one cycle.
--
-- Trade-off the user explicitly accepted: a 2-failure blip (e.g. a
-- container restart that fails exactly 2 consecutive checks before
-- coming back) now alerts immediately, with no second-cycle confirmation
-- to absorb it - the old 2-breach requirement is what used to filter
-- that case out. `applications/evaluator/tests/uptime-alerting.test.ts`
-- proves the new one-flap-silent / two-flaps-alert boundary holds at
-- 4/5/6 samples; it does not and cannot prove a 2-failure blip never
-- happens in production, only that this migration's thresholds make it
-- alert when it does.
--
-- Rollback: UPDATE thresholds SET warning_value = 0.9, critical_value =
-- 0.8, window_seconds = 900, consecutive_breaches = 2 WHERE
-- metric_name = 'uptime.ok' AND window_seconds = 300 AND
-- critical_value = 0.7 AND warning_value IS NULL AND
-- consecutive_breaches = 1;
--
-- WHERE below only touches rows still at the exact old tuned values, so
-- this is a no-op on a fresh CI database seeded directly at the new
-- values and never clobbers a row a human has since hand-tuned away from
-- 900/0.9/0.8/2.
UPDATE thresholds
   SET warning_value = NULL,
       critical_value = 0.7,
       window_seconds = 300,
       consecutive_breaches = 1
 WHERE metric_name = 'uptime.ok'
   AND window_seconds = 900
   AND warning_value = 0.9
   AND critical_value = 0.8
   AND consecutive_breaches = 2;
