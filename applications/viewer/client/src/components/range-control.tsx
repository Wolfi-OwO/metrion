import { RANGE_PRESETS, type RangePreset } from '../lib/range.ts';

/**
 * Built from real radio inputs, so left/right arrow keys, roving focus and the
 * "one of a group" announcement all come from the browser instead of being
 * re-implemented with `role="radiogroup"` and a key handler. The inputs are
 * visually hidden, not `display: none` - a hidden input is not focusable, and
 * the focus ring is drawn on the label text beside it by the one focus rule in
 * `styles/index.css`, so this control cannot drift away from the rest.
 *
 * Presets only. Every one of them is inside the API's 31-day cap, so no
 * interaction with this control can produce a request the server rejects.
 */
export function RangeControl({
  value,
  onChange,
}: {
  value: RangePreset;
  onChange: (next: RangePreset) => void;
}) {
  return (
    <fieldset className="flex items-center gap-1 rounded-control bg-raised p-1">
      <legend className="sr-only">Time range</legend>
      {RANGE_PRESETS.map((preset) => {
        const selected = preset.id === value.id;
        return (
          <label key={preset.id} className="relative">
            <input
              type="radio"
              name="range"
              value={preset.id}
              checked={selected}
              onChange={() => onChange(preset)}
              // The label's own text is "7d", which a screen reader cannot
              // expand. The name goes on the input, where it is reliably the
              // accessible name, not on a span, where it is not.
              aria-label={preset.description}
              className="peer sr-only"
            />
            <span
              className={`flex min-h-9 min-w-11 cursor-pointer items-center justify-center rounded-control px-3 font-mono text-label transition-colors md:min-h-7 md:min-w-0 ${
                selected ? 'bg-surface font-medium text-ink' : 'text-ink-2 hover:text-ink'
              }`}
            >
              {preset.label}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
