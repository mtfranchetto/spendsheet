/**
 * Filters.tsx — the filter bar, shared by Records and Charts.
 *
 * A filter is a recomputation over the book on the phone, not a round trip.
 * Search still fires on `change` rather than per keystroke, because
 * recomputing Records over the whole ledger for every letter is work nobody is
 * reading.
 */

import { For, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import type { Period } from '../domain/query';
import { monthNames } from './format';
import { clock, open, overview, setAnalyticsFilters, setRecordsFilters, view } from './state';
import { chosenAccounts, periodOptionId, type AnalyticsFilters } from './view';

/** A control with its name above it: two dropdowns both reading "All" is a guessing game. */
function Labelled(props: { text: string; children: JSX.Element; class?: string }) {
  return (
    <div class={['fld', props.class]}>
      <span class="flabel">{props.text}</span>
      {props.children}
    </div>
  );
}

/**
 * The account filter, as chips, several at a time. `<select multiple>` is
 * unusable on a phone. `All` is a chip because nothing selected and
 * everything selected mean the same; a chosen account the tab no longer
 * offers still gets a pressed chip, or a bookmark would filter invisibly.
 */
function AccountChips(props: { chosen: string[]; onChange: (accounts: string | string[]) => void }) {
  const names = () => {
    const list = (open()?.lists.accounts || []).slice();
    for (const name of props.chosen) if (list.indexOf(name) === -1) list.push(name);
    return list;
  };
  const toggle = (name: string) => {
    const next = props.chosen.indexOf(name) === -1 ? [...props.chosen, name] : props.chosen.filter((n) => n !== name);
    // Sorted, so A-then-B and B-then-A are one question and one URL.
    props.onChange(next.length ? next.sort() : 'All');
  };
  return (
    <Labelled text="Account" class="wide">
      <div class="chips">
        <button type="button" class="chip" aria-pressed={props.chosen.length ? 'false' : 'true'} onClick={() => props.onChange('All')}>
          All
        </button>
        <For each={names()}>
          {(name) => (
            <button type="button" class="chip" aria-pressed={props.chosen.indexOf(name) === -1 ? 'false' : 'true'} onClick={() => toggle(name)}>
              {name}
            </button>
          )}
        </For>
      </div>
    </Labelled>
  );
}

/**
 * The months under "A month…", as chips that wrap: only months that have
 * started, since a period empty by construction looks like a broken filter.
 * The book's clock decides which those are, not the phone's.
 */
function MonthChips(props: { period: Period; onChange: (period: Period) => void }) {
  const names = monthNames();
  const today = () => clock();
  const year = () => Number(props.period.year) || today()?.year || new Date().getFullYear();
  const chosen = () => Number(props.period.month) || (today()?.month ?? 0) + 1;
  const last = () => (year() === today()?.year ? (today()?.month ?? 11) + 1 : 12);
  const months = () => Array.from({ length: last() }, (_, i) => i + 1);
  return (
    <Labelled text={year() === today()?.year ? 'Month' : 'Month of ' + year()} class="wide">
      <div class="chips">
        <For each={months()}>
          {(month) => (
            <button
              type="button"
              class="chip"
              aria-pressed={month === chosen() ? 'true' : 'false'}
              aria-label={names[month - 1] + ' ' + year()}
              onClick={() => month !== chosen() && props.onChange({ kind: 'month', year: year(), month })}
            >
              {names[month - 1]}
            </button>
          )}
        </For>
      </div>
    </Labelled>
  );
}

export function FilterBar(props: { which: 'records' | 'analytics' }) {
  const filters = (): AnalyticsFilters & { search?: string; unconfirmedOnly?: boolean } =>
    props.which === 'records' ? view().records : view().analytics;
  const set = (change: Partial<AnalyticsFilters> & { search?: string; unconfirmedOnly?: boolean }) =>
    props.which === 'records' ? setRecordsFilters(change) : setAnalyticsFilters(change);
  const periods = () => overview()?.lists.periods || [];
  const labels = () => overview()?.lists.labels || [];

  /*
    Matched on `id`, not on `kind`: every named year is `kind: 'year'`, and
    sending back a bare `{kind: 'year'}` resolves to *this* year. "A month…"
    lands on this month, so its chips have one pressed at once.
  */
  const choosePeriod = (id: string) => {
    const entry = periods().find((option) => option.id === id) || { kind: 'mtd' as string, year: undefined };
    const today = clock();
    const current = filters().period;
    set({
      period:
        entry.kind === 'custom'
          ? { kind: 'custom', from: current.from, to: current.to }
          : entry.kind === 'month'
            ? { kind: 'month', year: today?.year, month: (today?.month ?? 0) + 1 }
            : { kind: entry.kind, year: entry.year }
    });
  };

  return (
    <div class="filters">
      <Labelled text="Period">
        <select aria-label="Period" onChange={(event) => choosePeriod(event.currentTarget.value)}>
          <For each={periods()}>
            {(entry) => (
              <option value={entry.id} selected={entry.id === periodOptionId(filters().period)}>
                {entry.label}
              </option>
            )}
          </For>
        </select>
      </Labelled>

      <Show when={filters().period.kind === 'month'}>
        <MonthChips period={filters().period} onChange={(period) => set({ period })} />
      </Show>

      <AccountChips chosen={chosenAccounts(filters().account)} onChange={(account) => set({ account })} />

      <Labelled text="Label">
        <select aria-label="Label" onChange={(event) => set({ label: event.currentTarget.value })}>
          <For each={['All', ...labels()]}>
            {(label) => (
              <option value={label} selected={label === filters().label}>
                {label}
              </option>
            )}
          </For>
        </select>
      </Labelled>

      {/* Both ends of one range in one full-width box, so they pair by what they are, not by how many neighbours they have. */}
      <Show when={filters().period.kind === 'custom'}>
        <div class="wide range">
          <For each={['from', 'to'] as const}>
            {(edge) => (
              <Labelled text={edge === 'from' ? 'From' : 'To'}>
                <input
                  type="date"
                  class="field"
                  aria-label={'Custom ' + edge}
                  value={String(filters().period[edge] || '')}
                  onChange={(event) => set({ period: { ...filters().period, [edge]: event.currentTarget.value } })}
                />
              </Labelled>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.which === 'records'}>
        <Labelled text="Search">
          <input
            type="search"
            class="field"
            placeholder="Search"
            aria-label="Search descriptions"
            value={filters().search || ''}
            onChange={(event) => set({ search: event.currentTarget.value })}
          />
        </Labelled>
        <button type="button" onClick={() => set({ unconfirmedOnly: !filters().unconfirmedOnly })}>
          {filters().unconfirmedOnly ? 'Showing: needs review' : 'Showing: everything'}
        </button>
      </Show>
    </div>
  );
}
