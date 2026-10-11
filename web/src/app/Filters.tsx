/**
 * Filters.tsx — the filter bar, shared by Records and Charts.
 *
 * Three lines: search, the period, and the pills. A pill reads what it
 * filters until it is set and what it is set to afterwards, so everything
 * narrowing the screen is on it without a tap — which is why they are not
 * folded behind one "Filters" button. Anything with more choices than fit on
 * a line (the periods, the accounts, the labels) opens as a sheet from the
 * bottom instead of spreading them above the list they filter.
 *
 * A filter is a recomputation over the book on the phone, not a round trip.
 * Search still fires on `change` rather than per keystroke, because
 * recomputing Records over the whole ledger for every letter is work nobody is
 * reading.
 */

import { createSignal, For, Match, Show, Switch } from 'solid-js';
import { dayKey } from '../domain/days';
import { resolveWindow, type Period } from '../domain/query';
import { monthTitle, rangeTitle, withIcon } from './format';
import { categoryIcon, subcategoryIcon } from './Rows';
import { Dialog } from './Sheet';
import { clock, earliest, open, overview, setAnalyticsFilters, setRecordsFilters, view } from './state';
import { chosenAccounts, periodId, periodUnit, stepPeriod, type AnalyticsFilters, type RecordsFilters } from './view';

type Picking = 'period' | 'accounts' | 'label' | null;

/** One choice in a sheet. Marked by `aria-selected`, as the category picker's are. */
function Choice(props: { text: string; chosen: boolean; onPick: () => void }) {
  return (
    <button type="button" role="option" class="catpick-option" aria-selected={props.chosen ? 'true' : 'false'} onClick={() => props.onPick()}>
      {props.text}
    </button>
  );
}

export function FilterBar(props: { which: 'records' | 'analytics' }) {
  const onRecords = () => props.which === 'records';
  const filters = (): AnalyticsFilters => (onRecords() ? view().records : view().analytics);
  const set = (change: Partial<RecordsFilters>) => (onRecords() ? setRecordsFilters(change) : setAnalyticsFilters(change));
  const [picking, setPicking] = createSignal<Picking>(null);
  const close = () => setPicking(null);

  // ---- the period ----

  /*
    Without "Last month" and "A month": the arrows reach both, and every other
    month besides. A bookmark of either still opens, and is named by its month.
  */
  const periods = () => (overview()?.lists.periods || []).filter((entry) => entry.kind !== 'last_month' && entry.kind !== 'month');
  const unit = () => {
    const now = clock();
    return now ? periodUnit(filters().period, now) : null;
  };
  const stepped = (by: 1 | -1) => {
    const now = clock();
    return now ? stepPeriod(filters().period, by, now, earliest()) : null;
  };
  const step = (by: 1 | -1) => {
    const period = stepped(by);
    if (period) set({ period });
  };
  const periodName = () => {
    const period = filters().period;
    const at = unit();
    if (at) return at.unit === 'month' ? monthTitle(at.year, at.month) : String(at.year);
    if (period.kind === 'custom') {
      return period.from && period.to ? rangeTitle(String(period.from), String(period.to), clock()?.year ?? 0) : 'Custom';
    }
    return periods().find((entry) => entry.id === period.kind)?.label || 'Period';
  };

  /*
    Matched on `id`, not on `kind`: every named year is `kind: 'year'`, and a
    bare `{kind: 'year'}` resolves to *this* year. Custom starts as the stretch
    already on screen, so the two dates open on something true and the sheet
    stays up for them to be changed.
  */
  const choosePeriod = (id: string) => {
    const entry = periods().find((option) => option.id === id);
    if (!entry) return;
    if (entry.kind !== 'custom') {
      set({ period: entry.year ? { kind: entry.kind, year: entry.year } : { kind: entry.kind } });
      return close();
    }
    const now = clock();
    if (filters().period.kind === 'custom' || !now) return;
    const shown = resolveWindow(filters().period, now);
    set({ period: { kind: 'custom', from: dayKey(shown.from), to: dayKey(shown.to) } });
  };

  // ---- accounts and labels ----

  const accounts = () => chosenAccounts(filters().account);
  /** A chosen account the tab no longer offers is still listed, or a bookmark would filter with no way to undo it. */
  const accountNames = () => {
    const list = (open()?.lists.accounts || []).slice();
    for (const name of accounts()) if (list.indexOf(name) === -1) list.push(name);
    return list;
  };
  const toggleAccount = (name: string) => {
    const next = accounts().indexOf(name) === -1 ? [...accounts(), name] : accounts().filter((entry) => entry !== name);
    // Sorted, so A-then-B and B-then-A are one question and one URL.
    set({ account: next.length ? next.sort() : 'All' });
  };
  const accountsName = () => {
    const chosen = accounts();
    return chosen.length ? chosen[0] + (chosen.length > 1 ? ' +' + (chosen.length - 1) : '') : 'Accounts';
  };
  const label = () => (filters().label !== 'All' ? filters().label : '');
  const labels = () => overview()?.lists.labels || [];

  // ---- what a drill from Charts narrowed Records to ----

  /*
    These have no pill of their own — Charts sets them — so each is drawn
    filled, with a ✕, and all it does is go. Clearing the category clears its
    subcategory: a child alone names no group.
  */
  const drills = () => {
    const list: { text: string; clear: () => void }[] = [];
    if (!onRecords()) return list;
    const records = view().records;
    if (records.spendOnly) list.push({ text: 'Money out', clear: () => setRecordsFilters({ spendOnly: false }) });
    if (records.incomeOnly) list.push({ text: 'Money in', clear: () => setRecordsFilters({ incomeOnly: false }) });
    if (records.category !== 'All') {
      list.push({
        text: withIcon(categoryIcon(records.category), records.category),
        clear: () => setRecordsFilters({ category: 'All', subcategory: 'All' })
      });
    }
    if (records.subcategory !== 'All') {
      list.push({ text: withIcon(subcategoryIcon(records.subcategory), records.subcategory), clear: () => setRecordsFilters({ subcategory: 'All' }) });
    }
    return list;
  };
  const reviewOnly = () => onRecords() && view().records.unconfirmedOnly;
  const narrowing = () => (accounts().length ? 1 : 0) + (label() ? 1 : 0) + (reviewOnly() ? 1 : 0) + drills().length;
  /** Everything the pills hold. The period and the search are not pills, and stay. */
  const clearAll = () =>
    onRecords()
      ? setRecordsFilters({ account: 'All', label: 'All', unconfirmedOnly: false, spendOnly: false, incomeOnly: false, category: 'All', subcategory: 'All' })
      : setAnalyticsFilters({ account: 'All', label: 'All' });

  return (
    <div class="filters">
      <Show when={onRecords()}>
        <div class="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
          <input
            type="search"
            class="field"
            placeholder="Search transactions"
            aria-label="Search descriptions"
            value={view().records.search || ''}
            onChange={(event) => set({ search: event.currentTarget.value })}
          />
        </div>
      </Show>

      {/* The arrows go, rather than grey out, for a period that is no one month or year: there is nothing either would move by. */}
      <div class="stepper">
        <Show when={unit()}>
          <button type="button" class="step" aria-label={'Previous ' + unit()?.unit} disabled={!stepped(-1)} onClick={() => step(-1)}>
            ‹
          </button>
        </Show>
        <button type="button" class="when" aria-haspopup="dialog" aria-label={'Period: ' + periodName()} onClick={() => setPicking('period')}>
          {periodName()}
        </button>
        <Show when={unit()}>
          <button type="button" class="step" aria-label={'Next ' + unit()?.unit} disabled={!stepped(1)} onClick={() => step(1)}>
            ›
          </button>
        </Show>
      </div>

      <div class="chips">
        <button
          type="button"
          class={['chip', 'opens', { on: accounts().length > 0 }]}
          aria-haspopup="dialog"
          aria-label={'Accounts: ' + (accounts().join(', ') || 'all')}
          onClick={() => setPicking('accounts')}
        >
          {accountsName()}
        </button>
        <button
          type="button"
          class={['chip', 'opens', { on: !!label() }]}
          aria-haspopup="dialog"
          aria-label={'Label: ' + (label() || 'all')}
          onClick={() => setPicking('label')}
        >
          {label() || 'Label'}
        </button>
        <Show when={onRecords()}>
          <button type="button" class="chip" aria-pressed={reviewOnly() ? 'true' : 'false'} onClick={() => set({ unconfirmedOnly: !reviewOnly() })}>
            Needs review
          </button>
        </Show>
        <For each={drills()}>
          {(drill) => (
            <button type="button" class="chip on" aria-label={'Remove filter: ' + drill.text} onClick={() => drill.clear()}>
              {drill.text}
              <span class="x">✕</span>
            </button>
          )}
        </For>
        {/* Only with more than one: beside a single pill it does what that pill does. */}
        <Show when={narrowing() > 1}>
          <button type="button" class="link" onClick={clearAll}>
            Clear
          </button>
        </Show>
      </div>

      <Dialog open={picking() !== null} onClose={close}>
        <Switch>
            <Match when={picking() === 'period'}>
              <h2>Period</h2>
              <div role="listbox" aria-label="Period">
                <For each={periods()}>
                  {(entry) => <Choice text={entry.label} chosen={entry.id === periodId(filters().period)} onPick={() => choosePeriod(entry.id)} />}
                </For>
              </div>
              {/* Both ends of one range side by side, so they pair by what they are. */}
              <Show when={filters().period.kind === 'custom'}>
                <div class="range">
                  <For each={['from', 'to'] as const}>
                    {(edge) => (
                      <div class="fld">
                        <span class="flabel">{edge === 'from' ? 'From' : 'To'}</span>
                        <input
                          type="date"
                          class="field"
                          aria-label={'Custom ' + edge}
                          value={String(filters().period[edge] || '')}
                          onChange={(event) => set({ period: { ...filters().period, [edge]: event.currentTarget.value } as Period })}
                        />
                      </div>
                    )}
                  </For>
                </div>
                <button type="button" class="primary" onClick={close}>
                  Done
                </button>
              </Show>
            </Match>

            {/* Several at a time, so a tap toggles and the sheet stays until it is dismissed. */}
            <Match when={picking() === 'accounts'}>
              <h2>Accounts</h2>
              <div role="listbox" aria-label="Accounts" aria-multiselectable="true">
                <Choice text="All accounts" chosen={!accounts().length} onPick={() => set({ account: 'All' })} />
                <For each={accountNames()}>
                  {(name) => <Choice text={name} chosen={accounts().indexOf(name) !== -1} onPick={() => toggleAccount(name)} />}
                </For>
              </div>
              <button type="button" class="primary" onClick={close}>
                Done
              </button>
            </Match>

            <Match when={picking() === 'label'}>
              <h2>Label</h2>
              <div role="listbox" aria-label="Label">
                <Choice
                  text="All labels"
                  chosen={!label()}
                  onPick={() => {
                    set({ label: 'All' });
                    close();
                  }}
                />
                <For each={labels()}>
                  {(name) => (
                    <Choice
                      text={name}
                      chosen={name === label()}
                      onPick={() => {
                        set({ label: name });
                        close();
                      }}
                    />
                  )}
                </For>
              </div>
            </Match>
        </Switch>
      </Dialog>
    </div>
  );
}
