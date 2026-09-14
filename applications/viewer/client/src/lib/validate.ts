/**
 * Client-side mirrors of the server's own zod constraints
 * (`applications/viewer/src/schemas/projects.schemas.ts`), for feedback
 * before a round trip. The server re-validates on every request regardless -
 * this exists to fix a mistake before it is submitted, not to replace that
 * check.
 */
export function projectNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a name for the project.';
  if (trimmed.length > 200) return 'Keep the name under 200 characters.';
  return null;
}

/** Mirrors `applicationKey` in `applications.schemas.ts` - it is the value
 * written to `metrics.resource`, so the charset has to match what a
 * collector can actually send. */
const APPLICATION_KEY = /^[A-Za-z0-9._:-]+$/;

export function applicationKeyError(key: string): string | null {
  const trimmed = key.trim();
  if (trimmed.length === 0) return 'Enter a key for the application.';
  if (trimmed.length > 200) return 'Keep the key under 200 characters.';
  if (!APPLICATION_KEY.test(trimmed)) {
    return 'Only letters, digits, dot, underscore, colon and hyphen are allowed.';
  }
  return null;
}

export function applicationNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return 'Enter a display name for the application.';
  if (trimmed.length > 200) return 'Keep the name under 200 characters.';
  return null;
}

/**
 * Mirrors `baseThresholdShape` and `thresholdBoundsIssue` in
 * `thresholds.schemas.ts`. Every field here is the raw string an
 * `<input type="number">`/`<input type="text">` holds, not yet parsed -
 * these are blur/submit-time messages, not a parser; `threshold-panel.tsx`
 * parses the same strings into the `ThresholdInput` the API actually wants
 * once they pass.
 */
export interface ThresholdFormFields {
  readonly metricName: string;
  readonly direction: 'above' | 'below';
  readonly warningValue: string;
  readonly criticalValue: string;
  readonly consecutiveBreaches: string;
  readonly windowSeconds: string;
}

export interface ThresholdFormErrors {
  metricName?: string;
  criticalValue?: string;
  consecutiveBreaches?: string;
  windowSeconds?: string;
}

function parsedOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : Number(trimmed);
}

export function thresholdFormErrors(fields: ThresholdFormFields): ThresholdFormErrors {
  const errors: ThresholdFormErrors = {};

  const metricName = fields.metricName.trim();
  if (metricName.length === 0) errors.metricName = 'Enter the metric name to watch.';
  else if (metricName.length > 200)
    errors.metricName = 'Keep the metric name under 200 characters.';

  const warning = parsedOrNull(fields.warningValue);
  const critical = parsedOrNull(fields.criticalValue);
  if (warning === null && critical === null) {
    errors.criticalValue = 'Set a warning value, a critical value, or both.';
  } else if (warning !== null && critical !== null) {
    const ordered = fields.direction === 'above' ? critical >= warning : critical <= warning;
    if (!ordered) {
      errors.criticalValue =
        fields.direction === 'above'
          ? 'The critical value must be greater than or equal to the warning value for "above".'
          : 'The critical value must be less than or equal to the warning value for "below".';
    }
  }

  const breaches = parsedOrNull(fields.consecutiveBreaches);
  if (breaches === null || !Number.isInteger(breaches) || breaches < 1 || breaches > 10) {
    errors.consecutiveBreaches = 'Enter a whole number from 1 to 10.';
  }

  const window = parsedOrNull(fields.windowSeconds);
  if (window === null || !Number.isInteger(window) || window < 60 || window > 86_400) {
    errors.windowSeconds = 'Enter a whole number of seconds from 60 to 86400 (24 hours).';
  }

  return errors;
}
