/**
 * A hand-built sparkline: a polyline through 24 hourly sample counts. No chart
 * library, because this is one path in a 96x24 box.
 */

export interface SparklinePaths {
  /** The whole line, `M x y L x y ...`. */
  readonly line: string;
  /** The line closed down to the baseline, for the faint fill. */
  readonly area: string;
  /** Only the final segment: the newest hour is still filling, so it is drawn lighter. */
  readonly tail: string;
  readonly max: number;
  readonly total: number;
}

const round = (n: number) => Math.round(n * 10) / 10;

/**
 * `pad` keeps a 1.5px stroke from being clipped at the top and bottom of the
 * box. The scale runs 0..max (never min..max): a project that steadily posts
 * 60 samples an hour must read as flat and full, not as noise magnified to the
 * box height. All-zero input is a flat line on the baseline.
 */
export function sparklinePaths(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2,
): SparklinePaths {
  const total = values.reduce((sum, v) => sum + v, 0);
  const max = values.reduce((m, v) => Math.max(m, v), 0);
  if (values.length === 0) return { line: '', area: '', tail: '', max: 0, total: 0 };

  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const usable = height - pad * 2;
  const points = values.map((v, i) => ({
    x: round(i * step),
    y: round(max > 0 ? pad + usable * (1 - v / max) : height - pad),
  }));
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ');
  const last = points[points.length - 1]!;
  const before = points[points.length - 2] ?? last;
  return {
    line,
    area: `${line} L${last.x} ${height} L${points[0]!.x} ${height} Z`,
    tail: `M${before.x} ${before.y} L${last.x} ${last.y}`,
    max,
    total,
  };
}

/** "1,340 samples in 24 h, peak 60 an hour" - the text twin of the drawing. */
export function describeActivity(values: readonly number[]): string {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total === 0) return 'No samples in the last 24 hours';
  const peak = values.reduce((m, v) => Math.max(m, v), 0);
  const fmt = (n: number) => n.toLocaleString('en-US');
  return `${fmt(total)} ${total === 1 ? 'sample' : 'samples'} in the last 24 hours, peak ${fmt(peak)} an hour`;
}
