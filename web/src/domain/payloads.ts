/**
 * payloads.ts — what `23_api.gs` answers, computed from one book on the phone.
 *
 * The same five answers under the same shapes — `appOpen`, `appOverview`,
 * `appRecords`, `appAnalytics`, `appDashboard` — so the screens carried over
 * from `page.*` draw what they drew before, and the parity test can hold every
 * field of every one to the `.gs`.
 *
 * What does not carry over is the reason there were five. The Apps Script
 * viewer split the screen into two calls because each round trip cost ~2.7s
 * before any code ran, and it prefetched Records but not Charts because Charts
 * cost ~800ms of server time. Here all five are functions over data already in
 * memory, so the split is kept only as the shape the screens expect.
 */

import type { Book, Row } from './book';
import { configNumber } from './book';
import { cellNumber, isBlankCell, isTruthyCell, text } from './cells';
import { dayKey, dayOf, serialOf, type Clock } from './days';
import { appHealth } from './health';
import { buildMemoryIndex, suggestCategory, suggestionIndex } from './merchant';
import {
  aggregate, analytics, baseCurrency, isConfirmedRow, lastMonthToDate, matchesFilters,
  netWorthNow, recentBalanceTrend, recordForPage, recordsPage, resolveWindow, transferPeers,
  type Filters, type LedgerRow
} from './query';
import { ACCOUNT_KIND, ACCOUNT_KINDS, CATEGORY_SOURCE, DASHBOARD_TREND_DAYS } from './schema';

/** The filters each screen opens on — Charts on this month, Records on the year so far. */
export function appDefaultFilters() {
  return {
    analytics: { period: { kind: 'mtd' }, account: 'All', label: 'All' },
    records: { period: { kind: 'ytd' }, account: 'All', label: 'All',
      search: '', unconfirmedOnly: false,
      spendOnly: false, incomeOnly: false, category: 'All', subcategory: 'All' }
  };
}

// ---------------------------------------------------------------------------
// The half that needs no ledger
// ---------------------------------------------------------------------------

export function appOpenData(book: Book, clock: Clock) {
  return {
    currency: baseCurrency(book),
    netWorth: netWorthNow(book, {}),
    accounts: appAccounts(book, clock),
    lists: {
      accounts: accountNames(book),
      cashAccounts: cashAccountList(book),
      assetAccounts: assetAccountList(book)
    },
    generatedAt: dayKey(clock.today)
  };
}

function activeAccounts(book: Book): Row[] {
  return book.accounts.filter((account) => account.account_id && isTruthyCell(account.active));
}

export function appAccounts(book: Book, clock: Clock) {
  const consent = consentDaysByConnection(book);
  const warnAt = configNumber(book.config, 'consent_warning_days');
  const staleAfter = configNumber(book.config, 'stale_balance_days');

  return activeAccounts(book)
    .map((account) => {
      const days = consent[text(account.connection_id)];
      const updated = dayOf(account.balance_updated_at, book.timeZone);
      const state = accountState(account, days, updated, clock.today, warnAt, staleAfter);
      return {
        name: String(account.name || account.account_id),
        kind: text(account.kind),
        currency: text(account.currency),
        balance: cellNumber(account.balance),
        updated: updated === null ? '' : dayKey(updated),
        inNetWorth: isTruthyCell(account.include_in_net_worth),
        severity: state.severity,
        sync: state.sync
      };
    })
    .sort((a, b) => {
      const byKind = accountKindRank(a.kind) - accountKindRank(b.kind);
      return byKind || (b.balance || 0) - (a.balance || 0);
    });
}

function accountKindRank(kind: string): number {
  const rank = (ACCOUNT_KINDS as readonly string[]).indexOf(String(kind || ''));
  return rank === -1 ? ACCOUNT_KINDS.length : rank;
}

/** One severity and one sentence, for the worst thing true of the account. */
function accountState(
  account: Row, days: number | null | undefined, updated: number | null,
  today: number, warnAt: number, staleAfter: number
) {
  if (text(account.kind) !== ACCOUNT_KIND.BANK) return { severity: 0, sync: '—' };
  if (days === null || days === undefined) return { severity: 2, sync: 'reconnect — no consent' };
  if (days <= 0) return { severity: 2, sync: 'reconnect — consent expired' };
  if (days <= warnAt) return { severity: 1, sync: 'expires in ' + days + ' days' };
  if (updated !== null && today - updated > staleAfter) {
    return { severity: 1, sync: 'balance ' + (today - updated) + ' days old' };
  }
  return { severity: 0, sync: 'ok' };
}

function consentDaysByConnection(book: Book): { [connection: string]: number | null } {
  const days: { [connection: string]: number | null } = {};
  for (const row of book.status) {
    if (isBlankCell(row.connection_id)) continue;
    days[String(row.connection_id)] = cellNumber(row.days_left);
  }
  return days;
}

function accountNames(book: Book): string[] {
  return activeAccounts(book).filter((account) => account.name).map((account) => String(account.name));
}

function cashAccountList(book: Book): string[] {
  return activeAccounts(book)
    .filter((account) => text(account.kind) === ACCOUNT_KIND.CASH)
    .map((account) => String(account.name || account.account_id));
}

/** Carries balances, unlike the other two: setting an asset's value is a difference. */
function assetAccountList(book: Book) {
  return activeAccounts(book)
    .filter((account) => text(account.kind) === ACCOUNT_KIND.ASSET)
    .map((account) => ({
      name: String(account.name || account.account_id),
      balance: cellNumber(account.balance),
      currency: text(account.currency)
    }));
}

// ---------------------------------------------------------------------------
// The half that needs the ledger
// ---------------------------------------------------------------------------

export function appOverviewData(book: Book, ledger: readonly LedgerRow[], clock: Clock) {
  const window = resolveWindow({ kind: 'mtd' }, clock);
  const previous = lastMonthToDate(clock);

  const month = aggregate(ledger.filter((row) => matchesFilters(row, { window })), window);
  const lastMonth = aggregate(ledger.filter((row) => matchesFilters(row, { window: previous })), previous);

  const defaults = appDefaultFilters();
  const records = recordsPage(book, ledger, defaults.records, 0, clock);

  return {
    month: {
      from: dayKey(window.from),
      to: dayKey(window.to),
      expenses: month.totals.expenses,
      income: month.totals.income,
      net: month.totals.net,
      lastMonthToDate: lastMonth.totals.expenses,
      byCategory: month.byCategory
    },
    trend: {
      days: DASHBOARD_TREND_DAYS,
      series: recentBalanceTrend(ledger, clock, netWorthNow(book, {}).total)
    },
    health: appHealth(book, clock, ledger.length),
    pending: records.pending,
    review: appReviewQueue(book, ledger),
    lists: {
      labels: labelNames(book),
      categories: categoryChoices(book),
      periods: appPeriods(ledger, clock)
    },
    screens: {
      filters: defaults,
      records
    }
  };
}

/** Everything the dashboard draws, for a refresh — both halves, every field the first paint had. */
export function appDashboardData(book: Book, ledger: readonly LedgerRow[], clock: Clock) {
  const open = appOpenData(book, clock);
  const overview = appOverviewData(book, ledger, clock);
  return {
    month: overview.month,
    accounts: open.accounts,
    netWorth: open.netWorth,
    health: overview.health,
    review: overview.review,
    trend: overview.trend,
    pending: overview.pending,
    lists: open.lists,
    currency: open.currency
  };
}

/**
 * `size` is the page's own addition: the `.gs` served one page per call, and
 * the phone holding the ledger asks for everything "Load more" has shown in
 * one pass rather than one pass per page. The rows are the same rows — a
 * prefix of one sort — which is what the parity test holds at the default.
 */
export function appRecordsData(
  book: Book, ledger: readonly LedgerRow[], filters: Filters | undefined, offset: number | undefined, clock: Clock,
  size?: number
) {
  return recordsPage(book, ledger, filters, offset, clock, size);
}

export function appAnalyticsData(book: Book, ledger: readonly LedgerRow[], filters: Filters | undefined, clock: Clock) {
  return analytics(book, ledger, filters, clock);
}

/**
 * The oldest unconfirmed rows, live off the ledger, with a memory suggestion on
 * any the cascade could not file. Oldest by the full timestamp, blanks last.
 */
export function appReviewQueue(book: Book, ledger: readonly LedgerRow[]) {
  const peers = transferPeers(ledger);
  const order = (row: Row) => {
    const serial = serialOf(row.booking_date, book.timeZone);
    return serial === null ? Infinity : serial;
  };

  const queue = ledger
    .filter((row) => !isConfirmedRow(row))
    .map((row) => ({ row, at: order(row) }))
    .sort((a, b) => (a.at === b.at ? 0 : a.at - b.at))
    .slice(0, queueSize(book))
    .map(({ row }) => row);

  const unclassified = (row: Row) => String(row.category_source) === CATEGORY_SOURCE.UNCLASSIFIED;
  const index = queue.some(unclassified) ? suggestionIndex(buildMemoryIndex(book.memory)) : null;

  return queue.map((row) => {
    const record: ReturnType<typeof recordForPage> & { suggestion?: ReturnType<typeof suggestCategory> } =
      recordForPage(row, peers, book.timeZone);
    if (index && unclassified(row)) record.suggestion = suggestCategory(record.merchantKey, index);
    return record;
  });
}

function queueSize(book: Book): number {
  const size = configNumber(book.config, 'review_queue_size');
  return size >= 1 ? Math.floor(size) : 50;
}

// ---------------------------------------------------------------------------
// The lists a filter is built from
// ---------------------------------------------------------------------------

/** Every label on the tab; a boolean is not one. */
function labelNames(book: Book): string[] {
  return book.labels
    .filter((row) => !isBlankCell(row.label) && typeof row.label !== 'boolean')
    .map((row) => String(row.label));
}

/** Parents with their first row's icon and kind, and every subcategory flat. */
function categoryChoices(book: Book) {
  const rows = book.categories.filter((row) => row.category && row.subcategory);

  const parents: string[] = [];
  const iconFor: { [name: string]: string } = {};
  const kindFor: { [name: string]: string } = {};
  for (const row of rows) {
    const name = String(row.category);
    if (parents.indexOf(name) === -1) parents.push(name);
    if (!iconFor[name] && row.icon) iconFor[name] = String(row.icon);
    if (!kindFor[name] && row.kind) kindFor[name] = String(row.kind);
  }

  return {
    parents: parents.map((name) => ({ name, icon: iconFor[name] || '', kind: kindFor[name] || '' })),
    children: rows.map((row) => ({
      name: String(row.subcategory),
      parent: String(row.category),
      icon: text(row.icon),
      kind: text(row.kind)
    }))
  };
}

/** The picker's periods, with a named year for each past year the ledger has rows in. */
export function appPeriods(ledger: readonly LedgerRow[], clock: Clock) {
  const periods: { id: string; kind: string; label: string; year?: number }[] = [
    { id: 'week', kind: 'week', label: 'This week' },
    { id: 'mtd', kind: 'mtd', label: 'This month' },
    { id: 'last_month', kind: 'last_month', label: 'Last month' },
    { id: 'month', kind: 'month', label: 'A month' },
    { id: 'ytd', kind: 'ytd', label: 'Year to date' },
    { id: 'last_12', kind: 'last_12', label: 'Last 12 months' }
  ];
  for (const year of ledgerYears(ledger, clock)) {
    periods.push({ id: 'year:' + year, kind: 'year', year, label: String(year) });
  }
  periods.push({ id: 'custom', kind: 'custom', label: 'Custom' });
  return periods;
}

function ledgerYears(ledger: readonly LedgerRow[], clock: Clock): number[] {
  const seen: number[] = [];
  for (const row of ledger || []) {
    if (row._day === null) continue;
    const year = Number(dayKey(row._day).slice(0, 4));
    if (!year || year >= clock.year) continue;
    if (seen.indexOf(year) === -1) seen.push(year);
  }
  return seen.sort((a, b) => b - a).slice(0, 10);
}
