/**
 * The query engine behind the mobile app.
 *
 * Almost everything in `21_query.gs` is pure, which was the point of putting
 * the aggregation on the server rather than in the page: anything inside an
 * HTML file is invisible to `node:vm`, and this is ordinary `.gs`.
 *
 * Three groups of thing get tested hard, and they are the three that have
 * already cost this project something in other forms:
 *
 *   **Dates**, because a day number built the obvious way is a UTC question and
 *   every booking date in this book is midnight local. East of Greenwich that
 *   is the previous day in UTC, which silently moves every 1st-of-the-month
 *   transaction into the month before.
 *
 *   **Blanks**, because `Number('')` is 0 and `isFinite(0)` is true. A non-EUR
 *   row has a deliberately blank `amount_base`, and counting it as a real zero
 *   is how a total goes quietly short.
 *
 *   **The sign**, because the amount is unsigned everywhere it is stored and
 *   the direction lives elsewhere. Getting it wrong inverts a total while it
 *   goes on looking plausible.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

/** A row as `readRecords_` hands one back: values, not a provider payload. */
function row(over = {}) {
  return Object.assign({
    _row: 2,
    uid: 'u-1',
    account_name: 'Revolut',
    booking_date: new Date(2026, 6, 15),
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
    in_reports: true
  }, over);
}

describe('day numbers', () => {
  it('reads the calendar day, not the instant', () => {
    // The whole reason dayNumber_ goes through Date.UTC on the *local* fields.
    // `getTime() / MS_PER_DAY` on midnight in Rome is 22:00 the day before in
    // UTC, which moves every 1st-of-the-month row into the previous month.
    const first = ctx.dayNumber_(new Date(2026, 7, 1));
    expect(ctx.dayKey_(first)).toBe('2026-08-01');
  });

  it('round-trips every day of a month boundary', () => {
    for (let day = 28; day <= 31; day++) {
      const key = ctx.dayKey_(ctx.dayNumber_(new Date(2026, 0, day)));
      expect(key).toBe(`2026-01-${day}`);
    }
    expect(ctx.dayKey_(ctx.dayNumber_(new Date(2026, 1, 1)))).toBe('2026-02-01');
  });

  it('refuses a cell that is not a date rather than inventing 1970', () => {
    // `new Date('')` is Invalid Date and `new Date(0)` is 1 January 1970.
    // Either one becoming a real day number lands a phantom transaction at one
    // end of every window.
    expect(ctx.dayNumber_('')).toBeNull();
    expect(ctx.dayNumber_(null)).toBeNull();
    expect(ctx.dayNumber_('   ')).toBeNull();
    expect(ctx.dayNumber_('not a date')).toBeNull();
    expect(ctx.dayNumber_(new Date('nope'))).toBeNull();
  });

  it('accepts a date the sheet stored as text', () => {
    expect(ctx.dayKey_(ctx.dayNumber_('2026-03-09'))).toBe('2026-03-09');
  });

  it('names the month a day falls in', () => {
    expect(ctx.monthKey_(ctx.dayNumber_(new Date(2026, 11, 31)))).toBe('2026-12');
  });
});

describe('cellNumber_', () => {
  it('does not turn a blank into a zero', () => {
    // A non-EUR row has a blank amount_base on purpose — refusing to convert
    // is the honest answer. Counting it as €0 makes the total quietly short
    // instead of visibly incomplete.
    expect(ctx.cellNumber_('')).toBeNull();
    expect(ctx.cellNumber_(null)).toBeNull();
    expect(ctx.cellNumber_(undefined)).toBeNull();
    expect(ctx.cellNumber_('  ')).toBeNull();
  });

  it('keeps a real zero, which is a different fact', () => {
    expect(ctx.cellNumber_(0)).toBe(0);
  });

  it('refuses text that is not a number', () => {
    expect(ctx.cellNumber_('#REF!')).toBeNull();
  });
});

describe('resolving a window', () => {
  const key = (w) => [ctx.dayKey_(w.from), ctx.dayKey_(w.to)];
  const at = (y, m, d) => new Date(y, m - 1, d, 12, 0, 0);

  it('defaults to month to date', () => {
    expect(key(ctx.resolveWindow_(undefined, at(2026, 8, 6))))
      .toEqual(['2026-08-01', '2026-08-06']);
  });

  it('falls back to month to date rather than throwing on a kind it knows nothing about', () => {
    // This runs behind a web request, where a throw is a blank screen.
    expect(key(ctx.resolveWindow_({ kind: 'nonsense' }, at(2026, 8, 6))))
      .toEqual(['2026-08-01', '2026-08-06']);
  });

  it('gives last month its whole self, including its own last day', () => {
    expect(key(ctx.resolveWindow_({ kind: 'last_month' }, at(2026, 8, 6))))
      .toEqual(['2026-07-01', '2026-07-31']);
  });

  it('crosses a year boundary backwards', () => {
    expect(key(ctx.resolveWindow_({ kind: 'last_month' }, at(2026, 1, 9))))
      .toEqual(['2025-12-01', '2025-12-31']);
  });

  it('ends a named February on the 28th, and on the 29th in a leap year', () => {
    expect(key(ctx.resolveWindow_({ kind: 'month', year: 2026, month: 2 }, at(2026, 8, 6))))
      .toEqual(['2026-02-01', '2026-02-28']);
    expect(key(ctx.resolveWindow_({ kind: 'month', year: 2028, month: 2 }, at(2026, 8, 6))))
      .toEqual(['2028-02-01', '2028-02-29']);
  });

  it('takes a whole named year', () => {
    expect(key(ctx.resolveWindow_({ kind: 'year', year: 2025 }, at(2026, 8, 6))))
      .toEqual(['2025-01-01', '2025-12-31']);
  });

  it('runs the last twelve months to today, starting eleven months back', () => {
    expect(key(ctx.resolveWindow_({ kind: 'last_12' }, at(2026, 8, 6))))
      .toEqual(['2025-09-01', '2026-08-06']);
  });

  it('swaps a custom range given backwards rather than returning nothing', () => {
    // Two date pickers on a phone produce this constantly, and an empty result
    // that is really a complaint about the order is the least useful answer.
    const window = ctx.resolveWindow_(
      { kind: 'custom', from: '2026-07-31', to: '2026-07-01' }, at(2026, 8, 6));
    expect(key(window)).toEqual(['2026-07-01', '2026-07-31']);
  });

  it('falls back when a custom range has neither end filled in', () => {
    expect(key(ctx.resolveWindow_({ kind: 'custom' }, at(2026, 8, 6))))
      .toEqual(['2026-08-01', '2026-08-06']);
  });

  it('runs an open-ended custom range to today', () => {
    expect(key(ctx.resolveWindow_({ kind: 'custom', from: '2026-01-01' }, at(2026, 8, 6))))
      .toEqual(['2026-01-01', '2026-08-06']);
  });

  it('resolves a month with no month named to the one you are in', () => {
    expect(key(ctx.resolveWindow_({ kind: 'month', year: 2026, month: 13 }, at(2026, 8, 6))))
      .toEqual(['2026-08-01', '2026-08-31']);
  });
});

describe('filtering', () => {
  const window = ctx.resolveWindow_({ kind: 'month', year: 2026, month: 7 }, new Date());
  const scope = (over = {}) => Object.assign({ window }, over);

  it('keeps a row inside the window', () => {
    expect(ctx.matchesFilters_(row(), scope())).toBe(true);
  });

  it('includes both edges of the window', () => {
    expect(ctx.matchesFilters_(row({ booking_date: new Date(2026, 6, 1) }), scope())).toBe(true);
    expect(ctx.matchesFilters_(row({ booking_date: new Date(2026, 6, 31) }), scope())).toBe(true);
    expect(ctx.matchesFilters_(row({ booking_date: new Date(2026, 5, 30) }), scope())).toBe(false);
    expect(ctx.matchesFilters_(row({ booking_date: new Date(2026, 7, 1) }), scope())).toBe(false);
  });

  it('drops a row that does not count as spending', () => {
    // in_reports is the single column that decides this, and nothing here
    // re-derives it — six dashboard blocks each deciding for themselves is
    // exactly what that column was introduced to end.
    expect(ctx.matchesFilters_(row({ in_reports: false }), scope())).toBe(false);
  });

  it('reads in_reports as a spilled formula wrote it, not only as a boolean', () => {
    expect(ctx.matchesFilters_(row({ in_reports: 'TRUE' }), scope())).toBe(true);
    expect(ctx.matchesFilters_(row({ in_reports: '' }), scope())).toBe(false);
  });

  it('drops a row with no booking date at all', () => {
    expect(ctx.matchesFilters_(row({ booking_date: '' }), scope())).toBe(false);
  });

  it('matches an account by the name a phone can offer you', () => {
    expect(ctx.matchesFilters_(row(), scope({ account: 'Revolut' }))).toBe(true);
    expect(ctx.matchesFilters_(row(), scope({ account: 'Fineco' }))).toBe(false);
    expect(ctx.matchesFilters_(row(), scope({ account: 'All' }))).toBe(true);
  });

  it('matches one label out of several on a row', () => {
    const tagged = row({ labels: 'kids, travel' });
    expect(ctx.matchesFilters_(tagged, scope({ label: 'travel' }))).toBe(true);
    expect(ctx.matchesFilters_(tagged, scope({ label: 'kids' }))).toBe(true);
    expect(ctx.matchesFilters_(tagged, scope({ label: 'home' }))).toBe(false);
  });

  it('does not match a label that is merely a substring of one', () => {
    // The caveat the `labels` tab carries, fixed here rather than warned about:
    // the reports tab uses QUERY's `contains` and cannot do better.
    expect(ctx.matchesFilters_(row({ labels: 'business-travel' }), scope({ label: 'travel' })))
      .toBe(false);
  });
});

describe('aggregating', () => {
  const window = ctx.resolveWindow_({ kind: 'month', year: 2026, month: 7 }, new Date());
  const on = (day, over) => row(Object.assign({ booking_date: new Date(2026, 6, day) }, over));

  it('reports money out as a positive number', () => {
    // The sign is never in the amount, and a bar chart and a sentence both
    // want spending to point upwards. The negation happens once, here.
    const result = ctx.aggregate_([on(3, { amount_base: -20 }), on(4, { amount_base: -5 })], window);
    expect(result.totals.expenses).toBe(25);
    expect(result.totals.income).toBe(0);
    expect(result.totals.net).toBe(-25);
  });

  it('keeps income and expenses apart and nets them', () => {
    const result = ctx.aggregate_(
      [on(3, { amount_base: -20 }), on(4, { amount_base: 100 })], window);
    expect(result.totals).toMatchObject({ expenses: 20, income: 100, net: 80, count: 2 });
  });

  it('counts a row it cannot convert rather than treating it as zero', () => {
    const result = ctx.aggregate_(
      [on(3, { amount_base: -20 }), on(4, { amount_base: '', currency: 'CHF' })], window);

    expect(result.totals).toMatchObject({ expenses: 20, count: 1, unconvertible: 1 });
  });

  it('groups only money out, so a refund is not a category you earned in', () => {
    const result = ctx.aggregate_([
      on(3, { amount_base: -30, category: 'Food & Drink' }),
      on(4, { amount_base: 12, category: 'Food & Drink' })
    ], window);

    expect(result.byCategory).toEqual([{ name: 'Food & Drink', total: 30, children: [] }]);
    expect(result.totals.net).toBe(-18);
  });

  it('ranks categories biggest first', () => {
    const result = ctx.aggregate_([
      on(3, { amount_base: -10, category: 'Transport' }),
      on(4, { amount_base: -80, category: 'Housing' }),
      on(5, { amount_base: -30, category: 'Food & Drink' })
    ], window);

    expect(result.byCategory.map((r) => r.name)).toEqual(['Housing', 'Food & Drink', 'Transport']);
  });

  it('names an uncategorised row rather than dropping it out of the total', () => {
    const result = ctx.aggregate_([on(3, { amount_base: -10, category: '' })], window);
    expect(result.byCategory).toEqual([{ name: '(uncategorised)', total: 10, children: [] }]);
  });

  /**
   * The two groupings count different things, and nesting is what says so.
   *
   * `byCategory` and `bySubcategory` are independent tallies of the same rows,
   * so a row categorised `Food & Drink` with no subcategory lands under Food &
   * Drink in one and under `(uncategorised)` in the other. Read side by side
   * that is a contradiction — a huge uncategorised subcategory total next to a
   * small uncategorised category total — and the numbers are both correct.
   *
   * Under its parent, `(uncategorised)` needs no explanation: those are Food &
   * Drink's rows that never got a subcategory.
   */
  it('puts each subcategory under the category it was spent in', () => {
    const result = ctx.aggregate_([
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

  /*
    A category whose every row carries the same subcategory would otherwise
    expand into one child repeating the number above it, which is a row that
    costs a tap and says nothing.
  */
  it('offers no drill-down when the child is just the parent again', () => {
    const result = ctx.aggregate_([
      on(3, { amount_base: -10, category: 'Housing', subcategory: 'Rent' })
    ], window);

    expect(result.byCategory[0].children).toEqual([]);
  });

  /*
    The flat list stays: it answers "what were my biggest subcategories overall",
    which the nested one cannot without reading every branch.
  */
  it('keeps the flat subcategory ranking alongside the nested one', () => {
    const result = ctx.aggregate_([
      on(3, { amount_base: -10, category: 'Food & Drink', subcategory: 'Groceries' }),
      on(4, { amount_base: -4, category: 'Shopping', subcategory: 'Clothes' })
    ], window);

    expect(result.bySubcategory.map((r) => r.name)).toEqual(['Groceries', 'Clothes']);
  });

  it('groups by subcategory as well, in one pass', () => {
    const result = ctx.aggregate_([
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

    expect(ctx.aggregate_(rows, window).byCategory).toHaveLength(ctx.QUERY_GROUP_LIMIT);
  });

  it('rounds at the boundary rather than during the sum', () => {
    // Rounding each addend drifts by a cent per few hundred rows, and a total
    // a cent off the dashboard's is a total nobody believes again.
    const rows = [];
    for (let i = 0; i < 300; i++) rows.push(on(3, { amount_base: -0.005 }));

    expect(ctx.aggregate_(rows, window).totals.expenses).toBe(1.5);
  });

  it('buckets a short window by day, including the days with nothing in them', () => {
    // A day you spent nothing on is a real answer. Leaving it out makes a line
    // chart join the 3rd to the 5th as though the 4th did not happen.
    const july = ctx.resolveWindow_(
      { kind: 'custom', from: '2026-07-01', to: '2026-07-05' }, new Date());
    const result = ctx.aggregate_([on(1, { amount_base: -10 }), on(3, { amount_base: -4 })], july);

    expect(result.bucketSize).toBe('day');
    expect(result.cashflow.map((b) => b.key)).toEqual([
      '2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05'
    ]);
    expect(result.cashflow.map((b) => b.expenses)).toEqual([10, 0, 4, 0, 0]);
  });

  it('switches to monthly buckets once daily ones stop being readable', () => {
    const year = ctx.resolveWindow_({ kind: 'year', year: 2026 }, new Date());
    const result = ctx.aggregate_([
      row({ booking_date: new Date(2026, 0, 9), amount_base: -10 }),
      row({ booking_date: new Date(2026, 2, 9), amount_base: -5 })
    ], year);

    expect(result.bucketSize).toBe('month');
    expect(result.cashflow).toHaveLength(12);
    expect(result.cashflow[0]).toMatchObject({ key: '2026-01', expenses: 10 });
    expect(result.cashflow[1]).toMatchObject({ key: '2026-02', expenses: 0 });
    expect(result.cashflow[2]).toMatchObject({ key: '2026-03', expenses: 5 });
  });

  it('says nothing rather than guessing when there are no rows', () => {
    const result = ctx.aggregate_([], window);
    expect(result.totals).toMatchObject({ expenses: 0, income: 0, net: 0, count: 0 });
    expect(result.byCategory).toEqual([]);
    expect(result.cashflow).toHaveLength(31);
  });
});

describe('the balance trend', () => {
  const window = ctx.resolveWindow_({ kind: 'custom', from: '2026-07-01', to: '2026-07-04' },
    new Date());

  /** `balance_at(d) = balance_now − Σ amount_base booked after d`. */
  it('walks the current balance backwards through the ledger', () => {
    const series = ctx.balanceSeries_([
      row({ booking_date: new Date(2026, 6, 2), amount_base: -100 }),
      row({ booking_date: new Date(2026, 6, 4), amount_base: -50 })
    ], window, 1000);

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
    const series = ctx.balanceSeries_([
      row({ booking_date: new Date(2026, 6, 3), amount_base: -200, in_reports: false,
        type: 'transfer' })
    ], window, 500);

    expect(series[0].value).toBe(700);
    expect(series[3].value).toBe(500);
  });

  it('skips a row it cannot convert rather than stepping the line by zero', () => {
    const series = ctx.balanceSeries_([
      row({ booking_date: new Date(2026, 6, 3), amount_base: '', currency: 'CHF' })
    ], window, 400);

    expect(series.every((p) => p.value === 400)).toBe(true);
  });

  it('emits a point for every day, so the line has no gaps', () => {
    expect(ctx.balanceSeries_([], window, 10)).toHaveLength(4);
  });
});

describe('a query against a real book', () => {
  /** A book with a few transactions in it, written the way the sync writes them. */
  function bookWith(rows, options = {}) {
    const c = load(options);
    c.setup();

    const tx = c.__spreadsheet.getSheetByName('transactions');
    c.appendRows_(tx, 1, rows.map((r) => c.toRow_(c.TX_COLUMNS_CODE, r)));

    // The derived columns are formulas on a real book, and the harness never
    // evaluates one — so the values they would have produced are written in.
    rows.forEach((r, i) => {
      ['amount_base', 'category', 'subcategory', 'type', 'in_reports', 'labels', 'confirmed']
        .forEach((name) => {
          if (r[name] !== undefined) c.writeCell_(tx, i + 2, c.TX_COLUMNS, name, r[name]);
        });
    });
    return c;
  }

  const tx = (over = {}) => Object.assign({
    uid: 'u-' + Math.random().toString(36).slice(2),
    account_id: 'acc-1',
    account_name: 'Revolut',
    booking_date: new Date(2026, 6, 15),
    amount: 12.5,
    currency: 'EUR',
    description: 'COOP SUPERMERCATO',
    source: 'enablebanking',
    imported_at: new Date(),
    amount_base: -12.5,
    category: 'Food & Drink',
    subcategory: 'Groceries',
    type: 'expense',
    in_reports: true
  }, over);

  const july = { period: { kind: 'month', year: 2026, month: 7 } };

  it('answers with the size of the answer, not the size of the ledger', () => {
    const c = bookWith([tx(), tx({ amount_base: -30, category: 'Transport' })]);
    const result = c.webAppAnalytics_(july);

    expect(result.totals).toMatchObject({ expenses: 42.5, count: 2 });
    expect(result.window).toEqual({ kind: 'month', from: '2026-07-01', to: '2026-07-31' });
    expect(result.currency).toBe('EUR');
  });

  it('sends no Date across the wire, because one does not survive the trip', () => {
    // google.script.run serialises, and a real Date does not come out the
    // other side as one.
    const c = bookWith([tx()]);
    const seen = JSON.parse(JSON.stringify(c.webAppAnalytics_(july)));

    expect(seen.window.from).toBe('2026-07-01');
    expect(seen.cashflow.every((b) => typeof b.key === 'string')).toBe(true);
    expect(seen.balance.every((p) => typeof p.key === 'string')).toBe(true);
  });

  it('pages the records newest first', () => {
    const c = bookWith([
      tx({ booking_date: new Date(2026, 6, 1), description: 'oldest' }),
      tx({ booking_date: new Date(2026, 6, 20), description: 'newest' }),
      tx({ booking_date: new Date(2026, 6, 10), description: 'middle' })
    ]);

    const page = c.webAppRecords_(july, 0);
    expect(page.rows.map((r) => r.description)).toEqual(['newest', 'middle', 'oldest']);
    expect(page).toMatchObject({ total: 3, offset: 0, hasMore: false });
  });

  it('puts the one you just typed above the one from this morning', () => {
    // `transactions` is append-only and never sorted, so row order is insert
    // order — which for two rows on the same day is all there is to go on.
    const c = bookWith([
      tx({ booking_date: new Date(2026, 6, 10), description: 'this morning' }),
      tx({ booking_date: new Date(2026, 6, 10), description: 'just now' })
    ]);

    expect(c.webAppRecords_(july, 0).rows.map((r) => r.description))
      .toEqual(['just now', 'this morning']);
  });

  it('hands back one page at a time and says there is more', () => {
    const rows = [];
    for (let i = 0; i < 120; i++) {
      rows.push(tx({ booking_date: new Date(2026, 6, 1 + (i % 28)) }));
    }
    const c = bookWith(rows);

    const first = c.webAppRecords_(july, 0);
    expect(first.rows).toHaveLength(ctx.QUERY_PAGE_SIZE);
    expect(first).toMatchObject({ total: 120, hasMore: true });

    const second = c.webAppRecords_(july, ctx.QUERY_PAGE_SIZE);
    expect(second.rows).toHaveLength(20);
    expect(second.hasMore).toBe(false);
  });

  it('lists a transfer, because the ledger is not a spending report', () => {
    // Every other block asks "what did I spend". This one asks "what is in my
    // ledger", and a row you cannot find here is a row you conclude never
    // imported.
    const c = bookWith([
      tx({ description: 'a transfer', type: 'transfer', in_reports: false })
    ]);

    expect(c.webAppRecords_(july, 0).rows.map((r) => r.description)).toEqual(['a transfer']);
    expect(c.webAppAnalytics_(july).totals.count).toBe(0);
  });

  it('searches the fields a phone would search', () => {
    const c = bookWith([
      tx({ description: 'ESSELUNGA' }),
      tx({ description: 'TRENITALIA', category: 'Transport', subcategory: 'Public transport' })
    ]);

    const found = c.webAppRecords_({ ...july, search: 'trenit' }, 0);
    expect(found.rows.map((r) => r.description)).toEqual(['TRENITALIA']);

    const byCategory = c.webAppRecords_({ ...july, search: 'public tran' }, 0);
    expect(byCategory.rows).toHaveLength(1);
  });

  it('narrows to the backlog when asked, since that is what a phone is for', () => {
    const c = bookWith([
      tx({ description: 'done', confirmed: true }),
      tx({ description: 'waiting' })
    ]);

    expect(c.webAppRecords_({ ...july, unconfirmedOnly: true }, 0).rows.map((r) => r.description))
      .toEqual(['waiting']);
  });

  it('anchors the trend to what the accounts are worth now', () => {
    const c = bookWith([tx({ booking_date: new Date(2026, 6, 20), amount_base: -100 })]);

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    c.appendRows_(accounts, 1, [c.toRow_(c.ACCOUNT_COLUMNS, {
      account_id: 'acc-1', name: 'Revolut', kind: 'bank', currency: 'EUR',
      balance: 900, include_in_net_worth: true, active: true
    })]);

    const result = c.webAppAnalytics_(july);
    expect(result.netWorth).toMatchObject({ total: 900, counted: 1, currency: 'EUR' });
    expect(result.balance[0].value).toBe(1000);
    expect(result.balance.at(-1).value).toBe(900);
  });

  it('leaves an account out of net worth rather than adding a currency it cannot convert', () => {
    // An account's balance is in that account's currency. Adding a CHF pocket
    // to a euro total is wrong by whatever the rate is and looks exactly right.
    const c = bookWith([]);
    const accounts = c.__spreadsheet.getSheetByName('accounts');
    c.appendRows_(accounts, 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'a', name: 'Euro', kind: 'bank', currency: 'EUR',
        balance: 100, include_in_net_worth: true, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'b', name: 'Franc', kind: 'bank', currency: 'CHF',
        balance: 5000, include_in_net_worth: true, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'c', name: 'Old', kind: 'bank', currency: 'EUR',
        balance: 40, include_in_net_worth: true, active: false })
    ]);

    expect(c.webAppAnalytics_({}).netWorth).toMatchObject({ total: 100, counted: 1, skipped: 1 });
  });

  it('works on a book with no transactions in it at all', () => {
    const c = bookWith([]);
    expect(() => c.webAppAnalytics_({})).not.toThrow();
    expect(c.webAppRecords_({}, 0)).toMatchObject({ rows: [], total: 0, hasMore: false });
  });
});
