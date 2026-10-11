/**
 * Records.tsx — the ledger, filtered, newest first, under the day it happened.
 *
 * "Load more" is a longer slice of the same answer rather than another round
 * trip, so there is no late page that could append onto a newer filter.
 */

import { For, Show } from 'solid-js';
import type { PageRecord } from '../domain/query';
import { dayHeading } from './format';
import { FilterBar } from './Filters';
import { PendingRow, RecordRow } from './Rows';
import { open, records, showMoreRecords } from './state';

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

export function Records() {
  const today = () => open()?.generatedAt || '';
  return (
    <>
      <h1>Records</h1>
      <FilterBar which="records" />
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
