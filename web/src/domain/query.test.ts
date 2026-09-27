/**
 * The query engine, asked directly.
 *
 * Three groups of thing get tested hard, and they are the three that have
 * already cost this project something in other forms:
 *
 *   **Dates**, because a day built the obvious way is a UTC question and every
 *   booking date in this book is midnight local. A day here is a serial floored,
 *   which `days.test.ts` holds; what is left is the windows built from them.
 *
 *   **Blanks**, because `Number('')` is 0 and `isFinite(0)` is true. A non-EUR
 *   row has a deliberately blank `amount_base`, and counting it as a real zero
 *   is how a total goes quietly short.
 *
 *   **The sign**, because the amount is unsigned everywhere it is stored and
 *   the direction lives elsewhere. Getting it wrong inverts a total while it
 *   goes on looking plausible.
 *
 * Books are built the way the Sheets API sends them — a header row, values in
 * schema order, dates as serials — so what is tested is what the phone reads.
 */

import { describe, expect, it } from 'vitest';
import type { Cell } from '../sheets/records';
import { bookFromBatch } from './book';
import { cellNumber } from './cells';
import { dayKey, SERIAL_EPOCH } from './days';
import { appAnalyticsData, appRecordsData } from './payloads';
import {
  aggregate, balanceSeries, ledgerOf, matchesAccount, matchesFilters, recentBalanceTrend, resolveWindow,
  type Filters, type LedgerRow, type Window
} from './query';
import {
  ACCOUNT_COLUMNS, DASHBOARD_TREND_DAYS, PENDING_COLUMNS, QUERY_GROUP_LIMIT, QUERY_PAGE_SIZE, TX_COLUMNS
} from './schema';
import { at, serial, ZONE } from './testing';

/** Every clock-relative test below runs on one day, after all of July 2026. */
const NOW = at(2026, 9, 27);

/** A ledger row as `ledgerOf` hands one on: values, and the day already worked out. */
function row(over: { [column: string]: Cell } = {}): LedgerRow {
  const values: { [column: string]: Cell } = {
    uid: 'u-1',
    account_name: 'Revolut',
    booking_date: serial(2026, 7, 15),
    amount: 12.5,
    amount_base: -12.5,
    currency: 'EUR',
    description: 'COOP SUPERMERCATO',
    counterparty: '',
    category: 'Food & Drink',
    subcategory: 'Groceries',
    category_source: 'rule',
    type: 'expense',
    labels: '',
    confirmed: true,
    in_reports: true,
    ...over
  };
  const booked = values.booking_date;
  return { ...values, _row: 2, _day: typeof booked === 'number' ? Math.floor(booked - SERIAL_EPOCH) : null } as LedgerRow;
}

const keys = (w: Window) => [dayKey(w.from), dayKey(w.to)];

describe('cellNumber', () => {
  it('does not turn a blank into a zero', () => {
    // A non-EUR row has a blank amount_base on purpose — refusing to convert
    // is the honest answer. Counting it as €0 makes the total quietly short
    // instead of visibly incomplete.
    expect(cellNumber('')).toBeNull();
    expect(cellNumber(null)).toBeNull();
    expect(cellNumber(undefined)).toBeNull();
    expect(cellNumber('  ')).toBeNull();
  });

  it('keeps a real zero, which is a different fact', () => {
    expect(cellNumber(0)).toBe(0);
  });

  it('refuses text that is not a number', () => {
    expect(cellNumber('#REF!')).toBeNull();
  });
});

describe('resolving a window', () => {
  const on = at(2026, 8, 6);

  it('defaults to month to date', () => {
    expect(keys(resolveWindow(undefined, on))).toEqual(['2026-08-01', '2026-08-06']);
  });

  it('falls back to month to date rather than throwing on a kind it knows nothing about', () => {
    // A throw here is a blank screen.
    expect(keys(resolveWindow({ kind: 'nonsense' }, on))).toEqual(['2026-08-01', '2026-08-06']);
  });

  it('gives last month its whole self, including its own last day', () => {
    expect(keys(resolveWindow({ kind: 'last_month' }, on))).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('crosses a year boundary backwards', () => {
    expect(keys(resolveWindow({ kind: 'last_month' }, at(2026, 1, 9)))).toEqual(['2025-12-01', '2025-12-31']);
  });

  it('ends a named February on the 28th, and on the 29th in a leap year', () => {
    expect(keys(resolveWindow({ kind: 'month', year: 2026, month: 2 }, on))).toEqual(['2026-02-01', '2026-02-28']);
    expect(keys(resolveWindow({ kind: 'month', year: 2028, month: 2 }, on))).toEqual(['2028-02-01', '2028-02-29']);
  });

  it('takes a whole named year', () => {
    expect(keys(resolveWindow({ kind: 'year', year: 2025 }, on))).toEqual(['2025-01-01', '2025-12-31']);
  });

  it('runs the last twelve months to today, starting eleven months back', () => {
    expect(keys(resolveWindow({ kind: 'last_12' }, on))).toEqual(['2025-09-01', '2026-08-06']);
  });

  it('swaps a custom range given backwards rather than returning nothing', () => {
    // Two date pickers on a phone produce this constantly, and an empty result
    // that is really a complaint about the order is the least useful answer.
    expect(keys(resolveWindow({ kind: 'custom', from: '2026-07-31', to: '2026-07-01' }, on)))
      .toEqual(['2026-07-01', '2026-07-31']);
  });

  it('falls back when a custom range has neither end filled in', () => {
    expect(keys(resolveWindow({ kind: 'custom' }, on))).toEqual(['2026-08-01', '2026-08-06']);
  });

  it('runs an open-ended custom range to today', () => {
    expect(keys(resolveWindow({ kind: 'custom', from: '2026-01-01' }, on))).toEqual(['2026-01-01', '2026-08-06']);
  });

  it('resolves a month with no month named to the one you are in', () => {
    expect(keys(resolveWindow({ kind: 'month', year: 2026, month: 13 }, on))).toEqual(['2026-08-01', '2026-08-31']);
  });

  /*
    The week runs Monday to today, which is the ISO week and the one this book
    is kept in. The weekday counts from Sunday, so every off-by-one here lands
    on a different day of the week — which is why all seven are checked rather
    than a representative one. Sunday is the case a naive subtraction gets
    wrong, and it gets it wrong by six days.
  */
  it('starts the week on Monday, every day of the week', () => {
    // 2026-08-03 is a Monday; the 9th is the Sunday that ends that week.
    for (let d = 3; d <= 9; d++) {
      expect(keys(resolveWindow({ kind: 'week' }, at(2026, 8, d))), 'day ' + d).toEqual(['2026-08-03', '2026-08-0' + d]);
    }
  });

  it('runs a week back into the previous month, and the previous year', () => {
    // 2026-01-01 is a Thursday, so its week starts in December.
    expect(keys(resolveWindow({ kind: 'week' }, at(2026, 1, 1)))).toEqual(['2025-12-29', '2026-01-01']);
  });

  it('ends year-to-date today, where a named year runs to December', () => {
    // `year` includes months that have not happened, which is harmless in a
    // sum and a lie in a label.
    expect(keys(resolveWindow({ kind: 'ytd' }, on))).toEqual(['2026-01-01', '2026-08-06']);
    expect(keys(resolveWindow({ kind: 'year', year: 2026 }, on))).toEqual(['2026-01-01', '2026-12-31']);
  });

  it('makes year-to-date a single day on 1 January', () => {
    expect(keys(resolveWindow({ kind: 'ytd' }, at(2026, 1, 1)))).toEqual(['2026-01-01', '2026-01-01']);
  });
});

describe('filtering by account', () => {
  const named = (name: string) => ({ account_name: name });

  it('takes a single name', () => {
    // `netWorthNow` and `balanceSeries` pass filter objects straight through. A
    // signature that quietly stopped accepting a string would surface a long
    // way from here, as an empty net worth chart.
    expect(matchesAccount(named('Revolut'), { account: 'Revolut' })).toBe(true);
    expect(matchesAccount(named('Wallet'), { account: 'Revolut' })).toBe(false);
  });

  it('takes a list, which is what the chips send', () => {
    expect(matchesAccount(named('Wallet'), { account: ['Revolut', 'Wallet'] })).toBe(true);
    expect(matchesAccount(named('Degiro'), { account: ['Revolut', 'Wallet'] })).toBe(false);
  });

  it('treats an empty list as everything, not as nothing', () => {
    // Turning the last chip off. The honest reading is "stop filtering"; the
    // alternative is a screen that goes blank and reads as broken.
    expect(matchesAccount(named('Revolut'), { account: [] })).toBe(true);
  });

  it('passes everything for All, in either shape, or for no filter at all', () => {
    expect(matchesAccount(named('Revolut'), { account: 'All' })).toBe(true);
    expect(matchesAccount(named('Revolut'), { account: ['All'] })).toBe(true);
    expect(matchesAccount(named('Revolut'), {})).toBe(true);
    expect(matchesAccount(named('Revolut'), undefined)).toBe(true);
  });

  it('matches a row with no account name only when nothing is being asked', () => {
    expect(matchesAccount(named(''), { account: ['Revolut'] })).toBe(false);
    expect(matchesAccount(named(''), {})).toBe(true);
  });
});

describe('filtering', () => {
  const window = resolveWindow({ kind: 'month', year: 2026, month: 7 }, NOW);
  const scope = (over = {}) => ({ window, ...over });

  it('keeps a row inside the window', () => {
    expect(matchesFilters(row(), scope())).toBe(true);
  });

  it('includes both edges of the window', () => {
    expect(matchesFilters(row({ booking_date: serial(2026, 7, 1) }), scope())).toBe(true);
    expect(matchesFilters(row({ booking_date: serial(2026, 7, 31) }), scope())).toBe(true);
    expect(matchesFilters(row({ booking_date: serial(2026, 6, 30) }), scope())).toBe(false);
    expect(matchesFilters(row({ booking_date: serial(2026, 8, 1) }), scope())).toBe(false);
  });

  it('drops a row that does not count as spending', () => {
    // in_reports is the single column that decides this, and nothing here
    // re-derives it.
    expect(matchesFilters(row({ in_reports: false }), scope())).toBe(false);
  });

  it('reads in_reports as a spilled formula wrote it, not only as a boolean', () => {
    expect(matchesFilters(row({ in_reports: 'TRUE' }), scope())).toBe(true);
    expect(matchesFilters(row({ in_reports: '' }), scope())).toBe(false);
  });

  it('drops a row with no booking date at all', () => {
    expect(matchesFilters(row({ booking_date: '' }), scope())).toBe(false);
  });

  it('matches an account by the name a phone can offer you', () => {
    expect(matchesFilters(row(), scope({ account: 'Revolut' }))).toBe(true);
    expect(matchesFilters(row(), scope({ account: 'Fineco' }))).toBe(false);
    expect(matchesFilters(row(), scope({ account: 'All' }))).toBe(true);
  });

  it('matches one label out of several on a row', () => {
    const tagged = row({ labels: 'kids, travel' });
    expect(matchesFilters(tagged, scope({ label: 'travel' }))).toBe(true);
    expect(matchesFilters(tagged, scope({ label: 'kids' }))).toBe(true);
    expect(matchesFilters(tagged, scope({ label: 'home' }))).toBe(false);
  });

  it('does not match a label that is merely a substring of one', () => {
    // The caveat the `labels` tab carries, fixed here rather than warned about:
    // the reports tab uses QUERY's `contains` and cannot do better.
    expect(matchesFilters(row({ labels: 'business-travel' }), scope({ label: 'travel' }))).toBe(false);
  });
});

describe('aggregating', () => {
  const window = resolveWindow({ kind: 'month', year: 2026, month: 7 }, NOW);
  const on = (date: number, over: { [column: string]: Cell }) => row({ booking_date: serial(2026, 7, date), ...over });

  it('reports money out as a positive number', () => {
    // The sign is never in the amount, and a bar chart and a sentence both
    // want spending to point upwards. The negation happens once, here.
    const result = aggregate([on(3, { amount_base: -20 }), on(4, { amount_base: -5 })], window);
    expect(result.totals.expenses).toBe(25);
    expect(result.totals.income).toBe(0);
    expect(result.totals.net).toBe(-25);
  });

  it('keeps income and expenses apart and nets them', () => {
    const result = aggregate([on(3, { amount_base: -20 }), on(4, { amount_base: 100 })], window);
    expect(result.totals).toMatchObject({ expenses: 20, income: 100, net: 80, count: 2 });
  });

  it('counts a row it cannot convert rather than treating it as zero', () => {
    const result = aggregate([on(3, { amount_base: -20 }), on(4, { amount_base: '', currency: 'CHF' })], window);
    expect(result.totals).toMatchObject({ expenses: 20, count: 1, unconvertible: 1 });
  });

  it('groups only money out, so a refund is not a category you earned in', () => {
    const result = aggregate([
      on(3, { amount_base: -30, category: 'Food & Drink' }),
      on(4, { amount_base: 12, category: 'Food & Drink' })
    ], window);

    expect(result.byCategory).toEqual([{ name: 'Food & Drink', total: 30, children: [] }]);
    expect(result.totals.net).toBe(-18);
  });

  it('ranks categories biggest first', () => {
    const result = aggregate([
      on(3, { amount_base: -10, category: 'Transport' }),
      on(4, { amount_base: -80, category: 'Housing' }),
      on(5, { amount_base: -30, category: 'Food & Drink' })
    ], window);

    expect(result.byCategory.map((r) => r.name)).toEqual(['Housing', 'Food & Drink', 'Transport']);
  });

  it('names an uncategorised row rather than dropping it out of the total', () => {
    const result = aggregate([on(3, { amount_base: -10, category: '' })], window);
    expect(result.byCategory).toEqual([{ name: '(uncategorised)', total: 10, children: [] }]);
  });

  /*
    `byCategory` and `bySubcategory` are independent tallies of the same rows,
    so a Food & Drink row with no subcategory lands under Food & Drink in one
    and under `(uncategorised)` in the other. Read side by side that is a
    contradiction, and both numbers are correct. Under its parent,
    `(uncategorised)` needs no explanation.
  */
  it('puts each subcategory under the category it was spent in', () => {
    const result = aggregate([
      on(3, { amount_base: -10, category: 'Food & Drink', subcategory: 'Groceries' }),
      on(4, { amount_base: -4, category: 'Food & Drink', subcategory: '' }),
      on(5, { amount_base: -7, category: 'Transport', subcategory: '' })
    ], window);

    expect(result.byCategory).toEqual([
      { name: 'Food & Drink', total: 14, children: [
        { name: 'Groceries', total: 10 },
        { name: '(uncategorised)', total: 4 }
      ] },
      { name: 'Transport', total: 7, children: [] }
    ]);
  });

  it('offers no drill-down when the child is just the parent again', () => {
    // One child repeating the number above it is a row that costs a tap and says nothing.
    const result = aggregate([on(3, { amount_base: -10, category: 'Housing', subcategory: 'Rent' })], window);
    expect(result.byCategory[0].children).toEqual([]);
  });

  it('keeps the flat subcategory ranking alongside the nested one', () => {
    // "What were my biggest subcategories overall" — the nested list cannot say without reading every branch.
    const result = aggregate([
      on(3, { amount_base: -10, category: 'Food & Drink', subcategory: 'Groceries' }),
      on(4, { amount_base: -4, category: 'Shopping', subcategory: 'Clothes' })
    ], window);

    expect(result.bySubcategory.map((r) => r.name)).toEqual(['Groceries', 'Clothes']);
  });

  it('groups by subcategory as well, in one pass', () => {
    const result = aggregate([
      on(3, { amount_base: -10, subcategory: 'Groceries' }),
      on(4, { amount_base: -4, subcategory: 'Restaurants' })
    ], window);

    expect(result.bySubcategory).toEqual([
      { name: 'Groceries', total: 10 },
      { name: 'Restaurants', total: 4 }
    ]);
  });

  it('caps a grouped block, because a chart of 400 merchants is a smear', () => {
    const rows = [];
    for (let i = 0; i < 60; i++) rows.push(on(3, { amount_base: -(i + 1), category: `c${i}` }));
    expect(aggregate(rows, window).byCategory).toHaveLength(QUERY_GROUP_LIMIT);
  });

  it('rounds at the boundary rather than during the sum', () => {
    // Rounding each addend drifts by a cent per few hundred rows, and a total
    // a cent off the dashboard's is a total nobody believes again.
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push(on(3, { amount_base: -0.005 }));
    expect(aggregate(rows, window).totals.expenses).toBe(1.5);
  });

  it('buckets a short window by day, including the days with nothing in them', () => {
    // A day you spent nothing on is a real answer. Leaving it out makes a line
    // chart join the 3rd to the 5th as though the 4th did not happen.
    const july = resolveWindow({ kind: 'custom', from: '2026-07-01', to: '2026-07-05' }, NOW);
    const result = aggregate([on(1, { amount_base: -10 }), on(3, { amount_base: -4 })], july);

    expect(result.bucketSize).toBe('day');
    expect(result.cashflow.map((b) => b.key)).toEqual(['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05']);
    expect(result.cashflow.map((b) => b.expenses)).toEqual([10, 0, 4, 0, 0]);
  });

  it('switches to monthly buckets once daily ones stop being readable', () => {
    const year = resolveWindow({ kind: 'year', year: 2026 }, NOW);
    const result = aggregate([
      row({ booking_date: serial(2026, 1, 9), amount_base: -10 }),
      row({ booking_date: serial(2026, 3, 9), amount_base: -5 })
    ], year);

    expect(result.bucketSize).toBe('month');
    expect(result.cashflow).toHaveLength(12);
    expect(result.cashflow[0]).toMatchObject({ key: '2026-01', expenses: 10 });
    expect(result.cashflow[1]).toMatchObject({ key: '2026-02', expenses: 0 });
    expect(result.cashflow[2]).toMatchObject({ key: '2026-03', expenses: 5 });
  });

  it('says nothing rather than guessing when there are no rows', () => {
    const result = aggregate([], window);
    expect(result.totals).toMatchObject({ expenses: 0, income: 0, net: 0, count: 0 });
    expect(result.byCategory).toEqual([]);
    expect(result.cashflow).toHaveLength(31);
  });
});

describe('the balance trend', () => {
  const window = resolveWindow({ kind: 'custom', from: '2026-07-01', to: '2026-07-04' }, NOW);

  /** `balance_at(d) = balance_now − Σ amount_base booked after d`. */
  it('walks the current balance backwards through the ledger', () => {
    const series = balanceSeries([
      row({ booking_date: serial(2026, 7, 2), amount_base: -100 }),
      row({ booking_date: serial(2026, 7, 4), amount_base: -50 })
    ], window, 1000, NOW);

    expect(series.map((p) => [p.key, p.value])).toEqual([
      ['2026-07-01', 1150],
      ['2026-07-02', 1050],
      ['2026-07-03', 1050],
      ['2026-07-04', 1000]
    ]);
  });

  it('counts a transfer, because net worth is not a spending question', () => {
    // The one function here that does not filter in_reports. A transfer moves
    // a balance and an excluded row still left your account.
    const series = balanceSeries([
      row({ booking_date: serial(2026, 7, 3), amount_base: -200, in_reports: false, type: 'transfer' })
    ], window, 500, NOW);

    expect(series[0].value).toBe(700);
    expect(series[3].value).toBe(500);
  });

  it('skips a row it cannot convert rather than stepping the line by zero', () => {
    const series = balanceSeries([
      row({ booking_date: serial(2026, 7, 3), amount_base: '', currency: 'CHF' })
    ], window, 400, NOW);

    expect(series.every((p) => p.value === 400)).toBe(true);
  });

  it('emits a point for every day, so the line has no gaps', () => {
    expect(balanceSeries([], window, 10, NOW)).toHaveLength(4);
  });

  it('stops at today, whatever the window asks for', () => {
    const series = balanceSeries([], resolveWindow({ kind: 'month', year: 2026, month: 8 }, at(2026, 8, 10)), 10, at(2026, 8, 10));
    expect(series.map((p) => p.key).at(-1)).toBe('2026-08-10');
  });
});

describe('the thirty days under the dashboard total', () => {
  const now = at(2026, 7, 20);

  it('draws the same number of days whichever day of the month it is', () => {
    // Not month-to-date: that window is one day long on the 1st, so the card
    // would empty itself every time the month turned and refill over four weeks.
    const first = recentBalanceTrend([], at(2026, 7, 1), 100);
    const late = recentBalanceTrend([], at(2026, 7, 28), 100);

    expect(first).toHaveLength(DASHBOARD_TREND_DAYS);
    expect(late).toHaveLength(DASHBOARD_TREND_DAYS);
    expect([first[0].key, first.at(-1)!.key]).toEqual(['2026-06-02', '2026-07-01']);
    expect([late[0].key, late.at(-1)!.key]).toEqual(['2026-06-29', '2026-07-28']);
  });

  it('ends on today, at the total the card above it shows', () => {
    // A point is the balance at the *end* of its day, so the row booked on the
    // 18th is already in the 18th's value and the step is between it and the
    // 17th. Reading it the other way puts every move a day late.
    const series = recentBalanceTrend([row({ booking_date: serial(2026, 7, 18), amount_base: -40 })], now, 900);

    expect(series.at(-1)).toEqual({ key: '2026-07-20', value: 900 });
    expect(series.at(-3)).toEqual({ key: '2026-07-18', value: 900 });
    expect(series.at(-4)).toEqual({ key: '2026-07-17', value: 940 });
  });

  it('ignores a row older than the frame, which is already inside the total', () => {
    const old = recentBalanceTrend([row({ booking_date: serial(2026, 5, 1), amount_base: -500 })], now, 900);

    expect(old).toHaveLength(DASHBOARD_TREND_DAYS);
    expect(old.every((point) => point.value === 900)).toBe(true);
  });
});

describe('a query against a whole book', () => {
  type Values = { [column: string]: Cell };

  /** A tab as `values.batchGet` sends it: the header, then each record in schema order. */
  const tab = (name: string, columns: readonly string[], rows: Values[]) => ({
    range: `'${name}'!A1:AD`,
    values: [columns as Cell[], ...rows.map((r) => columns.map((column) => (column in r ? r[column] : '')))]
  });

  /** A book holding these transactions, holds and accounts, read at `NOW`. */
  function bookWith(transactions: Values[], extra: { pending?: Values[]; accounts?: Values[] } = {}) {
    const book = bookFromBatch({
      valueRanges: [
        tab('transactions', TX_COLUMNS, transactions),
        tab('pending', PENDING_COLUMNS, extra.pending ?? []),
        tab('accounts', ACCOUNT_COLUMNS, extra.accounts ?? [])
      ]
    }, ZONE);
    const ledger = ledgerOf(book);
    return {
      analytics: (filters: Filters) => appAnalyticsData(book, ledger, filters, NOW),
      records: (filters: Filters, offset = 0) => appRecordsData(book, ledger, filters, offset, NOW)
    };
  }

  let next = 0;
  const tx = (over: Values = {}): Values => ({
    uid: 'u-' + ++next,
    account_id: 'acc-1',
    account_name: 'Revolut',
    booking_date: serial(2026, 7, 15),
    amount: 12.5,
    currency: 'EUR',
    description: 'COOP SUPERMERCATO',
    source: 'enablebanking',
    imported_at: serial(2026, 7, 15),
    amount_base: -12.5,
    category: 'Food & Drink',
    subcategory: 'Groceries',
    type: 'expense',
    in_reports: true,
    ...over
  });

  const july: Filters = { period: { kind: 'month', year: 2026, month: 7 } };

  it('answers with the size of the answer, not the size of the ledger', () => {
    const result = bookWith([tx(), tx({ amount_base: -30, category: 'Transport' })]).analytics(july);

    expect(result.totals).toMatchObject({ expenses: 42.5, count: 2 });
    expect(result.window).toEqual({ kind: 'month', from: '2026-07-01', to: '2026-07-31' });
    expect(result.currency).toBe('EUR');
  });

  it('keys every point by a string, which is what survives being stored', () => {
    const seen = JSON.parse(JSON.stringify(bookWith([tx()]).analytics(july)));

    expect(seen.window.from).toBe('2026-07-01');
    expect(seen.cashflow.every((b: { key: unknown }) => typeof b.key === 'string')).toBe(true);
    expect(seen.balance.every((p: { key: unknown }) => typeof p.key === 'string')).toBe(true);
  });

  it('pages the records newest first', () => {
    const page = bookWith([
      tx({ booking_date: serial(2026, 7, 1), description: 'oldest' }),
      tx({ booking_date: serial(2026, 7, 20), description: 'newest' }),
      tx({ booking_date: serial(2026, 7, 10), description: 'middle' })
    ]).records(july);

    expect(page.rows.map((r) => r.description)).toEqual(['newest', 'middle', 'oldest']);
    expect(page).toMatchObject({ total: 3, offset: 0, hasMore: false });
  });

  it('puts the one you just typed above the one from this morning', () => {
    // `transactions` is append-only and never sorted, so row order is insert
    // order — which for two rows on the same day is all there is to go on.
    const page = bookWith([
      tx({ booking_date: serial(2026, 7, 10), description: 'this morning' }),
      tx({ booking_date: serial(2026, 7, 10), description: 'just now' })
    ]).records(july);

    expect(page.rows.map((r) => r.description)).toEqual(['just now', 'this morning']);
  });

  it('hands back one page at a time and says there is more', () => {
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push(tx({ booking_date: serial(2026, 7, 1 + (i % 28)) }));
    const book = bookWith(rows);

    const first = book.records(july, 0);
    expect(first.rows).toHaveLength(QUERY_PAGE_SIZE);
    expect(first).toMatchObject({ total: 120, hasMore: true });

    const second = book.records(july, QUERY_PAGE_SIZE);
    expect(second.rows).toHaveLength(20);
    expect(second.hasMore).toBe(false);
  });

  /*
    Pending holds. The shape is the load-bearing part: a separate list, never
    merged into `rows`. `total`, `offset` and `hasMore` are arithmetic over the
    ledger, and a row that is not in the ledger appearing among them makes the
    count disagree with the list and the second page skip whatever the first
    displaced.
  */
  const hold = (over: Values = {}): Values => ({
    uid: 'p-1', account_id: 'acc-1', account_name: 'Revolut',
    booking_date: serial(2026, 7, 22), amount: -18.4, currency: 'EUR',
    description: 'HOTEL BOOKING', source: 'enablebanking', ...over
  });

  it('sends holds beside the rows, never among them', () => {
    const page = bookWith([tx({ booking_date: serial(2026, 7, 10) })],
      { pending: [hold(), hold({ uid: 'p-2', description: 'PETROL STATION' })] }).records(july);

    expect(page.rows).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.pending.map((p) => p.description)).toEqual(['HOTEL BOOKING', 'PETROL STATION']);
    expect(page.pending.every((p) => p.pending === true)).toBe(true);
  });

  it('sends holds only with the first page', () => {
    // They are drawn once at the top; "load more" appending them again is the
    // obvious bug and the cheapest one to prevent.
    const rows = [];
    for (let i = 0; i < 120; i++) rows.push(tx({ booking_date: serial(2026, 7, 1 + (i % 28)) }));
    const book = bookWith(rows, { pending: [hold()] });

    expect(book.records(july, 0).pending).toHaveLength(1);
    expect(book.records(july, QUERY_PAGE_SIZE).pending).toEqual([]);
  });

  it('filters holds by account, along with everything else', () => {
    const book = bookWith([tx()], {
      pending: [hold({ account_name: 'Revolut' }), hold({ uid: 'p-2', account_name: 'Wallet', description: 'CASH HOLD' })]
    });

    expect(book.records({ ...july, account: ['Wallet'] }).pending.map((p) => p.description)).toEqual(['CASH HOLD']);
  });

  it('does not window holds out on a date the bank has not finalised', () => {
    // A pending authorisation's date moves on the way to being booked, so a
    // window that reaches the present keeps it whatever date it carries.
    const book = bookWith([tx()], { pending: [hold({ booking_date: serial(2026, 1, 4) })] });

    expect(book.records({ period: { kind: 'ytd' } }).pending).toHaveLength(1);
    expect(book.records({ period: { kind: 'mtd' } }).pending).toHaveLength(1);
  });

  it('windows holds out of a period that ended in the past', () => {
    // A deliberate look backwards is not a question today's holds answer.
    const book = bookWith([tx()], { pending: [hold({ booking_date: serial(2026, 1, 4) })] });

    expect(book.records({ period: { kind: 'month', year: 2024, month: 3 } }).pending).toHaveLength(0);
    // Still shown when the hold's own date falls inside that past window.
    expect(book.records({ period: { kind: 'month', year: 2026, month: 1 } }).pending).toHaveLength(1);
  });

  it('searches holds on the two text fields the tab actually has', () => {
    // No category and no labels on `pending` — it carries A–O only.
    const book = bookWith([tx()], { pending: [hold()] });

    expect(book.records({ ...july, search: 'hotel' }).pending).toHaveLength(1);
    expect(book.records({ ...july, search: 'groceries' }).pending).toHaveLength(0);
  });

  it('answers with no holds when the tab has none', () => {
    expect(bookWith([tx()]).records(july).pending).toEqual([]);
  });

  it('lists a transfer, because the ledger is not a spending report', () => {
    const book = bookWith([tx({ description: 'a transfer', type: 'transfer', in_reports: false })]);

    expect(book.records(july).rows.map((r) => r.description)).toEqual(['a transfer']);
    expect(book.analytics(july).totals.count).toBe(0);
  });

  /*
    Where a transfer went, or where it came from. Both legs carry the same
    `tr:<debit uid>` in `transfer_group`, so the other end is whichever member
    of the group this row is not.
  */
  it('names the other end of a transfer, and which end this one is', () => {
    const rows = bookWith([
      tx({ uid: 't-out', description: 'to savings', account_name: 'Revolut', amount_base: -500,
        type: 'transfer', in_reports: false, transfer_group: 'tr:t-out' }),
      tx({ uid: 't-in', description: 'from current', account_name: 'Fineco', amount_base: 500,
        type: 'transfer', in_reports: false, transfer_group: 'tr:t-out' })
    ]).records(july).rows;

    expect(rows.find((r) => r.uid === 't-out')).toMatchObject({ peerAccount: 'Fineco', peerDirection: 'to' });
    expect(rows.find((r) => r.uid === 't-in')).toMatchObject({ peerAccount: 'Revolut', peerDirection: 'from' });
  });

  it('says nothing about a transfer with no second leg in the book', () => {
    // The page has to tell "somewhere outside" from "I do not know".
    const rows = bookWith([tx({ description: 'to a friend', type: 'transfer', in_reports: false })]).records(july).rows;
    expect(rows[0]).toMatchObject({ peerAccount: '', peerDirection: '' });
  });

  it('finds the other leg even when the account filter hides it', () => {
    const rows = bookWith([
      tx({ uid: 't-out', account_name: 'Revolut', amount_base: -500, type: 'transfer', in_reports: false, transfer_group: 'tr:t-out' }),
      tx({ uid: 't-in', account_name: 'Fineco', amount_base: 500, type: 'transfer', in_reports: false, transfer_group: 'tr:t-out' })
    ]).records({ ...july, account: ['Revolut'] }).rows;

    expect(rows).toHaveLength(1);
    expect(rows[0].peerAccount).toBe('Fineco');
  });

  it('names nothing when a group holds more than two rows', () => {
    // A transfer naming two destinations is worse than one naming none.
    const rows = bookWith([
      tx({ uid: 't-1', account_name: 'Revolut', transfer_group: 'tr:t-1', type: 'transfer', in_reports: false }),
      tx({ uid: 't-2', account_name: 'Fineco', transfer_group: 'tr:t-1', type: 'transfer', in_reports: false }),
      tx({ uid: 't-3', account_name: 'Wallet', transfer_group: 'tr:t-1', type: 'transfer', in_reports: false })
    ]).records(july).rows;

    for (const r of rows) expect(r.peerAccount).toBe('');
  });

  it('searches the fields a phone would search', () => {
    const book = bookWith([
      tx({ description: 'ESSELUNGA' }),
      tx({ description: 'TRENITALIA', category: 'Transport', subcategory: 'Public transport' })
    ]);

    expect(book.records({ ...july, search: 'trenit' }).rows.map((r) => r.description)).toEqual(['TRENITALIA']);
    expect(book.records({ ...july, search: 'public tran' }).rows).toHaveLength(1);
  });

  it('narrows to the backlog when asked', () => {
    const book = bookWith([tx({ description: 'done', confirmed: true }), tx({ description: 'waiting' })]);
    expect(book.records({ ...july, unconfirmedOnly: true }).rows.map((r) => r.description)).toEqual(['waiting']);
  });

  it('anchors the trend to what the accounts are worth now', () => {
    const result = bookWith([tx({ booking_date: serial(2026, 7, 20), amount_base: -100 })], {
      accounts: [{ account_id: 'acc-1', name: 'Revolut', kind: 'bank', currency: 'EUR', balance: 900, include_in_net_worth: true, active: true }]
    }).analytics(july);

    expect(result.netWorth).toMatchObject({ total: 900, counted: 1, currency: 'EUR' });
    expect(result.balance[0].value).toBe(1000);
    expect(result.balance.at(-1)!.value).toBe(900);
  });

  it('leaves an account out of net worth rather than adding a currency it cannot convert', () => {
    // Adding a CHF pocket to a euro total is wrong by whatever the rate is and looks exactly right.
    const result = bookWith([], {
      accounts: [
        { account_id: 'a', name: 'Euro', kind: 'bank', currency: 'EUR', balance: 100, include_in_net_worth: true, active: true },
        { account_id: 'b', name: 'Franc', kind: 'bank', currency: 'CHF', balance: 5000, include_in_net_worth: true, active: true },
        { account_id: 'c', name: 'Old', kind: 'bank', currency: 'EUR', balance: 40, include_in_net_worth: true, active: false }
      ]
    }).analytics({});

    expect(result.netWorth).toMatchObject({ total: 100, counted: 1, skipped: 1 });
  });

  it('works on a book with no transactions in it at all', () => {
    const book = bookWith([]);
    expect(() => book.analytics({})).not.toThrow();
    expect(book.records({})).toMatchObject({ rows: [], total: 0, hasMore: false });
  });

  /*
    Drilling from a number on Charts to the rows behind it.

    **The reconciliation tests are the point of this block.** The failure this
    design exists to prevent is not an error — it is a list that looks right and
    does not add up to the figure that opened it. `matchesRecordFilters` and
    `aggregate` are two independent walks over the same rows, and the only
    evidence they agree is asking both and comparing.

    One deliberately awkward book: income, a transfer excluded from reports, a
    row with no `amount_base`, a category with two children, and a row whose
    subcategory is blank so that `(uncategorised)` is a real bucket.
  */
  const mixed = () => bookWith([
    tx({ description: 'salary', amount_base: 2000, category: 'Income', subcategory: 'Salary', type: 'income' }),
    tx({ description: 'moved money', amount_base: -500, category: 'Transfer', subcategory: 'Internal', type: 'transfer', in_reports: false }),
    tx({ description: 'swiss francs', amount_base: '', category: 'Shopping', subcategory: 'Clothes' }),
    tx({ description: 'esselunga', amount_base: -40, category: 'Food & Drink', subcategory: 'Groceries' }),
    tx({ description: 'coop', amount_base: -25, category: 'Food & Drink', subcategory: 'Groceries' }),
    tx({ description: 'osteria', amount_base: -60, category: 'Food & Drink', subcategory: 'Restaurants' }),
    tx({ description: 'unclear', amount_base: -10, category: 'Food & Drink', subcategory: '' }),
    tx({ description: 'trenitalia', amount_base: -15, category: 'Transport', subcategory: 'Public transport' })
  ]);

  /** What the drilled list adds up to, negated, because `aggregate` reports expenses as positive. */
  const drilledTotal = (book: ReturnType<typeof bookWith>, drill: Filters) => {
    const page = book.records({ ...july, ...drill });
    return {
      total: page.total,
      sum: Number(page.rows.reduce((n, r) => n + -Number(r.amount), 0).toFixed(2)),
      rows: page.rows.map((r) => r.description).sort()
    };
  };

  it('drills the spending total to rows that add up to it', () => {
    const book = mixed();
    // 40 + 25 + 60 + 10 + 15. Not the salary, not the transfer, and not the
    // row with no base amount.
    expect(book.analytics(july).totals.expenses).toBe(150);
    expect(drilledTotal(book, { spendOnly: true })).toMatchObject({ total: 5, sum: 150 });
  });

  it('drills the income total to rows that add up to it', () => {
    // The transfer is out on `in_reports` — money that came *in* to one
    // account, so a filter reading the sign alone would list it and break the sum.
    const book = mixed();
    const page = book.records({ ...july, incomeOnly: true });

    expect(book.analytics(july).totals.income).toBe(2000);
    expect(page.total).toBe(1);
    expect(page.rows.map((r) => r.description)).toEqual(['salary']);
    expect(page.rows.reduce((n, r) => n + Number(r.amount), 0)).toBe(2000);
  });

  it('sorts a zero-amount row by its type, because zero has no sign', () => {
    // A €0.00 pre-authorisation is a real debit — a card check at a fuel pump.
    // `type` is a formula over the category and is the one stored answer.
    const book = bookWith([
      tx({ description: 'salary', amount_base: 2000, category: 'Income', subcategory: 'Salary', type: 'income' }),
      tx({ description: 'nothing at all', amount_base: 0, category: 'Income', subcategory: 'Salary', type: 'income' }),
      tx({ description: 'fuel pump check', amount_base: 0, category: 'Transport', subcategory: 'Fuel', type: 'expense' })
    ]);

    expect(book.analytics(july).totals.income).toBe(2000);
    expect(book.records({ ...july, incomeOnly: true }).rows.map((r) => r.description)).toEqual(['nothing at all', 'salary']);
    expect(book.records({ ...july, spendOnly: true }).rows.map((r) => r.description)).toEqual(['fuel pump check']);
  });

  it('never lists a row under both directions', () => {
    const book = mixed();
    const names = (drill: Filters) => book.records({ ...july, ...drill }).rows.map((r) => r.description);

    const out = names({ spendOnly: true });
    const income = names({ incomeOnly: true });

    expect(out.length + income.length).toBeGreaterThan(1);
    expect(out.filter((name) => income.includes(name))).toEqual([]);
  });

  it('drills each category bar to rows that add up to that bar', () => {
    const book = mixed();
    const byCategory = book.analytics(july).byCategory;
    expect(byCategory.length).toBeGreaterThan(1);

    for (const entry of byCategory) {
      expect(drilledTotal(book, { spendOnly: true, category: entry.name }).sum, entry.name).toBe(entry.total);
    }
  });

  it('drills a subcategory to rows that add up to it, under its own parent', () => {
    const book = mixed();
    const food = book.analytics(july).byCategory.find((e) => e.name === 'Food & Drink')!;

    expect(food.total).toBe(135);
    for (const child of food.children) {
      expect(drilledTotal(book, { spendOnly: true, category: food.name, subcategory: child.name }).sum, child.name)
        .toBe(child.total);
    }
    expect(drilledTotal(book, { spendOnly: true, category: 'Food & Drink', subcategory: 'Groceries' }).rows)
      .toEqual(['coop', 'esselunga']);
  });

  it('drills `(uncategorised)` to the blank rows, which is where the tally put them', () => {
    // The bucket name is an address as well as a label, and `groupKey` is the
    // one place the two are decided.
    const book = mixed();
    const food = book.analytics(july).byCategory.find((e) => e.name === 'Food & Drink')!;

    expect(food.children.map((k) => k.name)).toContain('(uncategorised)');
    expect(drilledTotal(book, { spendOnly: true, category: 'Food & Drink', subcategory: '(uncategorised)' }))
      .toMatchObject({ total: 1, sum: 10, rows: ['unclear'] });
  });

  it('leaves out income, an excluded row, and a row with no base amount', () => {
    const drilled = drilledTotal(mixed(), { spendOnly: true }).rows;

    expect(drilled).not.toContain('salary');
    expect(drilled).not.toContain('moved money');
    expect(drilled).not.toContain('swiss francs');
  });

  it('still lists all of them when the drill is off, because the ledger is not a report', () => {
    expect(mixed().records(july).total).toBe(8);
  });

  it('treats `All` and an absent field as no filter at all', () => {
    const book = mixed();
    expect(book.records({ ...july, category: 'All', subcategory: 'All' }).total).toBe(8);
    expect(book.records({ ...july, spendOnly: false }).total).toBe(8);
  });

  it('drops the holds on a drill, because a hold was never part of the number', () => {
    const book = bookWith([tx({ amount_base: -12.5 })], { pending: [hold()] });

    expect(book.records(july).pending).toHaveLength(1);
    expect(book.records({ ...july, spendOnly: true }).pending).toEqual([]);
    expect(book.records({ ...july, category: 'Food & Drink' }).pending).toEqual([]);
  });

  it('narrows further when a drill and a search are both on', () => {
    const both = mixed().records({ ...july, spendOnly: true, category: 'Food & Drink', search: 'coop' });
    expect(both.rows.map((r) => r.description)).toEqual(['coop']);
  });
});

