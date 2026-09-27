/**
 * Records.tsx — the ledger, filtered, newest first, under the day it happened.
 *
 * `renderRecords` and its helpers from `page.records.html`. "Load more" is a
 * longer slice of the same answer rather than another round trip, so the
 * request stamps that kept a late page from appending onto a newer filter
 * have nothing left to guard.
 */

import { For, Show } from 'solid-js';
import type { PageRecord } from '../domain/query';
import { dayHeading, withIcon } from './format';
import { FilterBar } from './Filters';
import { categoryIcon, PendingRow, RecordRow, subcategoryIcon } from './Rows';
import { open, records, setRecordsFilters, showMoreRecords, view } from './state';

/**
 * The rows as consecutive runs of one day — a run rather than a map, so the
 * order the page was handed is the order drawn.
 */
export function groupByDay(rows: readonly PageRecord[]): { key: string; rows: PageRecord[] }[] {
  const days: { key: string; rows: PageRecord[] }[] = [];
  for (const record of rows) {
    const last = days[days.length - 1];
    if (last && last.key === record.date) last.rows.push(record);
    else days.push({ key: record.date, rows: [record] });
  }
  return days;
}

/**
 * What a drill narrowed this list to, and the way back out. These filters
 * have no control in the bar — Charts sets them — so without the chips they
 * would be state you cannot see on the screen you came to *find* something.
 * Clearing the category clears its subcategory: a child alone names no group.
 */
function DrillChips() {
  const filters = () => view().records;
  const category = () => (filters().category !== 'All' ? filters().category : '');
  const subcategory = () => (filters().subcategory !== 'All' ? filters().subcategory : '');
  const chips = () => {
    const list: { text: string; clear: () => void }[] = [];
    if (filters().spendOnly) list.push({ text: 'Money out', clear: () => setRecordsFilters({ spendOnly: false }) });
    if (filters().incomeOnly) list.push({ text: 'Money in', clear: () => setRecordsFilters({ incomeOnly: false }) });
    if (category()) {
      list.push({ text: withIcon(categoryIcon(category()), category()), clear: () => setRecordsFilters({ category: 'All', subcategory: 'All' }) });
    }
    if (subcategory()) {
      list.push({ text: withIcon(subcategoryIcon(subcategory()), subcategory()), clear: () => setRecordsFilters({ subcategory: 'All' }) });
    }
    return list;
  };
  return (
    <Show when={chips().length}>
      <div class="chips drills">
        <For each={chips()}>
          {(chip) => (
            <button type="button" class="chip on" aria-label={'Remove filter: ' + chip.text} onClick={() => chip.clear()}>
              {chip.text}
              <span class="x">✕</span>
            </button>
          )}
        </For>
        {/* Only with more than one: beside a single chip it does what that chip does. */}
        <Show when={chips().length > 1}>
          <button
            type="button"
            class="chip"
            onClick={() => setRecordsFilters({ spendOnly: false, incomeOnly: false, category: 'All', subcategory: 'All' })}
          >
            Clear all
          </button>
        </Show>
      </div>
    </Show>
  );
}

export function Records() {
  const today = () => open()?.generatedAt || '';
  return (
    <>
      <h1>Records</h1>
      <FilterBar which="records" />
      <DrillChips />
      <Show when={records()} fallback={<div class="spinner">Loading…</div>}>
        {(page) => (
          <>
            {/* Holds first: a pending authorisation is newer than anything settled. */}
            <Show when={page().pending.length}>
              <div class="card">
                <div class="daygroup">
                  <div class="dayhead">Pending</div>
                  <For each={page().pending}>{(record) => <PendingRow record={record} />}</For>
                </div>
                <p class="pending-note">Not yet settled, so not counted anywhere</p>
              </div>
            </Show>

            <div class="card">
              <Show when={page().rows.length} fallback={<p class="muted">Nothing matches those filters.</p>}>
                <For each={groupByDay(page().rows)}>
                  {(day) => (
                    <div class="daygroup">
                      <div class="dayhead">{dayHeading(day.key, today())}</div>
                      <For each={day.rows}>{(record) => <RecordRow record={record} />}</For>
                    </div>
                  )}
                </For>
              </Show>
            </div>

            <p class="muted">{page().rows.length + ' of ' + page().total}</p>
            <Show when={page().hasMore}>
              <button type="button" class="primary" onClick={showMoreRecords}>
                Load more
              </button>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
