/**
 * geometry.ts — the arithmetic under the hand-drawn charts.
 *
 * Split from the drawing so it can be tested: every chart is a 100×40 viewBox stretched to its card with
 * `preserveAspectRatio="none"`, and the scale beside it is HTML positioned
 * through the one conversion stated here, because a glyph in a stretched SVG
 * is stretched by different amounts on each axis.
 */

/**
 * The plot is `PLOT_UNITS` tall in viewBox units and `PLOT_PIXELS` on screen.
 * **These two are the only statement of that conversion** — a stylesheet that
 * repeated the pixel height would be half an arithmetic identity that goes
 * stale the first time the other half moves. 150 rather than 120 so a month of
 * movement is a line rather than a stripe.
 */
export const PLOT_UNITS = 40;
export const PLOT_PIXELS = 150;

/**
 * Centre to centre, and deliberately about twice a label's height: labels that
 * merely do not overlap still read as a block of text beside the chart.
 */
export const MARK_GAP_PIXELS = 24;

export type Mark = { y: number; label: string };
export type Point = { key: string; value: number };

export function pixelsOf(y: number): number {
  return (y / PLOT_UNITS) * PLOT_PIXELS;
}

/**
 * The marks that will not print on top of each other, **in priority order**:
 * a mark is kept unless one already kept is within `MARK_GAP_PIXELS` of it.
 * The bar chart passes zero first, the line chart its ends before its middle.
 * Filtered before the gridlines are drawn, so a dropped label takes its rule.
 */
export function spacedMarks(marks: readonly Mark[]): Mark[] {
  const kept: Mark[] = [];
  for (const mark of marks) {
    if (!kept.some((other) => Math.abs(pixelsOf(other.y) - pixelsOf(mark.y)) < MARK_GAP_PIXELS)) kept.push(mark);
  }
  return kept;
}

/**
 * A line's points and its scale. A flat series is centred rather than drawn
 * at the top — a zero range is a real answer, an account nobody touched — and
 * gets one mark, since three identical figures read as a broken scale.
 */
export function lineGeometry(series: readonly Point[], label: (value: number) => string) {
  const values = series.map((point) => point.value);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low;

  const points = series
    .map((point, i) => {
      const x = (i / (series.length - 1)) * 100;
      const y = range === 0 ? 20 : 38 - ((point.value - low) / range) * 36;
      return x.toFixed(2) + ',' + y.toFixed(2);
    })
    .join(' ');

  const marks = spacedMarks(
    range === 0
      ? [{ y: 20, label: label(low) }]
      : [{ y: 2, label: label(high) }, { y: 38, label: label(low) }, { y: 20, label: label((low + high) / 2) }]
  );
  return { points, marks };
}

/**
 * Several lines on **one** scale: the low and the high are taken across all of
 * them, because two lines each stretched to fill the plot would cross wherever
 * their own ranges happened to, and the gap between them — which is the thing
 * being read — would mean nothing. Every series has the same number of points.
 */
export function linesGeometry(series: readonly (readonly Point[])[], label: (value: number) => string) {
  const values = series.flatMap((line) => line.map((point) => point.value));
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = high - low;

  const lines = series.map((line) =>
    line
      .map((point, i) => {
        const x = (i / (line.length - 1)) * 100;
        const y = range === 0 ? 20 : 38 - ((point.value - low) / range) * 36;
        return x.toFixed(2) + ',' + y.toFixed(2);
      })
      .join(' ')
  );

  const marks = spacedMarks(
    range === 0
      ? [{ y: 20, label: label(low) }]
      : [{ y: 2, label: label(high) }, { y: 38, label: label(low) }, { y: 20, label: label((low + high) / 2) }]
  );
  return { lines, marks };
}

export type Column = { index: number; x: number; y: number; width: number; height: number };

/**
 * Bars of one sign, from zero at the foot of the plot. From zero and not from
 * the smallest value: these are amounts compared by height, and a truncated
 * baseline makes a month costing a tenth more look twice as tall. A slot is
 * kept for every value, so twelve months are twelve positions whichever are
 * drawn; a `null` is a slot left empty, which is not a bar of no height.
 */
export function columnGeometry(values: readonly (number | null)[], label: (value: number) => string) {
  const peak = values.reduce((top: number, value) => Math.max(top, value ?? 0), 0);
  const top = 1;
  const bottom = PLOT_UNITS - 1;
  const slot = 100 / (values.length || 1);

  const bars: Column[] = [];
  values.forEach((value, index) => {
    if (value === null || !peak) return;
    const height = Math.max((value / peak) * (bottom - top), 0.4);
    bars.push({ index, x: index * slot + slot * 0.15, y: bottom - height, width: slot * 0.7, height });
  });

  const marks: Mark[] = [{ y: bottom, label: label(0) }];
  if (peak > 0) marks.push({ y: top, label: label(peak) }, { y: (top + bottom) / 2, label: label(peak / 2) });
  return { bars, marks: spacedMarks(marks) };
}

export type Bucket = { key: string; income: number; expenses: number };
export type Bar = { x: number; y: number; width: number; height: number; up: boolean };

/**
 * Cashflow as signed bars from a zero line that moves with the data, inset a
 * unit at each end so a bar at the maximum is not mistaken for a clipped one.
 * Zero is always marked, and first, because it is what the sign is measured
 * from; the ends are marked only where they are a different number.
 */
export function barGeometry(buckets: readonly Bucket[], label: (value: number) => string) {
  let high = 0;
  let low = 0;
  for (const bucket of buckets) {
    high = Math.max(high, bucket.income);
    low = Math.min(low, -bucket.expenses);
  }
  const span = high - low || 1;
  const top = 1;
  const bottom = PLOT_UNITS - 1;
  const yOf = (value: number) => bottom - ((value - low) / span) * (bottom - top);
  const zero = yOf(0);

  const width = 100 / buckets.length;
  const bars: Bar[] = [];
  buckets.forEach((bucket, i) => {
    for (const [value, up] of [[-bucket.expenses, false], [bucket.income, true]] as const) {
      if (!value) continue;
      const height = Math.abs(value / span) * (bottom - top);
      bars.push({
        x: i * width + width * 0.15,
        y: value < 0 ? zero : zero - height,
        width: width * 0.7,
        height: Math.max(height, 0.4),
        up
      });
    }
  });

  const marks: Mark[] = [{ y: zero, label: label(0) }];
  if (high > 0) marks.push({ y: yOf(high), label: label(high) });
  if (low < 0) marks.push({ y: yOf(low), label: label(low) });
  return { bars, zero, marks: spacedMarks(marks) };
}

/** A sparkline's points, where only the direction survives. */
export function sparkPoints(series: readonly Point[]): string {
  if (series.length < 2) return '';
  const values = series.map((point) => point.value);
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  return series
    .map((point, i) => ((i / (series.length - 1)) * 100).toFixed(1) + ',' + (38 - ((point.value - low) / span) * 36).toFixed(1))
    .join(' ');
}

/**
 * A ring of up to five slices. A radius of 15.915 makes the circumference
 * almost exactly 100, so a share *is* its dash length — no arcs, no trig.
 */
export function donutSlices(rows: readonly { name: string; total: number }[]) {
  const slices = rows.slice(0, 5);
  const total = slices.reduce((sum, row) => sum + row.total, 0);
  if (!total) return [];
  let offset = 0;
  return slices.map((row) => {
    const share = (row.total / total) * 100;
    const slice = { name: row.name, dash: share.toFixed(2) + ' ' + (100 - share).toFixed(2), offset: (25 - offset).toFixed(2) };
    offset += share;
    return slice;
  });
}

/**
 * A colour for a category, derived from its name: `categories` has an icon
 * and no colour, and a hash gives one free, stably, on every device. Fixed
 * saturation and lightness so every disc reads at the same weight in both
 * themes.
 */
export function categoryColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return 'hsl(' + hash + ', 58%, 47%)';
}
