import type { InputHTMLAttributes } from 'react';

/**
 * label + input + description + error - the block this app already had
 * right, by hand, in three places (`dashboard.tsx`'s project-name field,
 * `project-status.tsx`'s application key and display-name fields): a real
 * `<label>` tied to the input via `htmlFor`/`id`, never a placeholder
 * standing in for one, and the error wired to the input through
 * `aria-invalid` plus `aria-describedby` so a screen reader gets it without
 * a second, separate announcement. `aria-invalid` is always present (`true`
 * or `false`), matching what all three call sites already did - a screen
 * reader that only ever hears the attribute when it is invalid cannot tell
 * "valid" from "never checked".
 */
export function Field({
  id,
  label,
  description,
  error = null,
  inputClassName = '',
  ...inputProps
}: {
  id: string;
  label: string;
  description?: string;
  error?: string | null;
  inputClassName?: string;
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'className'>) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [descriptionId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-label text-ink-dim">
        {label}
      </label>
      {description && (
        <p id={descriptionId} className="text-meta text-ink-muted">
          {description}
        </p>
      )}
      <input
        id={id}
        aria-invalid={error != null}
        aria-describedby={describedBy}
        className={`rounded-control border border-line-strong bg-bg-800 px-2.5 py-1.5 font-mono text-body text-ink ${inputClassName}`}
        {...inputProps}
      />
      {error && (
        <p id={errorId} role="alert" className="text-label text-text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
