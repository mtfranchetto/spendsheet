/**
 * view.ts — which screen, with which filters, as a URL and back.
 *
 * The parameter names are the Apps Script viewer's (`webAppView_`), so a
 * bookmark taken there opens the same screen here. What is new is that the
 * page owns its address: `history.replaceState` rather than
 * `google.script.history`, and the query string read directly rather than
 * templated into the document by the server.
 *
 * Only what differs from a screen's defaults is written, so the ordinary open
 * is a bare `/` — and a URL that is right every time is one you can bookmark.
 */

import type { Filters, Period } from '../domain/query';

export const SCREENS = ['dashboard', 'records', 'analytics', 'add', 'value'] as const;
export type Screen = (typeof SCREENS)[number];

export const PARAMS = { view: 'v', period: 'p', from: 'from', to: 'to', account: 'a', label: 'l', search: 'q', unconfirmed: 'u' } as const;

export type AnalyticsFilters = Required<Pick<Filters, 'period' | 'account' | 'label'>>;
export type RecordsFilters = Required<Omit<Filters, 'account'>> & { account: string | string[] };
export type View = { screen: Screen; analytics: AnalyticsFilters; records: RecordsFilters };

/** The server's defaults, which were `appDefaultFilters_`'s and are `payloads.ts`'s now. */
export function defaultView(): View {
  return {
    screen: 'dashboard',
    analytics: { period: { kind: 'mtd' }, account: 'All', label: 'All' },
    records: {
      period: { kind: 'ytd' }, account: 'All', label: 'All', search: '', unconfirmedOnly: false,
      spendOnly: false, incomeOnly: false, category: 'All', subcategory: 'All'
    }
  };
}

/** A period back to the id the period list uses: `year:2024`, `month:2026-03`, or its kind. */
export function periodId(spec: Period | undefined): string {
  if (!spec || !spec.kind) return 'mtd';
  if (spec.kind === 'year' && spec.year) return 'year:' + spec.year;
  if (spec.kind === 'month' && spec.year && spec.month) {
    return 'month:' + spec.year + '-' + String(spec.month).padStart(2, '0');
  }
  return spec.kind;
}

/**
 * The `<option>` a period stands for — **not** `periodId`: one option covers
 * all twelve months ("A month…", with chips for which), so `month:2026-03`
 * selects `month`. The URL keeps the full id, or a bookmark forgets its month.
 */
export function periodOptionId(spec: Period | undefined): string {
  return spec && spec.kind === 'month' ? 'month' : periodId(spec);
}

const NAMED = ['week', 'mtd', 'last_month', 'ytd', 'last_12'];

/**
 * A period id back to a spec, or null for one nothing can resolve.
 *
 * `year:` and `month:` are read by pattern, checked first: anything else after
 * the colon is a hand-edited URL, and the default is a better answer than a
 * window built out of a NaN. `custom` needs both ends or neither — one alone
 * resolves to a window ending today, which is not what was bookmarked.
 */
export function periodFromId(id: string, from: string | null, to: string | null, thisYear: number): Period | null {
  const year = /^year:(\d{4})$/.exec(id);
  if (year) {
    const value = Number(year[1]);
    return value >= 1990 && value <= thisYear ? { kind: 'year', year: value } : null;
  }
  const month = /^month:(\d{4})-(\d{2})$/.exec(id);
  if (month) {
    const value = Number(month[2]);
    return value >= 1 && value <= 12 ? { kind: 'month', year: Number(month[1]), month: value } : null;
  }
  if (id === 'custom') {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    return from && to && day.test(from) && day.test(to) ? { kind: 'custom', from, to } : null;
  }
  return NAMED.indexOf(id) === -1 ? null : { kind: id };
}

/**
 * The view a query string asks for, over the defaults.
 *
 * Search and the review toggle apply to Records only: Charts draws no control
 * for either, so one set there would narrow every total with no way to see or
 * clear it.
 */
export function parseView(search: string, thisYear: number): View {
  const params = new URLSearchParams(search);
  const view = defaultView();

  const screen = params.get(PARAMS.view);
  if (screen && (SCREENS as readonly string[]).indexOf(screen) !== -1) view.screen = screen as Screen;
  if (view.screen === 'dashboard') return view;

  const filters: AnalyticsFilters | RecordsFilters = view.screen === 'records' ? view.records : view.analytics;
  const period = params.get(PARAMS.period);
  if (period) {
    const spec = periodFromId(period, params.get(PARAMS.from), params.get(PARAMS.to), thisYear);
    if (spec) filters.period = spec;
  }
  const accounts = params.getAll(PARAMS.account).filter(Boolean);
  if (accounts.length) filters.account = [...new Set(accounts)].sort();
  const label = params.get(PARAMS.label);
  if (label) filters.label = label;

  if (view.screen === 'records') {
    const text = params.get(PARAMS.search);
    if (text) view.records.search = text;
    if (params.get(PARAMS.unconfirmed)) view.records.unconfirmedOnly = true;
  }
  return view;
}

/** The accounts a filter has chosen; `All` and an empty list are the same answer. */
export function chosenAccounts(account: string | string[] | undefined): string[] {
  if (Array.isArray(account)) return account.slice();
  return account && account !== 'All' ? [account] : [];
}

/**
 * The query string for a view, holding only what differs from its defaults.
 * Accounts are repeated rather than joined: a separator is a bet that no
 * account is ever named with it in it.
 */
export function viewSearch(view: View): string {
  const params = new URLSearchParams();
  if (view.screen === 'dashboard') return '';
  params.set(PARAMS.view, view.screen);
  // The two forms have no filters: the screen is the whole address.
  if (view.screen === 'add' || view.screen === 'value') return '?' + params.toString();

  const defaults = defaultView()[view.screen];
  const filters: Filters = view[view.screen];
  const id = periodId(filters.period);
  if (id !== periodId(defaults.period)) params.set(PARAMS.period, id);
  if (filters.period && filters.period.kind === 'custom') {
    if (filters.period.from) params.set(PARAMS.from, String(filters.period.from));
    if (filters.period.to) params.set(PARAMS.to, String(filters.period.to));
  }
  for (const name of chosenAccounts(filters.account)) params.append(PARAMS.account, name);
  if (filters.label && filters.label !== 'All') params.set(PARAMS.label, filters.label);
  if (view.screen === 'records') {
    if (view.records.search) params.set(PARAMS.search, view.records.search);
    if (view.records.unconfirmedOnly) params.set(PARAMS.unconfirmed, '1');
  }
  return '?' + params.toString();
}
