/**
 * Analytics.tsx — Charts: four answers with their shapes, then the charts.
 *
 * Two of the stat cards open the
 * rows behind them and two do not: Spending and Income are each a total over
 * rows of one sign, so the list adds up to the figure; Balance is a position
 * and Cash flow a net, and a list behind either would sum to neither.
 */

import { Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { money, shortDate } from './format';
import { BarChart, Donut, FlowThumb, IncomeThumb, LineChart, Sparkline } from './Charts';
import { FilterBar } from './Filters';
import { CategoryBars } from './Rows';
import { analytics, currency, drillToRecords } from './state';

/** A headline number with its shape beside it; a button only when there are rows behind it. */
function StatCard(props: { label: string; value: string; thumb: JSX.Element; onTap?: () => void }) {
  return (
    <div class="card">
      <Show
        when={props.onTap}
        fallback={
          <div class="stat">
            <div class="grow">
              <div class="label">{props.label}</div>
              <div class="value num">{props.value}</div>
            </div>
            {props.thumb}
          </div>
        }
      >
        <button type="button" class="stat tappable" aria-label={props.label + ' ' + props.value + ', show these transactions'} onClick={() => props.onTap?.()}>
          <div class="grow">
            <div class="label">{props.label}</div>
            <div class="value num">{props.value}</div>
          </div>
          {props.thumb}
          <span class="chev">›</span>
        </button>
      </Show>
    </div>
  );
}

export function Analytics() {
  return (
    <>
      <h1>Charts</h1>
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
