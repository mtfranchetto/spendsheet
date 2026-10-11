/**
 * Charts.tsx — the hand-drawn charts, as components.
 *
 * The full charts and the Charts screen's thumbnails, drawn from
 * `geometry.ts`. No library: a third-party script in the one page that
 * renders bank balances is not worth what it saves, and the drawing is small.
 * The reasoning behind each choice — the scale in a gutter, the marks spaced
 * by priority, the zero line that moves — is argued in `geometry.ts`.
 */

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import {
  barGeometry, categoryColor, columnGeometry, donutSlices, lineGeometry, linesGeometry, pixelsOf, PLOT_PIXELS,
  sparkPoints, type Bucket, type Mark, type Point
} from './geometry';
import { money, shortDate } from './format';
import { currency } from './state';

const whole = (value: number) => money(value, currency(), { whole: true });

/** A plot and the scale that says what its height is worth. */
function Scaled(props: { marks: Mark[]; children: JSX.Element }) {
  return (
    <div class="plot">
      {props.children}
      <div class="yaxis">
        <For each={props.marks}>
          {(mark) => (
            <span class="ytick" style={{ top: pixelsOf(mark.y).toFixed(1) + 'px' }}>
              {mark.label}
            </span>
          )}
        </For>
      </div>
    </div>
  );
}

function Gridlines(props: { marks: Mark[] }) {
  return (
    <For each={props.marks}>
      {(mark) => (
        <line x1="0" y1={mark.y.toFixed(2)} x2="100" y2={mark.y.toFixed(2)} class="grid" vector-effect="non-scaling-stroke" />
      )}
    </For>
  );
}

/**
 * A line, from a series of `{key, value}`. Each end captioned with **its own**
 * value: pairing the first date with the low was right only for a line that
 * happened to rise. `date` words the two ends, for a line long enough that the
 * year is part of the answer.
 */
export function LineChart(props: { series: Point[] | null | undefined; date?: (key: string) => string }) {
  return (
    <Show when={props.series && props.series.length >= 2 ? props.series : null} fallback={<p class="muted">Not enough days to draw a line yet.</p>}>
      {(series) => {
        const geometry = () => lineGeometry(series(), whole);
        const first = () => series()[0];
        const last = () => series()[series().length - 1];
        const date = (key: string) => (props.date || shortDate)(key);
        return (
          <div>
            <Scaled marks={geometry().marks}>
              <svg
                viewBox="0 0 100 40"
                preserveAspectRatio="none"
                role="img"
                aria-label={'Trend from ' + first().key + ' to ' + last().key}
                style={{ height: PLOT_PIXELS + 'px' }}
              >
                <Gridlines marks={geometry().marks} />
                <polyline points={geometry().points} class="line" vector-effect="non-scaling-stroke" />
              </svg>
            </Scaled>
            <div class="row">
              <span class="muted">{date(first().key) + ' · ' + whole(first().value)}</span>
              <span class="muted">{date(last().key) + ' · ' + whole(last().value)}</span>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

/**
 * Cashflow, as bars from a zero line: out below, in above. The same drawing
 * serves any signed series with what is above zero as `income` and what is
 * below as `expenses`; `scale` words its marks and `title` says what it is.
 */
export function BarChart(props: { buckets: Bucket[] | null | undefined; scale?: (value: number) => string; title?: string }) {
  return (
    <Show when={props.buckets && props.buckets.length ? props.buckets : null} fallback={<p class="muted">Nothing in this period.</p>}>
      {(buckets) => {
        const geometry = () => barGeometry(buckets(), props.scale || whole);
        return (
          <div>
            <Scaled marks={geometry().marks}>
              <svg
                viewBox="0 0 100 40"
                preserveAspectRatio="none"
                role="img"
                aria-label={props.title || buckets().length + ' periods of income and spending'}
                style={{ height: PLOT_PIXELS + 'px' }}
              >
                <For each={geometry().bars}>
                  {(bar) => (
                    <rect
                      x={bar.x.toFixed(2)}
                      y={bar.y.toFixed(2)}
                      width={bar.width.toFixed(2)}
                      height={bar.height.toFixed(2)}
                      class={['barmark', { up: bar.up }]}
                    />
                  )}
                </For>
                <Gridlines marks={geometry().marks} />
                <line
                  x1="0"
                  y1={geometry().zero.toFixed(2)}
                  x2="100"
                  y2={geometry().zero.toFixed(2)}
                  class="axis"
                  vector-effect="non-scaling-stroke"
                />
              </svg>
            </Scaled>
            <div class="row">
              <span class="muted">{shortDate(buckets()[0].key)}</span>
              <span class="muted">{shortDate(buckets()[buckets().length - 1].key)}</span>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

export type NamedLine = { name: string; tone: 'in' | 'out'; series: Point[] };

/**
 * Several lines on one scale, each named in a legend that carries its latest
 * value: the end of a line is what is read, and two ends close together in a
 * gutter are the labels `spacedMarks` exists to drop.
 */
export function LinesChart(props: { lines: NamedLine[]; title: string }) {
  const geometry = () => linesGeometry(props.lines.map((line) => line.series), whole);
  const drawn = () => props.lines.map((line, i) => ({ ...line, points: geometry().lines[i] }));
  const ends = () => props.lines[0].series;
  return (
    <div>
      <div class="legend">
        <For each={props.lines}>
          {(line) => (
            <span>
              <span class={['sw', line.tone]} aria-hidden="true" />
              {line.name + ' '}
              <span class="num">{whole(line.series[line.series.length - 1].value)}</span>
            </span>
          )}
        </For>
      </div>
      <Scaled marks={geometry().marks}>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={props.title} style={{ height: PLOT_PIXELS + 'px' }}>
          <Gridlines marks={geometry().marks} />
          <For each={drawn()}>
            {(line) => <polyline points={line.points} class={['line', line.tone]} vector-effect="non-scaling-stroke" />}
          </For>
        </svg>
      </Scaled>
      <div class="row">
        <span class="muted">{shortDate(ends()[0].key)}</span>
        <span class="muted">{shortDate(ends()[ends().length - 1].key)}</span>
      </div>
    </div>
  );
}

/**
 * Amounts as bars from zero, one slot per value with its tick under it. A
 * `null` leaves its slot empty: see `columnGeometry`.
 */
export function ColumnChart(props: { values: (number | null)[]; ticks: string[]; title: string }) {
  const geometry = () => columnGeometry(props.values, whole);
  return (
    <div>
      <Scaled marks={geometry().marks}>
        <svg viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={props.title} style={{ height: PLOT_PIXELS + 'px' }}>
          <Gridlines marks={geometry().marks} />
          <For each={geometry().bars}>
            {(bar) => (
              <rect x={bar.x.toFixed(2)} y={bar.y.toFixed(2)} width={bar.width.toFixed(2)} height={bar.height.toFixed(2)} class="barmark flat" />
            )}
          </For>
        </svg>
      </Scaled>
      <div class="xlabels" aria-hidden="true">
        <For each={props.ticks}>{(tick) => <span>{tick}</span>}</For>
      </div>
    </div>
  );
}

/** The balance line, small enough that only its direction survives. */
export function Sparkline(props: { series: Point[] | null | undefined }) {
  return (
    <svg class="thumb" viewBox="0 0 100 40" preserveAspectRatio="none">
      <Show when={props.series && props.series.length >= 2}>
        <polyline fill="none" class="spark" vector-effect="non-scaling-stroke" points={sparkPoints(props.series || [])} />
      </Show>
    </svg>
  );
}

/** Spending split by category, as a ring of up to five slices. */
export function Donut(props: { rows: { name: string; total: number }[] | null | undefined }) {
  return (
    <svg class="thumb" viewBox="0 0 42 42">
      <For each={donutSlices(props.rows || [])}>
        {(slice) => (
          <circle
            cx="21"
            cy="21"
            r="15.915"
            fill="none"
            stroke-width="6"
            stroke={categoryColor(slice.name)}
            stroke-dasharray={slice.dash}
            stroke-dashoffset={slice.offset}
          />
        )}
      </For>
    </svg>
  );
}

/**
 * Income, bucket by bucket. Not a donut: income is not grouped by category —
 * a refund filed under Groceries would read as a category you earned in — and
 * the question income raises on a phone is *when*.
 */
export function IncomeThumb(props: { buckets: Bucket[] | null | undefined }) {
  const bars = () => {
    const rows = props.buckets || [];
    const biggest = rows.reduce((top, bucket) => Math.max(top, bucket.income), 0);
    if (!biggest) return [];
    const width = 100 / rows.length;
    return rows.flatMap((bucket, i) => {
      if (!bucket.income) return [];
      const height = (bucket.income / biggest) * 38;
      return [{ x: i * width + width * 0.15, y: 39 - height, width: width * 0.7, height: Math.max(height, 0.5) }];
    });
  };
  return (
    <svg class="thumb" viewBox="0 0 100 40" preserveAspectRatio="none">
      <For each={bars()}>
        {(bar) => <rect x={bar.x.toFixed(2)} y={bar.y.toFixed(2)} width={bar.width.toFixed(2)} height={bar.height.toFixed(2)} class="barmark up" />}
      </For>
    </svg>
  );
}

/** In against out, which is the whole of what a cashflow number means. */
export function FlowThumb(props: { income: number; expenses: number }) {
  const biggest = () => Math.max(props.income, props.expenses, 1);
  return (
    <svg class="thumb" viewBox="0 0 100 40">
      <rect x="0" y="5" height="13" rx="3" width={Math.max(3, (props.income / biggest()) * 100).toFixed(1)} class="barmark up" />
      <rect x="0" y="22" height="13" rx="3" width={Math.max(3, (props.expenses / biggest()) * 100).toFixed(1)} class="barmark" />
    </svg>
  );
}
