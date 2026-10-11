/**
 * Analytics.tsx — Charts: a switch between its two modes, and the period one.
 *
 * **Period** is four answers with their shapes, then the charts, over a period
 * the filter bar picks. **Long view** is `LongView.tsx`: no picker, fixed long
 * windows. One switch at the top is the only way between them, because they
 * are two readings of one screen rather than two places to be — a fourth tab
 * would have put a planning question on the same footing as the ledger.
 *
 * Two of the period's stat cards open the
 * rows behind them and two do not: Spending and Income are each a total over
 * rows of one sign, so the list adds up to the figure; Balance is a position
 * and Cash flow a net, and a list behind either would sum to neither.
 */

import { For, Show } from 'solid-js';
import { money, shortDate } from './format';
import { BarChart, Donut, FlowThumb, IncomeThumb, LineChart, Sparkline } from './Charts';
import { FilterBar } from './Filters';
import { LongView } from './LongView';
import { CategoryBars } from './Rows';
import { StatCard } from './Stat';
import { analytics, currency, drillToRecords, setChartsMode, view } from './state';
import type { ChartsMode } from './view';

const MODES: { id: ChartsMode; label: string }[] = [
  { id: 'period', label: 'Period' },
  { id: 'long', label: 'Long view' }
];

function Period() {
  return (
    <>
      <FilterBar which="analytics" />
      <Show when={analytics()} fallback={<div class="spinner">Loading…</div>}>
        {(data) => (
          <>
            <div class="muted">{shortDate(data().window.from) + ' — ' + shortDate(data().window.to)}</div>

            <StatCard label="Balance" value={money(data().netWorth.total, currency())} thumb={<Sparkline series={data().balance} />} />
            <StatCard
              label="Spending"
              value={money(data().totals.expenses, currency())}
              thumb={<Donut rows={data().byCategory} />}
              onTap={() => drillToRecords({ spendOnly: true })}
            />
            <StatCard
              label="Income"
              value={money(data().totals.income, currency())}
              thumb={<IncomeThumb buckets={data().cashflow} />}
              onTap={() => drillToRecords({ incomeOnly: true })}
            />
            <StatCard
              label="Cash flow"
              value={money(data().totals.net, currency())}
              thumb={<FlowThumb income={data().totals.income} expenses={data().totals.expenses} />}
            />

            <Show when={data().totals.unconvertible}>
              <div class="card">
                <div class="muted">{data().totals.unconvertible + ' row(s) left out — no ' + data().currency + ' amount for them.'}</div>
              </div>
            </Show>

            <h2>Cashflow</h2>
            <div class="card">
              <BarChart buckets={data().cashflow} />
            </div>

            <h2>Net worth</h2>
            <div class="card">
              <LineChart series={data().balance} />
            </div>

            <h2>By category</h2>
            <div class="card">
              <CategoryBars rows={data().byCategory} />
            </div>
          </>
        )}
      </Show>
    </>
  );
}

export function Analytics() {
  return (
    <>
      <h1>Charts</h1>
      <div class="segmented top" role="group" aria-label="Which view">
        <For each={MODES}>
          {(mode) => (
            <button type="button" class="seg" aria-pressed={view().charts === mode.id ? 'true' : 'false'} onClick={() => setChartsMode(mode.id)}>
              {mode.label}
            </button>
          )}
        </For>
      </div>
      <Show when={view().charts === 'long'} fallback={<Period />}>
        <LongView />
      </Show>
    </>
  );
}
