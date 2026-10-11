/**
 * LongView.tsx — Charts' other mode: a year, the year before it, and the whole ledger.
 *
 * No period picker and no filters. The windows are fixed and `longview.ts`
 * decides them; this file words what it answers and draws it, and computes
 * nothing a figure depends on.
 *
 * ## A short ledger is said, not hidden
 *
 * Every section that needs a year, or a year to compare with, says how many
 * complete months the ledger holds instead of drawing itself from less. A
 * section that drew anyway would be a chart of a few months captioned as a
 * year, and an empty card would read as nothing having happened.
 *
 * ## What opens Records
 *
 * The spending card and the category rows, each on T12 as a custom period:
 * both are totals over rows of one sign, so the list adds up to the figure.
 * The rest are ratios, positions and differences, with no list that sums to
 * them.
 *
 * ## Bars that are not charts
 *
 * Year by year, where the change came from, where it sits and the biggest
 * changes are tracks with CSS widths, as the category bars are: a handful of
 * rows compared by length needs no plot and no scale, and the figure is
 * printed on the row.
 */

import { For, Show } from 'solid-js';
import type { LongView as Data } from '../domain/longview';
import { HELD_OTHER } from '../domain/longview';
import { ACCOUNT_KIND } from '../domain/schema';
import { BarChart, ColumnChart, FlowThumb, LineChart, LinesChart, Sparkline } from './Charts';
import { fullDate, money, monthNames, percent, shortDate, withIcon } from './format';
import { categoryIcon, CategoryBars } from './Rows';
import { StatCard } from './Stat';
import { currency, drillToRecords, longView } from './state';

const cash = (value: number) => money(value, currency());
const change = (value: number) => money(value, currency(), { signed: true });

/** `the ledger holds 5 complete months`, for every place that cannot answer from that few. */
export function heldWords(months: number): string {
  if (!months) return 'the ledger holds no complete month yet';
  return 'the ledger holds ' + months + ' complete month' + (months === 1 ? '' : 's');
}

/** A share of a whole. One too small to round to 1% is said to be small, since `0%` says there is none. */
const share = (value: number) => (value > 0 && value < 0.005 ? 'under 1%' : percent(value));

const sentence = (words: string) => words.charAt(0).toUpperCase() + words.slice(1) + '.';

const KIND_NAMES: { [kind: string]: string } = {
  [ACCOUNT_KIND.ASSET]: 'Investments and assets',
  [ACCOUNT_KIND.BANK]: 'Bank accounts',
  [ACCOUNT_KIND.CASH]: 'Cash',
  [HELD_OTHER]: 'Other accounts'
};

/** A share of the widest row, as a CSS width. A negative has no length to its right. */
function widthOf(value: number, widest: number): string {
  return (widest > 0 ? Math.max(0, Math.min(1, value / widest)) * 100 : 0).toFixed(1) + '%';
}

function Cards(props: { data: Data }) {
  const data = () => props.data;
  const runway = () => {
    const months = data().runway.months;
    return months === null
      ? '—'
      : new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(months) + ' months';
  };
  const runwayNote = () => {
    const held = cash(data().runway.liquid) + ' in bank and cash';
    if (data().runway.months !== null) return held;
    return data().history.aYear ? held + ', and nothing spent' : held + ' · ' + heldWords(data().history.months);
  };
  const savedNote = () => {
    if (data().savingsRate === null) return 'No income in these 12 months';
    return data().saved < 0
      ? cash(-data().saved) + ' more spent than the ' + cash(data().income) + ' earned'
      : cash(data().saved) + ' kept of ' + cash(data().income) + ' earned';
  };
  return (
    <>
      <StatCard
        label={data().history.aYear ? 'Annual spending' : 'Spending so far'}
        value={cash(data().spending.total)}
        note={data().spending.monthly === null ? sentence(heldWords(data().history.months)) : cash(data().spending.monthly as number) + ' a month'}
        thumb={<Sparkline series={data().rolling.map((point) => ({ key: point.key, value: point.expenses }))} />}
        onTap={() => drillToRecords({ spendOnly: true, period: { kind: 'custom', from: data().window.from, to: data().window.to } })}
      />
      <StatCard
        label="Savings rate"
        value={percent(data().savingsRate)}
        note={savedNote()}
        thumb={<FlowThumb income={data().income} expenses={data().spending.total} />}
      />
      <StatCard label="Runway" value={runway()} note={runwayNote()} />
      <StatCard
        label="Net worth change"
        value={change(data().netWorth.change)}
        note={
          cash(data().netWorth.before) + ' → ' + cash(data().netWorth.now) +
          (data().netWorth.sinceStart ? ' since ' + fullDate(data().netWorth.since) + ', before the ledger starts' : '')
        }
        thumb={<Sparkline series={data().netWorth.series.slice(-13)} />}
      />
    </>
  );
}

function Rolling(props: { data: Data }) {
  const data = () => props.data;
  const grew = (rate: number | null) => (rate === null ? 'from nothing' : percent(rate, { digits: 1, signed: true }));
  const note = () => {
    const compared = data().compared;
    if (!compared) {
      return 'Each point is the 12 months ending there. Comparing with the year before needs 24 complete months: ' +
        heldWords(data().history.months) + '.';
    }
    return 'Income ' + grew(compared.income) + ', spending ' + grew(compared.spending) +
      ' on the 12 months before. The gap is what you kept: ' + cash(data().saved) + ' now, ' +
      cash(compared.savedBefore) + ' a year earlier.';
  };
  return (
    <Show
      when={data().rolling.length >= 2}
      fallback={<p class="muted">{'A rolling year needs 13 complete months: ' + heldWords(data().history.months) + '.'}</p>}
    >
      <p class="muted lead">{note()}</p>
      <LinesChart
        title="Income and spending over each trailing 12 months"
        lines={[
          { name: 'Income', tone: 'in', series: data().rolling.map((point) => ({ key: point.key, value: point.income })) },
          { name: 'Spending', tone: 'out', series: data().rolling.map((point) => ({ key: point.key, value: point.expenses })) }
        ]}
      />
    </Show>
  );
}

function Years(props: { data: Data }) {
  const tallest = () => props.data.years.reduce((top, year) => Math.max(top, year.full ?? year.toDate), 0);
  return (
    <Show when={props.data.years.length} fallback={<p class="muted">The ledger does not cover a year from January yet.</p>}>
      <For each={props.data.years}>
        {(year) => (
          <div class="item">
            <div class="row">
              <span class="grow">{String(year.year)}</span>
              <span class="num">{cash(year.toDate)}</span>
            </div>
            <div class="bar-track split">
              <div class="bar-fill" style={{ width: widthOf(year.toDate, tallest()) }} />
              <Show when={year.full !== null}>
                <div class="bar-fill rest" style={{ left: widthOf(year.toDate, tallest()), width: widthOf((year.full as number) - year.toDate, tallest()) }} />
              </Show>
            </div>
            <div class="row barnote">
              <span class="muted">{'Up to ' + shortDate(props.data.yearTo)}</span>
              <span class="muted num">{year.full === null ? 'year in progress' : cash(year.full) + ' full year'}</span>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}

function Typical(props: { data: Data }) {
  const data = () => props.data.typical;
  const names = monthNames();
  const note = () => {
    const usual = data().usual as number;
    const ranked = data().months
      .map((value, month) => ({ value, name: names[month] }))
      .filter((entry): entry is { value: number; name: string } => entry.value !== null)
      .sort((a, b) => b.value - a.value);
    const seen = ranked.length < 12 ? ' A calendar month the ledger has not completed is left empty.' : '';
    if (ranked.length === 1) return ranked[0].name + ' is the only complete month the ledger holds: ' + cash(usual) + '.';
    const above = ranked.filter((entry) => entry.value > usual).slice(0, 2);
    if (!above.length) return 'Every month costs about the same: ' + cash(usual) + '.' + seen;
    return above.map((entry) => entry.name).join(' and ') + (above.length === 1 ? ' costs' : ' cost') + ' the most: ' +
      above.map((entry) => cash(entry.value - usual)).join(' and ') + ' above an average month of ' + cash(usual) + '.' + seen;
  };
  return (
    <Show when={data().usual !== null} fallback={<p class="muted">{'A typical year needs a complete month: ' + heldWords(props.data.history.months) + '.'}</p>}>
      <p class="muted lead">{note()}</p>
      <ColumnChart title="Average spending in each calendar month" values={data().months} ticks={names.map((name) => name.charAt(0))} />
    </Show>
  );
}

function Sources(props: { data: Data }) {
  const data = () => props.data;
  const rows = () => {
    const sources = data().sources;
    const list = [
      { name: 'Saved from income', value: sources.saved, soft: false, about: '' },
      { name: 'Assets revalued', value: sources.revalued, soft: true, about: '' }
    ];
    // Its own row, and only when there is one: it is what the two above do not explain.
    if (sources.other !== 0) {
      list.push({
        name: 'Other movements', value: sources.other, soft: true,
        about: 'Money that arrived or left as neither income nor spending, or spending on an account net worth does not count.'
      });
    }
    return list;
  };
  const widest = () => rows().reduce((top, row) => Math.max(top, Math.abs(row.value)), 0);
  return (
    <>
      <p class="muted lead">
        {data().netWorth.sinceStart
          ? 'Where the change since ' + fullDate(data().netWorth.since) + ' came from'
          : 'Where the last 12 months of change came from'}
      </p>
      <For each={rows()}>
        {(row) => (
          <div class="item">
            <div class="row">
              <span class="grow">{row.name}</span>
              <span class="num">{change(row.value)}</span>
            </div>
            <div class="bar-track">
              <div class={['bar-fill', { soft: row.soft, down: row.value < 0 }]} style={{ width: widthOf(Math.abs(row.value), widest()) }} />
            </div>
            <Show when={row.about}>
              <div class="muted barnote">{row.about}</div>
            </Show>
          </div>
        )}
      </For>
    </>
  );
}

function Held(props: { data: Data }) {
  const data = () => props.data;
  const widest = () => data().held.reduce((top, row) => Math.max(top, row.balance), 0);
  return (
    <Show when={data().held.length} fallback={<p class="muted">No account is counted in net worth.</p>}>
      <p class="muted lead">Where it sits today</p>
      <For each={data().held}>
        {(row) => (
          <div class="item">
            <div class="row">
              <span class="grow">{KIND_NAMES[row.kind] || row.kind}</span>
              <span class="num">{cash(row.balance)}</span>
            </div>
            <div class="bar-track">
              <div class="bar-fill" style={{ width: widthOf(row.balance, widest()) }} />
            </div>
            <div class="row barnote">
              <span class="muted">{row.share === null ? '' : share(row.share) + ' of net worth'}</span>
              <span class="muted num">{change(row.change) + (data().netWorth.sinceStart ? ' since the ledger starts' : ' in 12 months')}</span>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}

function Pace(props: { data: Data }) {
  const data = () => props.data;
  const lead = () =>
    data().saved < 0
      ? 'At this pace: spending ' + cash(-data().saved) + ' a year more than is earned, with no market growth assumed'
      : 'At this pace: saving ' + cash(data().saved) + ' a year, with no market growth assumed';
  return (
    <Show when={data().pace} fallback={<p class="muted">{'A pace needs 12 complete months: ' + heldWords(data().history.months) + '.'}</p>}>
      {(pace) => (
        <>
          <p class="muted lead">{lead()}</p>
          <For each={pace()}>
            {(ahead) => (
              <div class="row">
                <span class="grow">{'In ' + ahead.years + (ahead.years === 1 ? ' year' : ' years')}</span>
                <span class="num">{cash(ahead.value)}</span>
              </div>
            )}
          </For>
        </>
      )}
    </Show>
  );
}

function Movers(props: { data: Data }) {
  const data = () => props.data;
  const widest = () => (data().movers || []).reduce((top, row) => Math.max(top, Math.abs(row.change)), 0);
  // Half the track each way from the centre line.
  const half = (value: number) => (widest() > 0 ? (Math.abs(value) / widest()) * 50 : 0);
  return (
    <Show when={data().movers} fallback={<p class="muted">{'Comparing two years needs 24 complete months: ' + heldWords(data().history.months) + '.'}</p>}>
      {(movers) => (
        <Show when={movers().length} fallback={<p class="muted">No category changed between the two years.</p>}>
          <p class="muted lead">Against the 12 months before. Right of the line is more spent, left is less.</p>
          <For each={movers()}>
            {(row) => (
              <div class="item">
                <div class="row">
                  <span class="grow ellipsis">{withIcon(categoryIcon(row.name), row.name)}</span>
                  <span class="num">{change(row.change)}</span>
                </div>
                <div class="bar-track split">
                  <div
                    class={['bar-fill', row.change > 0 ? 'more' : 'less']}
                    style={{ left: (row.change > 0 ? 50 : 50 - half(row.change)).toFixed(1) + '%', width: half(row.change).toFixed(1) + '%' }}
                  />
                  <div class="mid" />
                </div>
              </div>
            )}
          </For>
        </Show>
      )}
    </Show>
  );
}

/**
 * The floor the monthly bars are drawn to. A month that earned €10 and spent
 * €2,000 has a rate of −19,900%, and one such bar drawn to scale flattens the
 * other eleven into the zero line.
 */
const RATE_FLOOR = -1;

function Rates(props: { data: Data }) {
  const data = () => props.data;
  const rated = () => data().rates.filter((month): month is typeof month & { rate: number } => month.rate !== null);
  const note = () => {
    const overall = data().savingsRate;
    const worst = rated().reduce((low: { key: string; rate: number } | null, month) => (!low || month.rate < low.rate ? month : low), null);
    const across = overall === null ? '' : percent(overall) + (data().history.aYear ? ' across the year. ' : ' so far. ');
    if (!worst) return across + 'No complete month had income, so none has a rate.';
    return across +
      (worst.rate < 0 ? shortDate(worst.key) + ' spent more than it earned.'
        : worst.rate > 0 ? 'Every month kept something.' : 'No month spent more than it earned.') +
      (rated().length < data().rates.length ? ' A month with no income has no rate, and no bar.' : '') +
      (worst.rate < RATE_FLOOR ? ' Bars stop at ' + percent(RATE_FLOOR) + '.' : '');
  };
  // A month with no rate is a bucket of nothing either way, which the chart draws as no bar.
  const buckets = () => data().rates.map((month) => {
    const rate = month.rate === null ? 0 : Math.max(month.rate, RATE_FLOOR);
    return { key: month.key, income: Math.max(rate, 0), expenses: Math.max(-rate, 0) };
  });
  return (
    <Show when={data().rates.length} fallback={<p class="muted">{'A monthly rate needs a complete month: ' + heldWords(data().history.months) + '.'}</p>}>
      <p class="muted lead">{note()}</p>
      {/* Twelve empty slots over a lone 0% would be a chart of nothing. */}
      <Show when={rated().length}>
        <BarChart buckets={buckets()} scale={(value) => percent(value)} title="Savings rate for each complete month" />
      </Show>
    </Show>
  );
}

export function LongView() {
  return (
    <Show when={longView()} fallback={<div class="spinner">Loading…</div>}>
      {(data) => (
        <>
          <div class="muted">
            {fullDate(data().window.from) + ' — ' + fullDate(data().window.to) + ' · ' +
              (data().history.twoYears ? 'compared with the 12 months before' : heldWords(data().history.months))}
          </div>

          <Cards data={data()} />

          <Show when={data().unconvertible}>
            <div class="card">
              <div class="muted">{data().unconvertible + ' row(s) left out — no ' + data().currency + ' amount for them.'}</div>
            </div>
          </Show>

          <h2>Income and spending, rolling 12 months</h2>
          <div class="card">
            <Rolling data={data()} />
          </div>

          <h2>Year by year</h2>
          <div class="card">
            <Years data={data()} />
          </div>

          <h2>A typical year, month by month</h2>
          <div class="card">
            <Typical data={data()} />
          </div>

          <h2>Net worth</h2>
          <div class="card">
            <LineChart series={data().netWorth.series} date={fullDate} />
          </div>
          <div class="card">
            <Sources data={data()} />
          </div>
          <div class="card">
            <Held data={data()} />
          </div>
          <div class="card">
            <Pace data={data()} />
          </div>

          <h2>{data().history.aYear ? 'Where it went · 12 months' : 'Where it went'}</h2>
          <div class="card">
            <CategoryBars
              rows={data().categories}
              period={{ kind: 'custom', from: data().window.from, to: data().window.to }}
              empty="Nothing spent in these 12 months."
              note={(row) => [
                row.share === null ? '' : share(row.share) + ' of spending',
                row.monthly === null ? '' : cash(row.monthly) + ' a month'
              ]}
            />
          </div>

          <h2>Biggest changes</h2>
          <div class="card">
            <Movers data={data()} />
          </div>

          <h2>Savings rate by month</h2>
          <div class="card">
            <Rates data={data()} />
          </div>
        </>
      )}
    </Show>
  );
}
