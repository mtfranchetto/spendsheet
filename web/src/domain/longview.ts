/**
 * longview.ts — the ledger asked about the long run, in the browser.
 *
 * `query.ts` answers a period somebody picked. This answers three windows
 * nobody picks — the last twelve months, the twelve before them, and the whole
 * ledger — and returns every figure the Long view draws as plain data, so the
 * screen formats and decides nothing.
 *
 * ## The windows
 *
 *   - **T12** is the twelve months ending today: from the day after today's
 *     date a year ago, through today. On 11 October 2026 that is 12 October
 *     2025 to 11 October 2026.
 *   - **P12** is the twelve months before T12, built the same way a year
 *     further back, so anything compared between the two is like for like.
 *   - **29 February has no date a year ago**, and takes the 28th: the last day
 *     of the month, as `EDATE` has it on the reports tab, which is the second
 *     implementation these figures are checked against.
 *
 * ## A month is a complete calendar month
 *
 * Every monthly series stops at the end of last month. The month in progress
 * would draw as a short bar or as a dip at the end of a line, and both read as
 * news. At the other end, the ledger's first month counts only when its first
 * row is on the 1st: nothing else tells a month that began quietly from one the
 * ledger had not reached yet.
 *
 * ## Short history is stated, not annualised
 *
 * `history.months` counts complete months. Under twelve, nothing here divides
 * by twelve or multiplies up to a year: the monthly average, the runway and the
 * projection are `null`, and the screen says how many months the ledger holds.
 * Anything compared with P12 needs twenty-four, and is `null` under that.
 * Twelve complete months imply a first row on or before T12's first day, so
 * the one count decides both.
 *
 * ## Two kinds of row
 *
 * **Spending and income are rows where `in_reports` is true**, read from
 * `amount_base`, through `matchesFilters` — whichever account they are on.
 *
 * **Net worth takes every row, on the accounts net worth counts.** It does not
 * ask `in_reports`, for the reason `balanceSeries` gives. It does ask which
 * account: today's total is the counted accounts' balances, so walking it back
 * through rows booked on an account outside that total would move the line by
 * money the total never held. That also makes the kinds' changes sum to the
 * whole change exactly, which is what lets the remainder below be trusted.
 *
 * ## The remainder is its own row
 *
 * A year's change in net worth is split three ways: what was saved from income
 * (T12 income less spending), what assets were revalued by (rows filed under
 * `Transfer › Valuation change` and left out of reports, so no row is in both),
 * and whatever is left — money that arrived or left without being income or
 * spending, or spending on an account net worth does not count. The remainder
 * is never folded into the other two: it is the row that says the first two do
 * not explain the change.
 */

import type { Book, Row } from './book';
import { cellNumber, isBlankCell, isTruthyCell, round2, text } from './cells';
import { addMonths, dayKey, monthKey, startOfMonth, startOfMonthDay, type Clock } from './days';
import {
  aggregate, balanceSeries, baseCurrency, matchesAccount, matchesFilters, netWorthNow,
  type LedgerRow, type Window
} from './query';
import { ACCOUNT_KIND, TRANSFER_CATEGORY, VALUATION_SUBCATEGORY } from './schema';

/** Complete months before a figure may be called a year's, and before it may be compared with the year before. */
export const LONG_VIEW_YEAR_MONTHS = 12;
export const LONG_VIEW_COMPARE_MONTHS = 24;

/** How far ahead "at this pace" looks, in years. */
export const LONG_VIEW_PACE_YEARS = [1, 5, 10] as const;

/** How many categories "biggest changes" keeps: the ones that moved most, either way. */
export const LONG_VIEW_MOVERS = 8;

/** Net worth's kinds in the order they are drawn: what is invested, then what can be spent. */
const HELD_KINDS = [ACCOUNT_KIND.ASSET, ACCOUNT_KIND.BANK, ACCOUNT_KIND.CASH] as const;

/** Today's date `years` back, or the last day of that month where it has no such date. */
export function sameDate(clock: Clock, years: number): number {
  const first = startOfMonth(clock.year - years, clock.month);
  return Math.min(first + clock.date - 1, addMonths(first, 1) - 1);
}

/** T12 and P12 as day numbers, inclusive. See the header. */
export function longWindows(clock: Clock): { t12: Window; p12: Window } {
  const yearAgo = sameDate(clock, 1);
  return {
    t12: { kind: 't12', from: yearAgo + 1, to: clock.today },
    p12: { kind: 'p12', from: sameDate(clock, 2) + 1, to: yearAgo }
  };
}

/** The 1st of every complete month: from the first the ledger covers whole, to last month. */
export function completeMonths(first: number | null, clock: Clock): number[] {
  if (first === null) return [];
  const thisMonth = startOfMonth(clock.year, clock.month);
  let cursor = startOfMonthDay(first);
  if (cursor < first) cursor = addMonths(cursor, 1);

  const months: number[] = [];
  while (cursor < thisMonth) {
    months.push(cursor);
    cursor = addMonths(cursor, 1);
  }
  return months;
}

/** The earliest day any of these rows was booked on, today at the latest. */
function firstDay(rows: readonly LedgerRow[], clock: Clock): number | null {
  let first: number | null = null;
  for (const row of rows) {
    if (row._day === null || row._day > clock.today) continue;
    if (first === null || row._day < first) first = row._day;
  }
  return first;
}

function inWindow(row: LedgerRow, window: Window): boolean {
  return row._day !== null && row._day >= window.from && row._day <= window.to;
}

/** What these rows moved between them inside a window. A row with no base amount moves nothing it can state. */
function moved(rows: readonly LedgerRow[], window: Window): number {
  let total = 0;
  for (const row of rows) {
    if (!inWindow(row, window)) continue;
    const amount = cellNumber(row.amount_base);
    if (amount !== null) total += amount;
  }
  return total;
}

/** `now` against `before` as a rate, or null when there was nothing before to grow from. */
function growth(now: number, before: number): number | null {
  return before > 0 ? now / before - 1 : null;
}

/** The accounts `netWorthNow` counts, with the balance it counted. */
function countedAccounts(book: Book): { name: string; kind: string; balance: number }[] {
  const currency = baseCurrency(book);
  const counted: { name: string; kind: string; balance: number }[] = [];
  for (const account of book.accounts) {
    if (isBlankCell(account.account_id) || !isTruthyCell(account.active)) continue;
    if (!isTruthyCell(account.include_in_net_worth)) continue;
    if (String(account.currency || '') !== currency) continue;
    const balance = cellNumber(account.balance);
    if (balance === null) continue;
    counted.push({ name: String(account.name || ''), kind: text(account.kind), balance });
  }
  return counted;
}

function isRevaluation(row: Row): boolean {
  return text(row.category) === TRANSFER_CATEGORY &&
    text(row.subcategory) === VALUATION_SUBCATEGORY &&
    !isTruthyCell(row.in_reports);
}

/**
 * Net worth at the first row, at the end of each month since, and today.
 * Month ends rather than days: across years a day is narrower than the line.
 */
function worthSeries(rows: readonly LedgerRow[], total: number, clock: Clock) {
  const first = firstDay(rows, clock);
  if (first === null) return [];
  const daily = balanceSeries(rows, { kind: 'ledger', from: first, to: clock.today }, total, clock);

  const days = [first];
  for (let end = addMonths(first, 1) - 1; end < clock.today; end = addMonths(end + 1, 1) - 1) {
    if (end > first) days.push(end);
  }
  if (clock.today > first) days.push(clock.today);
  return days.map((day) => daily[day - first]);
}

export function longView(book: Book, ledger: readonly LedgerRow[], clock: Clock) {
  const { t12, p12 } = longWindows(clock);
  const reported = ledger.filter((row) => matchesFilters(row, {}));

  const first = firstDay(ledger, clock);
  const months = completeMonths(first, clock);
  const aYear = months.length >= LONG_VIEW_YEAR_MONTHS;
  const twoYears = months.length >= LONG_VIEW_COMPARE_MONTHS;

  // ---- T12 and P12 -------------------------------------------------------
  const now = aggregate(reported.filter((row) => inWindow(row, t12)), t12);
  const before = aggregate(reported.filter((row) => inWindow(row, p12)), p12);
  const spent = now.totals.expenses;
  const earned = now.totals.income;
  const saved = now.totals.net;

  // ---- Month by month ----------------------------------------------------
  const rowsOfMonth: { [key: string]: LedgerRow[] } = {};
  for (const row of reported) (rowsOfMonth[monthKey(row._day as number)] ||= []).push(row);
  const monthly = months.map((start) => {
    const key = monthKey(start);
    const totals = aggregate(rowsOfMonth[key] || [], null).totals;
    return { key, income: totals.income, expenses: totals.expenses };
  });

  const rolling: { key: string; income: number; expenses: number }[] = [];
  for (let end = LONG_VIEW_YEAR_MONTHS - 1; end < monthly.length; end++) {
    const year = monthly.slice(end - (LONG_VIEW_YEAR_MONTHS - 1), end + 1);
    rolling.push({
      key: monthly[end].key,
      income: round2(year.reduce((sum, month) => sum + month.income, 0)),
      expenses: round2(year.reduce((sum, month) => sum + month.expenses, 0))
    });
  }

  // A calendar month the ledger has no complete month of is blank, not a month that cost nothing.
  const typical = Array.from({ length: 12 }, (_, calendar) => {
    const same = monthly.filter((month) => Number(month.key.slice(5, 7)) - 1 === calendar);
    return same.length ? round2(same.reduce((sum, month) => sum + month.expenses, 0) / same.length) : null;
  });
  const present = typical.filter((value): value is number => value !== null);

  // ---- Year by year ------------------------------------------------------
  const years: { year: number; toDate: number; full: number | null }[] = [];
  for (let year = clock.year; first !== null && startOfMonth(year, 0) >= first; year--) {
    const january = startOfMonth(year, 0);
    const spendingIn = (to: number) =>
      aggregate(reported.filter((row) => inWindow(row, { kind: 'year', from: january, to })), null).totals.expenses;
    years.unshift({
      year,
      toDate: spendingIn(sameDate(clock, clock.year - year)),
      full: year < clock.year ? spendingIn(startOfMonth(year + 1, 0) - 1) : null
    });
  }

  // ---- Net worth ---------------------------------------------------------
  const worth = netWorthNow(book, {});
  const accounts = countedAccounts(book);
  const kindOf = new Map(accounts.map((account) => [account.name, account.kind]));
  // An empty list of names means every account to `matchesAccount`, so it is not asked with one.
  const counted = accounts.length
    ? ledger.filter((row) => matchesAccount(row, { account: accounts.map((account) => account.name) }))
    : [];

  const held = HELD_KINDS.flatMap((kind) => {
    const mine = accounts.filter((account) => account.kind === kind);
    if (!mine.length) return [];
    const balance = round2(mine.reduce((sum, account) => sum + account.balance, 0));
    const rows = counted.filter((row) => kindOf.get(String(row.account_name || '')) === kind);
    return [{
      kind,
      balance,
      share: worth.total > 0 ? balance / worth.total : null,
      change: round2(moved(rows, t12))
    }];
  });

  const change = round2(moved(counted, t12));
  const revalued = round2(moved(counted.filter(isRevaluation), t12));
  const started = firstDay(counted, clock);
  // Where the ledger starts inside T12, the change is since its first row, and says so.
  const sinceStart = started !== null && started > t12.from;

  const liquid = round2(accounts
    .filter((account) => account.kind === ACCOUNT_KIND.BANK || account.kind === ACCOUNT_KIND.CASH)
    .reduce((sum, account) => sum + account.balance, 0));

  // ---- Categories --------------------------------------------------------
  const categories = now.byCategory.map((row) => ({
    ...row,
    share: spent > 0 ? row.total / spent : null,
    monthly: aYear ? round2(row.total / LONG_VIEW_YEAR_MONTHS) : null
  }));

  // A category in one window and not the other spent zero in the other.
  const totalBefore: { [name: string]: number } = {};
  for (const row of before.byCategory) totalBefore[row.name] = row.total;
  const totalNow: { [name: string]: number } = {};
  for (const row of now.byCategory) totalNow[row.name] = row.total;
  const movers = [...new Set([...Object.keys(totalNow), ...Object.keys(totalBefore)])]
    .map((name) => {
      const current = totalNow[name] || 0;
      const earlier = totalBefore[name] || 0;
      return { name, now: current, before: earlier, change: round2(current - earlier) };
    })
    .filter((row) => row.change !== 0)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
    .slice(0, LONG_VIEW_MOVERS)
    .sort((a, b) => b.change - a.change);

  return {
    currency: worth.currency,
    window: { from: dayKey(t12.from), to: dayKey(t12.to) },
    previous: { from: dayKey(p12.from), to: dayKey(p12.to) },
    history: { months: months.length, aYear, twoYears },
    unconvertible: now.totals.unconvertible,

    spending: { total: spent, monthly: aYear ? round2(spent / LONG_VIEW_YEAR_MONTHS) : null },
    income: earned,
    saved,
    // No income is no rate: not 0%, and not a division by zero.
    savingsRate: earned > 0 ? saved / earned : null,
    runway: {
      liquid,
      months: aYear && spent > 0 ? liquid / (spent / LONG_VIEW_YEAR_MONTHS) : null
    },

    rolling,
    compared: twoYears
      ? {
          income: growth(earned, before.totals.income),
          spending: growth(spent, before.totals.expenses),
          savedBefore: before.totals.net
        }
      : null,

    years,
    yearTo: dayKey(clock.today),

    typical: {
      months: typical,
      usual: present.length ? round2(present.reduce((sum, value) => sum + value, 0) / present.length) : null
    },

    netWorth: {
      now: worth.total,
      before: round2(worth.total - change),
      change,
      since: dayKey(sinceStart ? started : t12.from - 1),
      sinceStart,
      series: worthSeries(counted, worth.total, clock)
    },
    sources: { saved, revalued, other: round2(change - saved - revalued) },
    held,
    pace: aYear
      ? LONG_VIEW_PACE_YEARS.map((ahead) => ({ years: ahead, value: round2(worth.total + saved * ahead) }))
      : null,

    categories,
    movers: twoYears ? movers : null,

    rates: monthly.slice(-LONG_VIEW_YEAR_MONTHS).map((month) => ({
      key: month.key,
      income: month.income,
      expenses: month.expenses,
      rate: month.income > 0 ? (month.income - month.expenses) / month.income : null
    }))
  };
}

export type LongView = ReturnType<typeof longView>;
