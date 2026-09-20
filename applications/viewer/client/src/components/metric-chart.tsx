import { useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import type { ChartGroup, SeriesView } from '../lib/groups.ts';
import {
  formatAxisValue,
  formatTick,
  formatTimestamp,
  formatValue,
  niceAxis,
} from '../lib/format.ts';
import type { GridRow, TimeRange } from '../lib/range.ts';

/**
 * One unit, one chart, drawn as a strip on a time axis shared with every other
 * chart on the page rather than as a card in a grid.
 *
 * The shared axis is the whole point: the question this tool answers is "what
 * else was happening when CPU spiked", and that is a question about one
 * instant read across several measurements. Cards with their own axes make
 * that a manual alignment job. `syncId` extends the same idea to the cursor -
 * hovering any strip moves the crosshair on all of them.
 */

const STROKE_WIDTH = 1.5;

// 24px wide, not 16: the longest dash pattern in SERIES_DASHES ("9 3 2 3")
// repeats every 17px, so a 16px swatch cut it mid-cycle and the dash-dot
// series read as a plain dash - the same mark as a neighbour. 24px clears
// every pattern's full repeat with room to spare, so the swatch carries the
// same shape distinction the polyline does.
function SeriesSwatch({ series }: { series: SeriesView }) {
  return (
    <svg
      width="24"
      height="8"
      viewBox="0 0 24 8"
      aria-hidden="true"
      className="shrink-0 self-center"
    >
      <line
        x1="0"
        y1="4"
        x2="24"
        y2="4"
        stroke={series.color}
        strokeWidth="2"
        strokeDasharray={series.dash}
      />
    </svg>
  );
}

function ChartTooltip({
  active,
  label,
  payload,
  unit,
  series,
}: TooltipContentProps & { unit: string | null; series: SeriesView[] }) {
  if (!active || payload.length === 0) return null;

  return (
    // This is the one popover-level surface in the chart - floating over a
    // busy strip of lines, not a card on an empty page - so it is the second
    // real user of `--shadow-raised`, the app's one elevation step, rather
    // than a fresh value invented for it.
    <div className="rounded-control border border-line-strong bg-surface px-3 py-2 text-meta shadow-popover">
      <div className="mb-2 font-mono text-ink-2">
        {typeof label === 'number' ? formatTimestamp(label) : ''}
      </div>
      {payload.map((entry) => {
        const match = series.find((candidate) => candidate.name === entry.name);
        return (
          <div
            key={String(entry.name)}
            className="flex items-baseline gap-2 [&:not(:last-child)]:mb-1"
          >
            {match && <SeriesSwatch series={match} />}
            <span className="font-mono text-ink-2">{entry.name}</span>
            {/* Muted and un-bolded rather than the same weight as a real
                reading - "no sample" naming the gap is only honest if it also
                looks unlike the number next to it. */}
            <span
              className={`ml-auto font-mono ${typeof entry.value === 'number' ? 'text-ink' : 'text-ink-3 italic'}`}
            >
              {typeof entry.value === 'number' ? formatValue(entry.value, unit) : 'no sample'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** What a screen reader gets instead of the polyline. */
function describe(group: ChartGroup): string {
  const unit = group.unit ?? 'no unit';
  const parts = group.series.map((series) => {
    const range =
      series.min !== null && series.max !== null
        ? `from ${formatValue(series.min, group.unit)} to ${formatValue(series.max, group.unit)}`
        : 'no readings';
    const gaps =
      series.missing > 0
        ? `, ${series.missing} ${series.missing === 1 ? 'bucket' : 'buckets'} with no sample`
        : '';
    const last = series.last !== null ? `, last ${formatValue(series.last, group.unit)}` : '';
    const unitOf = series.samples === 1 ? 'bucket' : 'buckets';
    return `${series.name}: ${series.samples} ${unitOf}, ${range}${last}${gaps}`;
  });
  return `${unit}. ${parts.join('. ')}.`;
}

/**
 * An x-axis label that cannot poke out of the plot: the first is left-aligned
 * to its tick, the last right-aligned, the rest centred. The default centred
 * label on the final tick ran 20px past the right edge of every strip.
 */
function TimeTick({
  x,
  y,
  payload,
  index,
  visibleTicksCount,
  tickFormatter,
}: {
  x?: number;
  y?: number;
  payload?: { value: number };
  index?: number;
  visibleTicksCount?: number;
  tickFormatter?: (value: number) => string;
}) {
  if (payload === undefined || x === undefined || y === undefined) return null;
  const last = (visibleTicksCount ?? 0) - 1;
  const anchor = index === 0 ? 'start' : index === last ? 'end' : 'middle';
  return (
    <text
      x={x}
      y={y + 14}
      textAnchor={anchor}
      fill="var(--color-ink-3)"
      fontSize="var(--text-meta)"
      fontFamily="var(--font-mono)"
    >
      {tickFormatter ? tickFormatter(payload.value) : payload.value}
    </text>
  );
}

export function MetricChart({
  group,
  range,
  showAxis,
}: {
  group: ChartGroup;
  range: TimeRange;
  showAxis: boolean;
}) {
  const spanMs = range.to.getTime() - range.from.getTime();
  // Hiding a series is a reading aid (a noisy neighbour drowns a quiet line),
  // not a filter: the numbers, the axis and the screen-reader text keep
  // covering every series, and the choice is per strip and not remembered.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const visibleMax = Math.max(
    0,
    ...group.rows.flatMap((row) =>
      group.series
        .filter((series) => !hidden.has(series.name))
        .map((series) => row.values[series.name] ?? 0),
    ),
  );
  const axis = niceAxis(group.unit, hidden.size === 0 ? group.max : visibleMax);
  const single = group.series.length === 1 ? group.series[0] : undefined;

  const toggle = (name: string) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else if (next.size < group.series.length - 1) next.add(name);
      return next;
    });

  return (
    <section className="border-t border-line py-4 first:border-t-0">
      <header className="page flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h2 className="font-mono text-label font-medium tracking-eyebrow text-ink-2 uppercase">
          {group.unit ?? 'unitless'}
        </h2>
        <ul className="flex flex-wrap items-baseline gap-x-2 gap-y-0">
          {group.series.map((series) => {
            const off = hidden.has(series.name);
            return (
              <li key={series.name}>
                {/* A button, so the legend is also the control: a chip that
                    names the series, shows its last reading and its range, and
                    hides its line on click. `whitespace-nowrap` keeps "4 330
                    MiB" from breaking between the number and its unit. */}
                <button
                  type="button"
                  onClick={() => toggle(series.name)}
                  aria-pressed={!off}
                  className={`flex min-h-11 items-center gap-2 rounded-control px-2 whitespace-nowrap transition-colors hover:bg-raised md:min-h-7 ${
                    off ? 'opacity-45' : ''
                  }`}
                >
                  <SeriesSwatch series={series} />
                  <span className="font-mono text-label text-ink-2">{series.name}</span>
                  <span className="font-mono text-label font-medium text-ink">
                    {series.last === null ? '-' : formatValue(series.last, group.unit)}
                  </span>
                  {series.min !== null && series.max !== null && series.min !== series.max && (
                    <span className="hidden font-mono text-label text-ink-3 sm:inline">
                      {formatValue(series.min, group.unit)} to {formatValue(series.max, group.unit)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </header>

      {/* The numbers behind the polyline, in browse-mode-readable markup.
          The svg <title> above names the chart; this carries the readings. */}
      <p className="sr-only">{describe(group)}</p>

      <div className={`page ${showAxis ? 'h-44' : 'h-36'}`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={group.rows}
            syncId="metrion-timeline"
            // `accessibilityLayer` makes the chart a focusable
            // role="application" the arrow keys walk through - and, on its
            // own, an unnamed one. `title` renders the <title> inside the svg,
            // which gives that stop its accessible name and names the series
            // rather than leaving them identified by colour.
            accessibilityLayer
            title={`${group.unit ?? 'unitless'} over time: ${group.series
              .map((series) => series.name)
              .join(', ')}`}
            // The margins are identical on every strip, including the ones
            // with a hidden axis: the plot areas have to start and end at the
            // same x or reading a spike down the stack stops working.
            margin={{ top: 8, right: 4, bottom: 8, left: 0 }}
          >
            <CartesianGrid stroke="var(--color-line)" strokeDasharray="0" vertical={false} />

            {/* Stretches where nothing arrived from anything in this group. Drawn
                under the lines so a band never hides a reading, and repeated on
                every strip so an outage reads as one vertical column down the
                whole page. */}
            {group.bands.map((band) => (
              <ReferenceArea
                key={band.from}
                x1={band.from}
                x2={band.to}
                fill="var(--color-surface)"
                fillOpacity={1}
                stroke="none"
                ifOverflow="hidden"
                // Named once, on the strip that carries the time axis, and
                // only where the band is wide enough to hold the words. A
                // shaded region alone is a convention; the words are a fact,
                // and without them a reader can as easily take the shading for
                // a selection as for an absence.
                label={
                  showAxis && band.to - band.from > spanMs * 0.08
                    ? {
                        value: 'no samples',
                        position: 'insideBottom',
                        fill: 'var(--color-ink-3)',
                        fontSize: 'var(--text-meta)',
                        fontFamily: 'var(--font-mono)',
                      }
                    : undefined
                }
              />
            ))}

            <XAxis
              dataKey="t"
              type="number"
              scale="time"
              domain={[range.from.getTime(), range.to.getTime()]}
              hide={!showAxis}
              tickFormatter={(value: number) => formatTick(value, spanMs)}
              tick={<TimeTick />}
              tickLine={false}
              axisLine={{ stroke: 'var(--color-line)' }}
              // `formatTick`'s longest label is "Wed 14:32" - 9 mono characters,
              // about 65px at 12px. 72 keeps two adjacent weekday ticks apart.
              minTickGap={72}
            />
            <YAxis
              // Fixed, and the same on every strip, so the plot areas line up.
              // 64 fits the widest label this formatter produces ("512 MiB").
              width={64}
              interval={0}
              domain={[0, axis.max]}
              ticks={axis.ticks}
              tickFormatter={(value: number) => formatAxisValue(value, group.unit)}
              tick={{
                fill: 'var(--color-ink-3)',
                fontSize: 'var(--text-meta)',
                fontFamily: 'var(--font-mono)',
              }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip
              cursor={{ stroke: 'var(--color-control)', strokeWidth: 1 }}
              // 24px off the cursor, so the box sits beside the reading it
              // describes instead of over the next few samples of the line.
              offset={24}
              wrapperStyle={{ zIndex: 20, pointerEvents: 'none' }}
              content={(props: TooltipContentProps) => (
                <ChartTooltip {...props} unit={group.unit} series={group.series} />
              )}
            />

            {/* One series gets a faint fill under it: with nothing to compare
                against, the area is what makes a lone line read as a level. */}
            {single && !hidden.has(single.name) && (
              <Area
                type="linear"
                name={single.name}
                dataKey={(row: GridRow) => row.values[single.name]}
                stroke="none"
                fill={single.color}
                fillOpacity={0.08}
                isAnimationActive={false}
                connectNulls={false}
                activeDot={false}
                legendType="none"
                tooltipType="none"
              />
            )}
            {group.series.map((series) =>
              hidden.has(series.name) ? null : (
                <Line
                  key={series.name}
                  type="linear"
                  name={series.name}
                  dataKey={(row: GridRow) => row.values[series.name]}
                  stroke={series.color}
                  strokeWidth={STROKE_WIDTH}
                  strokeDasharray={series.dash}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  // Off deliberately: a line that draws itself on every
                  // progressive arrival is motion that says nothing about what
                  // changed, and there are up to eight of them.
                  isAnimationActive={false}
                  // A bucket with no sample is a hole in the line, never a
                  // zero and never a straight segment drawn across it.
                  connectNulls={false}
                />
              ),
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
