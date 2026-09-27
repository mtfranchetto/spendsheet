/**
 * query.ts — the ledger asked a question, in the browser.
 *
 * **`tests/parity.test.mjs` holds it to the Apps Script viewer it replaced**,
 * whose every answer over one book at four awkward instants is recorded in
 * `tests/parity/`. A behaviour changed here is a red test until the recording
 * is changed too, and changing it is a decision that the old answer was wrong
 * — say which field and why.
 *
 * Three things about time:
 *
 *   - Every date is a **day number** from `dayOf`, never a `Date`. The API
 *     sends serials, and `days.ts` says why that is the easier case.
 *   - **"Today" is a `Clock`**, the book's calendar, passed in, because the
 *     phone's own zone is not the book's.
 *   - Rows carry their own `_day`, computed once in `ledgerOf`, because a sort
 *     over 4,600 rows that re-derives two dates per comparison is the one shape
 *     in this file that would be slow.
 */

import type { Cell } from '../sheets/records';
import type { Book, Row } from './book';
import { cellNumber, isBlankCell, isTruthyCell, round2, text } from './cells';
import {
  addMonths, dayKey, dayOf, monthKey, startOfMonth, startOfMonthDay, timeOfDay, type Clock
} from './days';
import { normalizeMerchant } from './merchant';
import {
  DASHBOARD_TREND_DAYS, QUERY_DAILY_MAX_DAYS, QUERY_GROUP_LIMIT, QUERY_PAGE_SIZE,
  TX_SOURCE_API, TX_SOURCE_CASH, TX_TYPE
} from './schema';

export type Window = { kind: string; from: number; to: number };

export type Period = {
  kind?: string;
  from?: Cell;
  to?: Cell;
  year?: number | string;
  month?: number | string;
};

export type Filters = {
  period?: Period;
  account?: string | string[];
  label?: string;
  search?: string;
  unconfirmedOnly?: boolean;
  spendOnly?: boolean;
  incomeOnly?: boolean;
  category?: string;
  subcategory?: string;
};

type Scope = { account?: string | string[]; label?: string; window?: Window };

/** A ledger row with its booking day already worked out. */
export type LedgerRow = Row & { _day: number | null };

export function ledgerOf(book: Book): LedgerRow[] {
  return book.transactions.map((row) => Object.assign(row, { _day: dayOf(row.booking_date, book.timeZone) }));
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * A period to a pair of day numbers, inclusive. `custom` takes `yyyy-MM-dd`
 * strings (or serials) and is swapped when backwards; an unknown kind is `mtd`.
 */
export function resolveWindow(spec: Period | undefined, clock: Clock): Window {
  const today = clock.today;
  const request = spec || {};
  const kind = String(request.kind || 'mtd');

  if (kind === 'custom') {
    let from = dayOf(request.from, clock.timeZone);
    let to = dayOf(request.to, clock.timeZone);
    if (from === null && to === null) return monthToDate(clock);
    if (from === null) from = to;
    if (to === null) to = today;
    return (from as number) <= to
      ? { kind, from: from as number, to }
      : { kind, from: to, to: from as number };
  }

  if (kind === 'week') return { kind, from: today - ((clock.weekday + 6) % 7), to: today };
  if (kind === 'ytd') return { kind, from: startOfMonth(clock.year, 0), to: today };

  if (kind === 'last_month') {
    const first = startOfMonth(clock.year, clock.month);
    return { kind, from: addMonths(first, -1), to: first - 1 };
  }

  if (kind === 'month') {
    const year = Number(request.year) || clock.year;
    let month = Number(request.month);
    if (!(month >= 1 && month <= 12)) month = clock.month + 1;
    const start = startOfMonth(year, month - 1);
    return { kind, from: start, to: addMonths(start, 1) - 1 };
  }

  if (kind === 'year') {
    const year = Number(request.year) || clock.year;
    return { kind, from: startOfMonth(year, 0), to: startOfMonth(year + 1, 0) - 1 };
  }

  if (kind === 'last_12') {
    const thisMonth = startOfMonth(clock.year, clock.month);
    return { kind, from: addMonths(thisMonth, -11), to: today };
  }

  return monthToDate(clock);
}

function monthToDate(clock: Clock): Window {
  return { kind: 'mtd', from: startOfMonth(clock.year, clock.month), to: clock.today };
}

/** The same stretch of last month, clamped to its last day. */
export function lastMonthToDate(clock: Clock): Window {
  const start = startOfMonth(clock.year, clock.month - 1);
  const lastDay = addMonths(start, 1) - 1;
  const sameDay = start + (clock.date - 1);
  return { kind: 'last_month_to_date', from: start, to: Math.min(sameDay, lastDay) };
}

export function windowOut(window: Window) {
  return { kind: window.kind, from: dayKey(window.from), to: dayKey(window.to) };
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Does this row belong in a spending answer for these filters?
 *
 * **`in_reports` is the single column that decides what counts as spending.**
 * Every report asks it and nothing re-derives the answer — that is the whole
 * reason the column exists, after six dashboard blocks each re-deciding it and
 * one of them getting it wrong. Read with `isTruthyCell`, because a spilled
 * formula may hand back text rather than a boolean.
 *
 * The label is matched against the split parts rather than as a substring, so
 * `travel` does not match `business-travel`. `account` is matched on the name
 * rather than the id, because the name is what the phone offers a list of.
 */
export function matchesFilters(row: LedgerRow, filters: Scope): boolean {
  const want = filters || {};
  if (!isTruthyCell(row.in_reports)) return false;
  if (!matchesAccount(row, want)) return false;

  const day = row._day;
  if (day === null) return false;
  if (want.window && (day < want.window.from || day > want.window.to)) return false;

  if (want.label && want.label !== 'All') {
    if (splitLabels(row.labels).indexOf(String(want.label)) === -1) return false;
  }
  return true;
}

export function matchesAccount(row: { readonly [column: string]: unknown }, filters: Scope | undefined): boolean {
  const want = (filters || {}).account;
  if (!want || want === 'All') return true;

  const name = String(row.account_name || '');
  if (!Array.isArray(want)) return name === String(want);
  if (!want.length || want.indexOf('All') !== -1) return true;
  return want.some((entry) => String(entry) === name);
}

/** `kids, travel` as `['kids','travel']`; a boolean is not a label. */
export function splitLabels(value: Cell | undefined): string[] {
  if (isBlankCell(value) || typeof value === 'boolean') return [];
  return String(value).split(',').map((part) => part.trim()).filter((part) => part.length > 0);
}

// ---------------------------------------------------------------------------
// Aggregating
// ---------------------------------------------------------------------------

type Totals = { [name: string]: number };
type Bucket = { key: string; expenses: number; income: number; net: number };

export function groupKey(name: Cell | undefined): string {
  return isBlankCell(name) ? '(uncategorised)' : String(name);
}

function addTo(target: Totals, name: Cell | undefined, amount: number) {
  const key = groupKey(name);
  target[key] = (target[key] || 0) + amount;
}

function addUnder(target: { [parent: string]: Totals }, parent: Cell | undefined, child: Cell | undefined, amount: number) {
  const key = groupKey(parent);
  if (!target[key]) target[key] = {};
  addTo(target[key], child, amount);
}

export function aggregate(rows: readonly LedgerRow[], window: Window | null) {
  const totals = { expenses: 0, income: 0, net: 0, count: 0, unconvertible: 0 };
  const byCategory: Totals = {};
  const bySubcategory: Totals = {};
  const childrenOf: { [parent: string]: Totals } = {};
  const buckets: { [key: string]: Bucket } = {};
  const monthly = window ? window.to - window.from > QUERY_DAILY_MAX_DAYS : false;

  for (const row of rows || []) {
    const amount = cellNumber(row.amount_base);
    if (amount === null) {
      totals.unconvertible++;
      continue;
    }

    totals.count++;
    totals.net += amount;
    if (amount < 0) totals.expenses += -amount;
    else totals.income += amount;

    if (amount < 0) {
      addTo(byCategory, row.category, -amount);
      addTo(bySubcategory, row.subcategory, -amount);
      addUnder(childrenOf, row.category, row.subcategory, -amount);
    }

    const day = row._day as number;
    const key = monthly ? monthKey(day) : dayKey(day);
    if (!buckets[key]) buckets[key] = { key, expenses: 0, income: 0, net: 0 };
    buckets[key].net += amount;
    if (amount < 0) buckets[key].expenses += -amount;
    else buckets[key].income += amount;
  }

  totals.expenses = round2(totals.expenses);
  totals.income = round2(totals.income);
  totals.net = round2(totals.net);

  return {
    totals,
    byCategory: nestedTotals(byCategory, childrenOf),
    bySubcategory: rankedTotals(bySubcategory),
    cashflow: filledBuckets(buckets, window, monthly),
    bucketSize: monthly ? 'month' : 'day'
  };
}

function nestedTotals(byCategory: Totals, childrenOf: { [parent: string]: Totals }) {
  return rankedTotals(byCategory).map((entry) => {
    const children = rankedTotals(childrenOf[entry.name] || {});
    return {
      name: entry.name,
      total: entry.total,
      children: children.length === 1 && children[0].total === entry.total ? [] : children
    };
  });
}

function rankedTotals(totals: Totals) {
  return Object.keys(totals)
    .map((name) => ({ name, total: round2(totals[name]) }))
    .sort((a, b) => b.total - a.total)
    .slice(0, QUERY_GROUP_LIMIT);
}

function filledBuckets(buckets: { [key: string]: Bucket }, window: Window | null, monthly: boolean): Bucket[] {
  if (!window) return [];

  const out: Bucket[] = [];
  let cursor = monthly ? startOfMonthDay(window.from) : window.from;
  let guard = 0;
  while (cursor <= window.to && guard++ < 400) {
    const key = monthly ? monthKey(cursor) : dayKey(cursor);
    out.push(buckets[key] || { key, expenses: 0, income: 0, net: 0 });
    cursor = monthly ? addMonths(cursor, 1) : cursor + 1;
  }

  return out.map((bucket) => ({
    key: bucket.key,
    expenses: round2(bucket.expenses),
    income: round2(bucket.income),
    net: round2(bucket.net)
  }));
}

// ---------------------------------------------------------------------------
// The balance trend
// ---------------------------------------------------------------------------

/**
 * Net worth on each day of the window: today's balance minus what was booked
 * after each day.
 *
 * **The one function here that does not filter `in_reports`**, deliberately.
 * A transfer between your own accounts moves a balance, so it belongs in a net
 * worth series even though it is not spending; a row you excluded from reports
 * still left your account. Asking net worth the spending question is how the
 * curve ends up disagreeing with the number above it. And it takes every row
 * rather than the windowed ones, because the first day of a past window needs
 * everything booked between that day and today — all of it outside the window.
 */
export function balanceSeries(rows: readonly LedgerRow[], window: Window | null, balanceNow: number, clock: Clock) {
  if (!window) return [];

  const after: { [day: number]: number } = {};
  for (const row of rows || []) {
    const amount = cellNumber(row.amount_base);
    if (amount === null) continue;
    const day = row._day;
    if (day === null) continue;
    after[day] = (after[day] || 0) + amount;
  }

  const last = Math.min(window.to, clock.today);
  let running = 0;
  const values: { [day: number]: number } = {};
  for (let day = last; day >= window.from; day--) {
    values[day] = balanceNow - running;
    running += after[day] || 0;
  }

  const series: { key: string; value: number }[] = [];
  for (let d = window.from; d <= last; d++) series.push({ key: dayKey(d), value: round2(values[d]) });
  return series;
}

export function recentBalanceTrend(rows: readonly LedgerRow[], clock: Clock, balanceNow: number) {
  return balanceSeries(rows,
    { kind: 'trend', from: clock.today - (DASHBOARD_TREND_DAYS - 1), to: clock.today },
    balanceNow, clock);
}

export function baseCurrency(book: Book): string {
  return String(book.config.base_currency || 'EUR');
}

/** Every included, active, base-currency account's balance; the rest are counted as skipped. */
export function netWorthNow(book: Book, filters: Scope) {
  const summary = { total: 0, counted: 0, skipped: 0, currency: baseCurrency(book) };

  for (const account of book.accounts) {
    if (isBlankCell(account.account_id)) continue;
    if (!isTruthyCell(account.active)) continue;
    if (!matchesAccount({ account_name: account.name }, filters)) continue;

    const balance = cellNumber(account.balance);
    if (!isTruthyCell(account.include_in_net_worth) ||
        String(account.currency || '') !== summary.currency ||
        balance === null) {
      summary.skipped++;
      continue;
    }
    summary.total += balance;
    summary.counted++;
  }

  summary.total = round2(summary.total);
  return summary;
}

// ---------------------------------------------------------------------------
// The two things a page asks for
// ---------------------------------------------------------------------------

export function analytics(book: Book, ledger: readonly LedgerRow[], filters: Filters | undefined, clock: Clock) {
  const request = filters || {};
  const window = resolveWindow(request.period, clock);
  const scope: Scope = { account: request.account, label: request.label, window };

  const matched = ledger.filter((row) => matchesFilters(row, scope));
  const result = aggregate(matched, window);
  const worth = netWorthNow(book, scope);

  return {
    ...result,
    window: windowOut(window),
    balance: balanceSeries(ledger.filter((row) => matchesAccount(row, scope)), window, worth.total, clock),
    netWorth: worth,
    currency: worth.currency
  };
}

export function recordsPage(
  book: Book, ledger: readonly LedgerRow[], filters: Filters | undefined, offset: number | undefined, clock: Clock,
  size: number = QUERY_PAGE_SIZE
) {
  const request = filters || {};
  const window = resolveWindow(request.period, clock);
  const scope = { account: request.account, label: request.label, window };

  const matched = ledger
    .filter((row) => matchesRecordFilters(row, scope, request))
    .sort((a, b) => {
      const byDate = (b._day as number) - (a._day as number);
      return byDate !== 0 ? byDate : b._row - a._row;
    });

  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const page = matched.slice(start, start + Math.max(1, Math.floor(size)));
  const peers = transferPeers(ledger);

  return {
    rows: page.map((row) => recordForPage(row, peers, book.timeZone)),
    total: matched.length,
    offset: start,
    hasMore: start + page.length < matched.length,
    pending: start === 0 && !isDrilled(request) ? pendingForPage(book, scope, request, clock) : [],
    currency: baseCurrency(book),
    window: windowOut(window)
  };
}

/** The holds, beside the rows rather than among them; a window in the past leaves out this week's. */
function pendingForPage(book: Book, scope: Scope & { window: Window }, request: Filters, clock: Clock) {
  const zone = book.timeZone;
  const search = String(request.search || '').trim().toLowerCase();

  return book.pending
    .map((row) => ({ row, day: dayOf(row.booking_date, zone) }))
    .filter(({ row, day }) => {
      if (!matchesAccount(row, scope)) return false;
      if (!(clock.today <= scope.window.to) &&
          !(day !== null && day >= scope.window.from && day <= scope.window.to)) {
        return false;
      }
      if (!search) return true;
      return [row.description, row.counterparty].some((field) =>
        String(field == null ? '' : field).toLowerCase().indexOf(search) !== -1);
    })
    .sort((a, b) => (b.day || 0) - (a.day || 0))
    .map(({ row, day }) => ({
      uid: text(row.uid),
      date: dayKey(day),
      time: timeOfDay(row.transaction_date, zone),
      account: text(row.account_name),
      description: String(row.description || row.counterparty || ''),
      amount: cellNumber(row.amount),
      currency: text(row.currency),
      pending: true
    }));
}

export function matchesRecordFilters(row: LedgerRow, scope: Scope & { window: Window }, request: Filters): boolean {
  if (!matchesAccount(row, scope)) return false;

  const day = row._day;
  if (day === null) return false;
  if (day < scope.window.from || day > scope.window.to) return false;

  if (scope.label && scope.label !== 'All') {
    if (splitLabels(row.labels).indexOf(String(scope.label)) === -1) return false;
  }

  if (request.spendOnly || request.incomeOnly) {
    if (!isTruthyCell(row.in_reports)) return false;
    const amount = cellNumber(row.amount_base);
    if (amount === null) return false;

    // Exactly zero has no sign, so it is answered by `type`. A €0.00
    // pre-authorisation — a card check at a fuel pump — is a real row, and
    // `0 > 0` and `0 < 0` are both false, so a sign test puts it on neither
    // side while the row paints and the sheet file it on one. `type` is the
    // stored answer; a zero row adds zero to whichever side takes it.
    const moneyIn = amount === 0 ? String(row.type) === TX_TYPE.INCOME : amount > 0;
    if (request.spendOnly && moneyIn) return false;
    if (request.incomeOnly && !moneyIn) return false;
  }

  if (!matchesGroup(row.category, request.category)) return false;
  if (!matchesGroup(row.subcategory, request.subcategory)) return false;
  if (request.unconfirmedOnly && isConfirmedRow(row)) return false;

  const search = String(request.search || '').trim().toLowerCase();
  if (!search) return true;
  return [row.description, row.counterparty, row.category, row.subcategory, row.labels]
    .some((field) => String(field == null ? '' : field).toLowerCase().indexOf(search) !== -1);
}

function matchesGroup(value: Cell | undefined, wanted: string | undefined): boolean {
  if (!wanted || wanted === 'All') return true;
  return groupKey(value) === String(wanted);
}

function isDrilled(request: Filters): boolean {
  const want = request || {};
  return !!want.spendOnly || !!want.incomeOnly ||
    (!!want.category && want.category !== 'All') ||
    (!!want.subcategory && want.subcategory !== 'All');
}

/** Ticked, or carrying either override — `isConfirmedRow_` in `14_categorize.gs`. */
export function isConfirmedRow(row: Row): boolean {
  if (isTruthyCell(row.confirmed)) return true;
  return !isBlankCell(row.category_override) || !isBlankCell(row.subcategory_override);
}

export type Peers = { of(row: Row): { account: string; direction: 'from' | 'to' } | null };

export function recordForPage(row: LedgerRow, peers: Peers | null, timeZone: string) {
  const peer = peers ? peers.of(row) : null;
  return {
    uid: text(row.uid),
    date: dayKey(row._day),
    time: timeOfDay(row.transaction_date, timeZone),
    account: text(row.account_name),
    description: String(row.description || row.counterparty || ''),
    amount: cellNumber(row.amount_base),
    rawAmount: cellNumber(row.amount),
    currency: text(row.currency),
    category: text(row.category),
    subcategory: text(row.subcategory),
    categoryAuto: text(row.category_auto),
    merchantKey: normalizeMerchant(row.description, row.counterparty),
    labels: splitLabels(row.labels),
    type: text(row.type),
    source: text(row.category_source),
    confirmed: isConfirmedRow(row),
    inReports: isTruthyCell(row.in_reports),
    editableDescription: descriptionIsEditable(row.source),
    editableAmount: amountIsEditable(row.source, row.transfer_group),
    deletable: recordIsDeletable(row.source),
    peerAccount: peer ? peer.account : '',
    peerDirection: peer ? peer.direction : ''
  };
}

export type PageRecord = ReturnType<typeof recordForPage>;

/** `transfer_group` → the other leg; a group that is not exactly a pair answers nothing. */
export function transferPeers(ledger: readonly Row[]): Peers {
  const groups: { [group: string]: Row[] } = {};
  for (const row of ledger || []) {
    const group = text(row.transfer_group);
    if (!group) continue;
    (groups[group] ||= []).push(row);
  }

  return {
    of(row) {
      const group = text(row.transfer_group);
      const members = group ? groups[group] : null;
      if (!members || members.length !== 2) return null;

      const other = members[0]._row === row._row ? members[1] : members[0];
      if (other._row === row._row) return null;

      let amount = cellNumber(row.amount_base);
      if (amount === null) amount = cellNumber(row.amount);
      return {
        account: text(other.account_name),
        direction: amount !== null && amount > 0 ? 'from' : 'to'
      };
    }
  };
}

function sourceText(source: Cell | undefined): string {
  return String(source === null || source === undefined ? '' : source);
}

/** A bank will fetch a synced row again, and its description is in the uid. */
export function descriptionIsEditable(source: Cell | undefined): boolean {
  return sourceText(source) !== TX_SOURCE_API;
}

/** Cash you typed, and nothing else. */
export function recordIsDeletable(source: Cell | undefined): boolean {
  return sourceText(source) === TX_SOURCE_CASH;
}

/** Cash you typed, while no transfer mirrors its figure. */
export function amountIsEditable(source: Cell | undefined, transferGroup: Cell | undefined): boolean {
  return sourceText(source) === TX_SOURCE_CASH && isBlankCell(transferGroup);
}
