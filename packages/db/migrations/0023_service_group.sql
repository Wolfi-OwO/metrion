-- service_group(): one logical service out of its blue/green colour and pod
-- replicas.
--
-- Bug this fixes: a blue/green app has ONE live container at a time, so the
-- idle colour stops reporting. The evaluator treated each sub_resource as its
-- own thing, so the idle colour's threshold_status row went critical/no_data
-- and stayed there (fuwwy-platform sat at Critical for a day because
-- `preussen-dashboard-green-1` had been swapped out), while the viewer listed
-- blue and green as two separate dashboards.
--
-- `container:preussen-dashboard-blue-1` -> `container:preussen-dashboard`,
-- `container:nutrilens-nutrilens-ai-1`  -> `container:nutrilens-nutrilens-ai`.
-- Only `container:` names are touched: a `requests:<host>` name can legally
-- end in digits. Evaluator and viewer both group by this one function so the
-- two cannot disagree on what a "service" is.
CREATE FUNCTION service_group(sub text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN sub LIKE 'container:%'
      THEN regexp_replace(sub, '(-(blue|green))?(-[0-9]+)?$', '')
    ELSE sub
  END
$$;

-- Thresholds written per colour/replica (nutrilens, portfolio) collapse into
-- one per group. Keep the lowest id; the rest would evaluate the same series
-- twice and double every alert. threshold_status/status_events cascade.
DELETE FROM thresholds t
 USING thresholds k
 WHERE t.sub_resource IS NOT NULL
   AND t.project_id = k.project_id
   AND t.application_id IS NOT DISTINCT FROM k.application_id
   AND t.metric_name = k.metric_name
   AND service_group(t.sub_resource) = service_group(k.sub_resource)
   AND t.id > k.id;

UPDATE thresholds SET sub_resource = service_group(sub_resource)
 WHERE sub_resource IS NOT NULL AND sub_resource <> service_group(sub_resource);

-- Status rows keyed by an individual colour/pod are stale by definition (the
-- evaluator now keys by group). Dropping them lets the next cycle recreate one
-- row per group from live data; status_events keep the history.
DELETE FROM threshold_status
 WHERE sub_resource_key <> '' AND sub_resource_key <> service_group(sub_resource_key);
