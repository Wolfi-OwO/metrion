import type { ResourceSummary } from '../api/client.ts';
import { ScopeIcon, type ScopeIconId } from './icon.tsx';

/**
 * Server first, then what runs on it.
 *
 * Two controls, not one, because they answer two different questions: which
 * machine am I looking at, and which part of it. The single flat list this
 * replaced put `container:preussen-mongo` next to
 * `requests:www.woofi-developments.at` in one alphabetical run, so finding an
 * app meant reading past every request host.
 *
 * Sub-resources carry their kind as a `type:name` prefix (`container:`,
 * `requests:`, and the bare `collector`), which is exactly an `<optgroup>`:
 * the prefix becomes the group heading and the option shows the plain name.
 * The same prefix picks the `ScopeIcon` shown beside each select, so the
 * icon is a second, non-colour channel for "what kind of thing is this",
 * not decoration.
 *
 * Native `<select>` over a custom menu because the browser already gives this
 * keyboard support, type-ahead, a popup that escapes the header, and correct
 * behaviour on a phone.
 *
 * This is the toolbar's primary control - "which server am I looking at" is
 * the first question every other reading on this screen depends on - so it
 * gets the label-above-control shape `Field` uses for a real form control,
 * not the inline "label: value" chip `RangeControl` uses for a secondary one.
 */

export interface Selection {
  readonly resource: string;
  readonly subResource?: string | undefined;
}

/** Heading for each prefix, in the order the groups should appear. */
const KIND_LABELS: ReadonlyArray<readonly [prefix: string, label: string]> = [
  ['container:', 'Apps'],
  ['requests:', 'Request hosts'],
];

// Mirrors `Field`'s input styling exactly (`rounded-control`, `px-2.5 py-1.5`,
// `font-mono text-body`) - the two primary controls on this screen share one
// control language, plus the truncation and hover this one needs for a value
// that can be a full hostname.
const SELECT_CLASS =
  'max-w-[16rem] truncate rounded-control border border-line-strong bg-bg-800 px-2.5 py-1.5 font-mono text-body text-ink transition-colors duration-(--duration-fast) hover:border-ink-muted';

/** Which `ScopeIcon` a sub-resource's prefix stands for; `host` covers the
 * whole-server option and anything with no recognised prefix. */
function scopeIconFor(subResource: string | undefined): ScopeIconId {
  if (subResource?.startsWith('container:')) return 'container';
  if (subResource?.startsWith('requests:')) return 'request';
  return 'host';
}

/** `container:preussen-mongo` -> `preussen-mongo`. */
function plainName(subResource: string, prefix: string): string {
  return subResource.slice(prefix.length);
}

export function ResourcePicker({
  resources,
  value,
  onChange,
}: {
  resources: readonly ResourceSummary[];
  value: Selection;
  onChange: (next: Selection) => void;
}) {
  const entry = resources.find((candidate) => candidate.resource === value.resource);
  const subResources = entry?.subResources ?? [];

  const grouped = KIND_LABELS.map(([prefix, label]) => ({
    prefix,
    label,
    items: subResources.filter((sub) => sub.startsWith(prefix)),
  })).filter((group) => group.items.length > 0);

  // Anything with no recognised prefix - `collector` today - still has to be
  // reachable, or a sub-resource would silently disappear from the picker the
  // moment a sender invents a new kind.
  const ungrouped = subResources.filter(
    (sub) => !KIND_LABELS.some(([prefix]) => sub.startsWith(prefix)),
  );

  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
      <div className="flex flex-col gap-1">
        <label htmlFor="server-picker" className="text-label text-ink-dim">
          Server
        </label>
        <div className="flex items-center gap-1.5">
          <ScopeIcon id="host" />
          <select
            id="server-picker"
            value={value.resource}
            onChange={(event) => onChange({ resource: event.target.value })}
            className={SELECT_CLASS}
          >
            {resources.map((candidate) => (
              <option key={candidate.resource} value={candidate.resource}>
                {candidate.resource}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="scope-picker" className="text-label text-ink-dim">
          Showing
        </label>
        <div className="flex items-center gap-1.5">
          <ScopeIcon id={scopeIconFor(value.subResource)} />
          <select
            id="scope-picker"
            value={value.subResource ?? ''}
            onChange={(event) =>
              onChange({
                resource: value.resource,
                subResource: event.target.value === '' ? undefined : event.target.value,
              })
            }
            className={SELECT_CLASS}
          >
            {/* The whole machine: the host-level envelope, which is what the
                collector writes with no sub-resource at all. */}
            <option value="">Whole server</option>

            {grouped.map((group) => (
              <optgroup key={group.prefix} label={group.label}>
                {group.items.map((sub) => (
                  <option key={sub} value={sub}>
                    {plainName(sub, group.prefix)}
                  </option>
                ))}
              </optgroup>
            ))}

            {ungrouped.length > 0 && (
              <optgroup label="Other">
                {ungrouped.map((sub) => (
                  <option key={sub} value={sub}>
                    {sub}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
      </div>
    </div>
  );
}
