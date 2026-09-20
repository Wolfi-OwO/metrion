import { useState } from 'react';
import {
  ApiError,
  createThreshold,
  deleteThreshold,
  fetchThresholds,
  updateThreshold,
  type ApplicationStatus,
  type Threshold,
  type ThresholdInput,
} from '../api/client.ts';
import { formatDuration } from '../lib/format.ts';
import { useLoader } from '../lib/use-loader.ts';
import {
  thresholdFormErrors,
  type ThresholdFormErrors,
  type ThresholdFormFields,
} from '../lib/validate.ts';
import { Field } from './field.tsx';
import { Button } from './states.tsx';

/**
 * Per-application and per-metric alert rules: direction, warning/critical
 * bounds (either optional), the evaluation window, the consecutive-breach
 * count and an enable toggle - what `POST`/`PATCH .../thresholds` accept
 * (`thresholds.schemas.ts`). `null` `applicationId` means "every application
 * in the project", the same meaning the column carries server-side.
 */

// Only for the controls `Field` doesn't cover - a `<select>` and the two
// number inputs whose hint/error swap rather than stack (`Field` always
// shows description and error together, which does not fit that toggle).
const CONTROL_CLASS =
  'min-h-11 w-full rounded-control border border-control bg-surface px-3 font-mono text-label text-ink md:min-h-9';

function fieldsFrom(threshold?: Threshold): ThresholdFormFields {
  return {
    metricName: threshold?.metricName ?? '',
    direction: threshold?.direction ?? 'above',
    warningValue: threshold?.warningValue?.toString() ?? '',
    criticalValue: threshold?.criticalValue?.toString() ?? '',
    consecutiveBreaches: (threshold?.consecutiveBreaches ?? 2).toString(),
    windowSeconds: (threshold?.windowSeconds ?? 300).toString(),
  };
}

// ponytail: `subResource` is schema-supported (a threshold can scope to one
// container/request-host rather than the whole application) but this form
// has no field for it - a new threshold always gets `null` (the whole
// application), and editing one preserves whatever it already had rather
// than clobbering it. The issue's own acceptance criteria never asks for
// sub-resource scoping, only application + metric. Add a field here if a
// threshold ever needs to watch one container inside an application rather
// than the application as a whole.
function toInput(
  fields: ThresholdFormFields,
  applicationId: string | null,
  subResource: string | null,
  enabled: boolean,
): ThresholdInput {
  const warning = fields.warningValue.trim();
  const critical = fields.criticalValue.trim();
  return {
    applicationId,
    subResource,
    metricName: fields.metricName.trim(),
    direction: fields.direction,
    warningValue: warning.length === 0 ? null : Number(warning),
    criticalValue: critical.length === 0 ? null : Number(critical),
    consecutiveBreaches: Number(fields.consecutiveBreaches),
    windowSeconds: Number(fields.windowSeconds),
    enabled,
  };
}

/**
 * One editor for both create and edit. `applicationId` is fixed once a
 * threshold exists (`updateThresholdSchema` has no such field at all -
 * reassigning which application a threshold covers is out of scope, see that
 * schema's own comment) so the picker only appears while creating.
 */
function ThresholdEditor({
  applications,
  existing,
  onSaved,
  onCancel,
  save,
}: {
  applications: readonly ApplicationStatus[];
  existing?: Threshold;
  onSaved: (threshold: Threshold) => void;
  onCancel: () => void;
  save: (input: ThresholdInput, signal: AbortSignal) => Promise<Threshold>;
}) {
  const [applicationId, setApplicationId] = useState<string>(existing?.applicationId ?? '');
  const [fields, setFields] = useState<ThresholdFormFields>(fieldsFrom(existing));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const errors: ThresholdFormErrors = thresholdFormErrors(fields);
  const touch = (name: string) => setTouched((current) => ({ ...current, [name]: true }));

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setTouched({
      metricName: true,
      criticalValue: true,
      consecutiveBreaches: true,
      windowSeconds: true,
    });
    if (Object.keys(errors).length > 0) return;

    setSubmitting(true);
    setSubmitError(null);
    const controller = new AbortController();
    save(
      toInput(
        fields,
        existing ? existing.applicationId : applicationId || null,
        existing?.subResource ?? null,
        enabled,
      ),
      controller.signal,
    )
      .then(onSaved)
      .catch((cause: unknown) => {
        setSubmitError(cause instanceof ApiError ? cause.message : 'Could not save the threshold.');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <form onSubmit={handleSubmit} className="border border-line-strong bg-raised p-4">
      {!existing && (
        <div className="mb-3 flex flex-col gap-1">
          <label htmlFor="threshold-application" className="text-label font-medium text-ink-2">
            Application
          </label>
          <select
            id="threshold-application"
            value={applicationId}
            onChange={(event) => setApplicationId(event.target.value)}
            className={CONTROL_CLASS}
          >
            <option value="">Whole project (every application)</option>
            {applications.map((app) => (
              <option key={app.id} value={app.id}>
                {app.displayName ?? app.key}
              </option>
            ))}
          </select>
        </div>
      )}
      {existing && (
        <p className="mb-3 text-label text-ink-2">
          Applies to{' '}
          <span className="font-mono text-ink">
            {existing.applicationId
              ? (applications.find((app) => app.id === existing.applicationId)?.displayName ??
                applications.find((app) => app.id === existing.applicationId)?.key ??
                existing.applicationId)
              : 'the whole project'}
          </span>
          . Which application a threshold covers cannot be changed after it is created - delete and
          re-create it under a different one if that is what is needed.
        </p>
      )}

      <div className="mb-3">
        <Field
          id="threshold-metric"
          label="Metric name"
          type="text"
          value={fields.metricName}
          onChange={(event) =>
            setFields((current) => ({ ...current, metricName: event.target.value }))
          }
          onBlur={() => touch('metricName')}
          error={touched.metricName ? (errors.metricName ?? null) : null}
        />
      </div>

      <fieldset className="mb-3 flex flex-col gap-2">
        <legend className="mb-1 text-label text-ink-2">Direction</legend>
        <label className="flex min-h-11 items-start gap-3 text-body text-ink md:min-h-0">
          <input
            type="radio"
            name="threshold-direction"
            value="above"
            checked={fields.direction === 'above'}
            onChange={() => setFields((current) => ({ ...current, direction: 'above' }))}
            className="mt-1 h-4 w-4 accent-accent"
          />
          <span>
            <span className="font-medium">Above</span> - alert when the value goes above the
            threshold.
          </span>
        </label>
        <label className="flex min-h-11 items-start gap-3 text-body text-ink md:min-h-0">
          <input
            type="radio"
            name="threshold-direction"
            value="below"
            checked={fields.direction === 'below'}
            onChange={() => setFields((current) => ({ ...current, direction: 'below' }))}
            className="mt-1 h-4 w-4 accent-accent"
          />
          <span>
            <span className="font-medium">Below</span> - alert when the value goes below the
            threshold. Use this for anything where low is the problem, like free memory or a request
            rate that dropped to zero.
          </span>
        </label>
      </fieldset>

      <div className="mb-3 grid grid-cols-2 gap-3">
        <Field
          id="threshold-warning"
          label="Warning value (optional)"
          type="number"
          step="any"
          value={fields.warningValue}
          onChange={(event) =>
            setFields((current) => ({ ...current, warningValue: event.target.value }))
          }
          onBlur={() => touch('criticalValue')}
        />
        <Field
          id="threshold-critical"
          label="Critical value (optional)"
          type="number"
          step="any"
          value={fields.criticalValue}
          onChange={(event) =>
            setFields((current) => ({ ...current, criticalValue: event.target.value }))
          }
          onBlur={() => touch('criticalValue')}
          error={touched.criticalValue ? (errors.criticalValue ?? null) : null}
        />
        <p className="col-span-2 text-meta leading-relaxed text-ink-3">
          Leave a bound empty to skip alerting at that severity - a warning-only threshold with no
          critical value is fine.
        </p>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label htmlFor="threshold-window" className="text-label font-medium text-ink-2">
            Evaluation window (seconds)
          </label>
          <input
            id="threshold-window"
            type="number"
            step="1"
            value={fields.windowSeconds}
            onChange={(event) =>
              setFields((current) => ({ ...current, windowSeconds: event.target.value }))
            }
            onBlur={() => touch('windowSeconds')}
            aria-invalid={touched.windowSeconds && !!errors.windowSeconds}
            aria-describedby={
              touched.windowSeconds && errors.windowSeconds
                ? 'threshold-window-error'
                : 'threshold-window-hint'
            }
            className={CONTROL_CLASS}
          />
          {!errors.windowSeconds && Number.isFinite(Number(fields.windowSeconds)) && (
            <p id="threshold-window-hint" className="text-meta text-ink-3">
              {formatDuration(Math.round(Number(fields.windowSeconds)))}
            </p>
          )}
          {touched.windowSeconds && errors.windowSeconds && (
            <p id="threshold-window-error" role="alert" className="text-label text-text-danger">
              {errors.windowSeconds}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="threshold-breaches" className="text-label font-medium text-ink-2">
            Consecutive breaches before alerting
          </label>
          <input
            id="threshold-breaches"
            type="number"
            step="1"
            value={fields.consecutiveBreaches}
            onChange={(event) =>
              setFields((current) => ({ ...current, consecutiveBreaches: event.target.value }))
            }
            onBlur={() => touch('consecutiveBreaches')}
            aria-invalid={touched.consecutiveBreaches && !!errors.consecutiveBreaches}
            aria-describedby={
              touched.consecutiveBreaches && errors.consecutiveBreaches
                ? 'threshold-breaches-error'
                : undefined
            }
            className={CONTROL_CLASS}
          />
          {touched.consecutiveBreaches && errors.consecutiveBreaches && (
            <p id="threshold-breaches-error" role="alert" className="text-label text-text-danger">
              {errors.consecutiveBreaches}
            </p>
          )}
        </div>
      </div>

      <label className="mb-4 flex min-h-11 items-center gap-3 text-body text-ink md:min-h-0">
        <input
          className="h-4 w-4 accent-accent"
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enabled
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={submitting}>
          {submitting ? 'Saving…' : existing ? 'Save changes' : 'Create threshold'}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {submitError && (
        <p role="alert" className="mt-2 text-label text-text-danger">
          {submitError}
        </p>
      )}
    </form>
  );
}

function ThresholdRow({
  threshold,
  applications,
  editing,
  onEdit,
  onSaved,
  onCancel,
  onDeleted,
}: {
  threshold: Threshold;
  applications: readonly ApplicationStatus[];
  editing: boolean;
  onEdit: () => void;
  onSaved: (threshold: Threshold) => void;
  onCancel: () => void;
  onDeleted: (id: string) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const applicationLabel = threshold.applicationId
    ? (applications.find((app) => app.id === threshold.applicationId)?.displayName ??
      applications.find((app) => app.id === threshold.applicationId)?.key ??
      threshold.applicationId)
    : 'Whole project';

  const bound = (value: number | null) => (value === null ? 'unset' : value);

  const handleDelete = () => {
    setDeleting(true);
    setDeleteError(null);
    const controller = new AbortController();
    deleteThreshold(threshold.id, controller.signal)
      .then(() => onDeleted(threshold.id))
      .catch((cause: unknown) => {
        setDeleteError(
          cause instanceof ApiError ? cause.message : 'Could not delete the threshold.',
        );
      })
      .finally(() => setDeleting(false));
  };

  if (editing) {
    return (
      <li className="p-4">
        <ThresholdEditor
          applications={applications}
          existing={threshold}
          onSaved={onSaved}
          onCancel={onCancel}
          save={(input, signal) =>
            updateThreshold(
              threshold.id,
              {
                subResource: input.subResource,
                metricName: input.metricName,
                direction: input.direction,
                warningValue: input.warningValue,
                criticalValue: input.criticalValue,
                consecutiveBreaches: input.consecutiveBreaches,
                windowSeconds: input.windowSeconds,
                enabled: input.enabled,
              },
              signal,
            )
          }
        />
      </li>
    );
  }

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-body text-ink">
          <span className="font-mono text-label">{threshold.metricName}</span>{' '}
          <span className="text-ink-2">
            goes {threshold.direction}{' '}
            <span className="text-status-warning">{bound(threshold.warningValue)}</span> warning,{' '}
            <span className="text-status-critical">{bound(threshold.criticalValue)}</span> critical
          </span>
        </p>
        <p className="mt-1 text-label text-ink-3">
          {applicationLabel} · every {formatDuration(threshold.windowSeconds)},{' '}
          {threshold.consecutiveBreaches} consecutive{' '}
          {threshold.consecutiveBreaches === 1 ? 'breach' : 'breaches'} ·{' '}
          {threshold.enabled ? 'enabled' : 'disabled'}
        </p>
        {deleteError && (
          <p role="alert" className="mt-1 text-label text-text-danger">
            {deleteError}
          </p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="quiet" onClick={onEdit}>
          Edit
        </Button>
        <Button variant="quiet" tone="danger" onClick={handleDelete} loading={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </Button>
      </div>
    </li>
  );
}

export function ThresholdPanel({
  projectId,
  applications,
}: {
  projectId: string;
  applications: readonly ApplicationStatus[];
}) {
  const loader = useLoader(`thresholds/${projectId}`, (signal) =>
    fetchThresholds(projectId, signal),
  );
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [rows, setRows] = useState<Threshold[] | null>(null);

  // `rows` starts `null` and is seeded from the first successful load; after
  // that, creates/edits/deletes below update it directly so a save does not
  // need a second round trip just to show its own result.
  const seeded = rows ?? loader.data;
  const list = seeded ?? [];

  return (
    <div>
      {loader.phase === 'error' && loader.error && (
        <p role="alert" className="text-body text-text-danger">
          {loader.error.message}
        </p>
      )}
      {(loader.phase === 'loading' || loader.phase === 'waking') && (
        <p className="text-body text-ink-2">Loading thresholds…</p>
      )}

      {seeded && (
        <>
          {list.length === 0 && !creating && (
            <p className="text-body text-ink-2">
              No thresholds yet. Every application answers "OK" until one is created for it.
            </p>
          )}

          {list.length > 0 && (
            <ul className="divide-y divide-line overflow-hidden rounded-surface border border-line bg-surface">
              {list.map((threshold) => (
                <ThresholdRow
                  key={threshold.id}
                  threshold={threshold}
                  applications={applications}
                  editing={editingId === threshold.id}
                  onEdit={() => setEditingId(threshold.id)}
                  onCancel={() => setEditingId(null)}
                  onSaved={(saved) => {
                    setRows(list.map((row) => (row.id === saved.id ? saved : row)));
                    setEditingId(null);
                  }}
                  onDeleted={(id) => setRows(list.filter((row) => row.id !== id))}
                />
              ))}
            </ul>
          )}

          {creating ? (
            <div className="mt-4">
              <ThresholdEditor
                applications={applications}
                onCancel={() => setCreating(false)}
                onSaved={(saved) => {
                  setRows([...list, saved]);
                  setCreating(false);
                }}
                save={(input, signal) => createThreshold(projectId, input, signal)}
              />
            </div>
          ) : (
            <Button className="mt-4" onClick={() => setCreating(true)}>
              New threshold
            </Button>
          )}
        </>
      )}
    </div>
  );
}
