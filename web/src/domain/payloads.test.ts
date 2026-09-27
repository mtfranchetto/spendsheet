/**
 * The payloads the screens draw, asked of books built for one question each.
 *
 * `tests/parity.test.mjs` holds every field of every payload to what the Apps
 * Script viewer answered, over one realistic book. What that cannot reach is
 * the book that is not realistic — empty, half-filled, a date nobody can read,
 * an account whose kind was never typed — and those are the cases here.
 */

import { describe, expect, it } from 'vitest';
import { dayKey } from './days';
import { appDashboardData, appOpenData, appOverviewData, appPeriods, appRecordsData } from './payloads';
import { amountIsEditable, descriptionIsEditable, recordIsDeletable, resolveWindow, splitLabels } from './query';
import { normalizeMerchant } from './merchant';
import { at, bookOf, CATEGORIES, serial, type Values } from './testing';

const NOW = at(2026, 9, 27);

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
  amount_base: -12.5,
  category: 'Food & Drink',
  subcategory: 'Groceries',
  category_source: 'rule',
  type: 'expense',
  in_reports: true,
  ...over
});

const last12 = { period: { kind: 'last_12' } };

describe('the periods the picker offers', () => {
  const periods = (days: (number | string)[]) => {
    const { ledger } = bookOf({ transactions: days.map((booking_date) => tx({ booking_date })) });
    return appPeriods(ledger, NOW);
  };
  const years = (list: ReturnType<typeof appPeriods>) => list.filter((p) => p.kind === 'year').map((p) => p.year);

  it('offers only years the ledger has rows in', () => {
    // An empty result from a period you chose is indistinguishable from a
    // filter bug, and there is nothing on the screen to tell them apart.
    expect(years(periods([serial(2024, 4, 2), serial(2022, 11, 9), serial(2024, 9, 1)]))).toEqual([2024, 2022]);
  });

  it('leaves the current year to year-to-date', () => {
    const list = periods([serial(2026, 9, 1)]);
    expect(years(list)).not.toContain(2026);
    expect(list.some((p) => p.kind === 'ytd')).toBe(true);
  });

  it('gives every entry an id, and every id is distinct', () => {
    // The named years all share `kind: "year"`, so a page matching on kind
    // would mark them all selected and send a spec with no year in it.
    const ids = periods([serial(2024, 2, 1), serial(2023, 2, 1)]).map((p) => p.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('year:2024');
  });

  it('survives an empty ledger and a ledger of unreadable dates', () => {
    for (const list of [periods([]), periods(['', 'not a date'])]) {
      expect(years(list)).toEqual([]);
      // The fixed entries are always there, so the picker is never empty.
      expect(list.map((p) => p.id)).toContain('mtd');
      expect(list.map((p) => p.id)).toContain('custom');
    }
  });

  it('offers a month as one entry, not as twelve', () => {
    // The page draws the twelve as chips under this single option, which it can
    // only do while the id is the bare kind.
    const months = periods([serial(2024, 2, 1), serial(2023, 2, 1)]).filter((p) => p.kind === 'month');
    expect(months).toHaveLength(1);
    expect(months[0].id).toBe('month');
    expect(months[0].year).toBeUndefined();
  });

  it('resolves the spec its month entry stands for', () => {
    const window = resolveWindow({ kind: 'month', year: 2026, month: 3 }, at(2026, 8, 9));
    expect([dayKey(window.from), dayKey(window.to)]).toEqual(['2026-03-01', '2026-03-31']);
  });

  it('caps the years, so one corrupt date cannot fill the dropdown', () => {
    const days = [];
    for (let y = 1900; y < 2020; y++) days.push(serial(y, 6, 1));
    expect(years(periods(days))).toHaveLength(10);
  });
});

describe('the taxonomy the sheet offers', () => {
  const choices = () => {
    const { book, ledger } = bookOf({ transactions: [tx()], categories: CATEGORIES });
    return appOverviewData(book, ledger, NOW).lists.categories;
  };

  it('carries kind on parents as well as children', () => {
    // The page filters the pickers by kind so a salary is not offered Groceries.
    const kinds = Object.fromEntries(choices().parents.map((p) => [p.name, p.kind]));
    expect(kinds).toMatchObject({ Income: 'income', Transfer: 'transfer', 'Food & Drink': 'expense' });
  });

  it('agrees with the formula about which kind a parent is', () => {
    // `typeFormula()` takes the first matching row of categories, and so does this.
    const { book, ledger } = bookOf({
      transactions: [tx()],
      categories: [
        { category: 'Odd', subcategory: 'First', kind: 'expense' },
        { category: 'Odd', subcategory: 'Second', kind: 'income' }
      ]
    });
    expect(appOverviewData(book, ledger, NOW).lists.categories.parents).toEqual([{ name: 'Odd', icon: '', kind: 'expense' }]);
  });

  it('offers a subcategory with the parent it names, since that is one choice', () => {
    const groceries = choices().children.find((entry) => entry.name === 'Groceries');
    expect(groceries).toMatchObject({ parent: 'Food & Drink' });
    expect(groceries!.icon).toBeTruthy();
  });
});

describe('the dashboard', () => {
  it('computes its numbers from the ledger', () => {
    const { book, ledger } = bookOf({
      transactions: [
        tx({ booking_date: serial(2026, 9, 1), amount_base: -20 }),
        tx({ booking_date: serial(2026, 9, 1), amount_base: -5, category: 'Transport' })
      ]
    });
    const data = appDashboardData(book, ledger, NOW);
    expect(data.month.byCategory.map((r) => r.name)).toEqual(['Food & Drink', 'Transport']);
    expect(data.currency).toBe('EUR');
  });

  it('runs the failure detectors rather than a second opinion about them', () => {
    const { book, ledger } = bookOf({
      _runs: [{ run_id: 'r1', started_at: serial(2020, 1, 1), result: 'FAIL', accounts_attempted: 1 }]
    });
    expect(appDashboardData(book, ledger, NOW).health.some((a) => a.kind === 'never_ran')).toBe(true);
  });

  it('reads the backlog live, so a confirmed row leaves it at once', () => {
    const queue = (confirmed: boolean) => {
      const { book, ledger } = bookOf({ transactions: [tx({ uid: 'u-a', confirmed }), tx({ uid: 'u-b' })] });
      return appDashboardData(book, ledger, NOW).review.map((r) => r.uid);
    };
    expect(queue(false)).toEqual(['u-a', 'u-b']);
    expect(queue(true)).toEqual(['u-b']);
  });

  it('suggests a category for an unclassified row from a merchant memory knows', () => {
    const { book, ledger } = bookOf({
      transactions: [
        tx({ uid: 'u-a', description: 'ESSELUNGA MILANO', category: '', subcategory: '', category_source: 'unclassified' }),
        tx({ uid: 'u-b', description: 'ESSELUNGA MILANO' })
      ],
      _memory: [{ merchant_key: 'esselunga torino', category: 'Food & Drink', subcategory: 'Groceries', hits: 3 }]
    });

    const [unclassified, ruled] = appOverviewData(book, ledger, NOW).review;
    expect({ ...unclassified.suggestion }).toEqual({ category: 'Food & Drink', subcategory: 'Groceries', from: 'esselunga torino' });
    // A row the cascade already answered is not second-guessed.
    expect(ruled.suggestion).toBeUndefined();
  });

  it('sends the time of day a row recorded one, and nothing when it knows only the day', () => {
    const { book, ledger } = bookOf({
      transactions: [
        tx({ uid: 'u-a', transaction_date: serial(2026, 7, 15, 8, 5) }),
        tx({ uid: 'u-b', transaction_date: serial(2026, 7, 15) })
      ]
    });
    const times = Object.fromEntries(appOverviewData(book, ledger, NOW).review.map((r) => [r.uid, r.time]));
    expect(times).toEqual({ 'u-a': '08:05', 'u-b': '' });
  });

  it('marks an account whose consent has gone, and leaves a cash tin alone', () => {
    // A cash tin has no consent to expire, and marking it every day is how a
    // whole column stops being read.
    const { book } = bookOf({
      accounts: [
        { account_id: 'b', name: 'Revolut', kind: 'bank', currency: 'EUR', balance: 100, active: true, connection_id: 'c-1' },
        { account_id: 'w', name: 'Wallet', kind: 'cash', currency: 'EUR', balance: 20, active: true }
      ],
      _status: [{ connection_id: 'c-1', provider: 'Revolut', days_left: -1 }]
    });
    const byName = Object.fromEntries(appOpenData(book, NOW).accounts.map((a) => [a.name, a]));
    expect(byName.Revolut).toMatchObject({ severity: 2 });
    expect(byName.Revolut.sync).toContain('expired');
    expect(byName.Wallet).toMatchObject({ severity: 0, sync: '—' });
  });

  it('lists the banks, then the cash, then the assets, each by balance', () => {
    // Every balance here would interleave the kinds under a pure balance ranking.
    const { book } = bookOf({
      accounts: [
        { account_id: 'h', name: 'House', kind: 'asset', currency: 'EUR', balance: 500000, active: true },
        { account_id: 'w', name: 'Wallet', kind: 'cash', currency: 'EUR', balance: 20, active: true },
        { account_id: 'b', name: 'Revolut', kind: 'bank', currency: 'EUR', balance: 100, active: true },
        { account_id: 'c', name: 'Car', kind: 'asset', currency: 'EUR', balance: 1000, active: true },
        { account_id: 't', name: 'Tin', kind: 'cash', currency: 'EUR', balance: 300, active: true },
        { account_id: 'f', name: 'Fineco', kind: 'bank', currency: 'EUR', balance: 5, active: true }
      ]
    });
    expect(appOpenData(book, NOW).accounts.map((a) => a.name)).toEqual(['Revolut', 'Fineco', 'Tin', 'Wallet', 'House', 'Car']);
  });

  it('sorts an account whose kind it does not know to the end', () => {
    // A rank of -1 in front of `bank` would put the row nobody finished filling in at the top.
    const { book } = bookOf({
      accounts: [
        { account_id: 'x', name: 'Unfilled', kind: '', currency: 'EUR', balance: 900, active: true },
        { account_id: 'h', name: 'House', kind: 'asset', currency: 'EUR', balance: 500, active: true },
        { account_id: 'b', name: 'Revolut', kind: 'bank', currency: 'EUR', balance: 100, active: true }
      ]
    });
    expect(appOpenData(book, NOW).accounts.map((a) => a.name)).toEqual(['Revolut', 'House', 'Unfilled']);
  });

  it('warns rather than alarms about a balance that has not moved', () => {
    // A weekend, a bank holiday and a quiet current account all produce one.
    const { book } = bookOf({
      accounts: [{ account_id: 'b', name: 'Revolut', kind: 'bank', currency: 'EUR', balance: 100, active: true,
        connection_id: 'c-1', balance_updated_at: serial(2026, 8, 28) }],
      _status: [{ connection_id: 'c-1', days_left: 90 }]
    });
    const [account] = appOpenData(book, NOW).accounts;
    expect(account.severity).toBe(1);
    expect(account.sync).toContain('days old');
  });

  it('compares this month against the same point last month', () => {
    // Never against a whole month: that flatters you on the 3rd and alarms you on the 30th.
    const { book, ledger } = bookOf({
      transactions: [
        tx({ booking_date: serial(2026, 9, 1), amount_base: -10 }),
        tx({ booking_date: serial(2026, 8, 1), amount_base: -40 }),
        tx({ booking_date: serial(2026, 8, 30), amount_base: -99 })
      ]
    });
    const { month } = appDashboardData(book, ledger, NOW);
    expect(month.expenses).toBe(10);
    expect(month.lastMonthToDate).toBe(40);
  });

  it('offers asset accounts with their balances, and cash accounts by name', () => {
    // Setting a value is a difference, so the screen cannot ask the question
    // without knowing the answer it is changing.
    const { book } = bookOf({
      accounts: [
        { account_id: 'a', name: 'Degiro', kind: 'asset', currency: 'EUR', balance: 14200, active: true },
        { account_id: 'w', name: 'Wallet', kind: 'cash', currency: 'EUR', balance: 20, active: true },
        { account_id: 'b', name: 'Revolut', kind: 'bank', currency: 'EUR', balance: 100, active: true }
      ]
    });
    const { lists } = appOpenData(book, NOW);
    expect(lists.assetAccounts).toEqual([{ name: 'Degiro', balance: 14200, currency: 'EUR' }]);
    expect(lists.cashAccounts).toEqual(['Wallet']);
  });
});

describe('the two halves the dashboard opens with', () => {
  const hold: Values = {
    uid: 'p-1', account_id: 'acc-1', account_name: 'Revolut', booking_date: serial(2026, 9, 22),
    amount: -18.4, currency: 'EUR', description: 'HOTEL BOOKING', source: 'enablebanking'
  };

  it('puts only what needs no ledger in the first', () => {
    const { book } = bookOf({ transactions: [tx()] });
    const open = appOpenData(book, NOW);
    expect(Object.keys(open).sort()).toEqual(['accounts', 'currency', 'generatedAt', 'lists', 'netWorth']);
    expect(Object.keys(open.lists).sort()).toEqual(['accounts', 'assetAccounts', 'cashAccounts']);
  });

  it('carries the month, the queue and the health banner in the second', () => {
    const { book, ledger } = bookOf({ transactions: [tx()] });
    const overview = appOverviewData(book, ledger, NOW);
    expect(Object.keys(overview).sort()).toEqual(['health', 'lists', 'month', 'pending', 'review', 'screens', 'trend']);
    expect(overview.lists.periods.map((p) => p.kind)).toContain('mtd');
    expect(overview.month.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('sends the holds to the dashboard at the top level, not only through Records', () => {
    // `screens` seeds Records, which has an account filter; the dashboard has
    // none and must not inherit one.
    const { book, ledger } = bookOf({ transactions: [tx()], pending: [hold] });
    const overview = appOverviewData(book, ledger, NOW);
    expect(overview.pending.map((p) => p.description)).toEqual(['HOTEL BOOKING']);
    expect(overview.pending[0].pending).toBe(true);
    expect(overview.pending).toEqual(overview.screens.records.pending);
    expect(appDashboardData(book, ledger, NOW).pending.map((p) => p.description)).toEqual(['HOTEL BOOKING']);
  });

  it('sends an empty list rather than nothing when there are no holds', () => {
    const { book, ledger } = bookOf({ transactions: [tx()] });
    expect(appOverviewData(book, ledger, NOW).pending).toEqual([]);
    expect(appDashboardData(book, ledger, NOW).pending).toEqual([]);
  });

  it('together offer every list the page reads', () => {
    const { book, ledger } = bookOf({});
    const sent = [...Object.keys(appOpenData(book, NOW).lists), ...Object.keys(appOverviewData(book, ledger, NOW).lists)].sort();
    expect(sent).toEqual(['accounts', 'assetAccounts', 'cashAccounts', 'categories', 'labels', 'periods']);
  });

  it('works on a book with nothing in it at all', () => {
    const { book, ledger } = bookOf({});
    expect(() => appOpenData(book, NOW)).not.toThrow();
    expect(appOverviewData(book, ledger, NOW).review).toEqual([]);
  });

  it('offers no label that is really a boolean', () => {
    const { book, ledger } = bookOf({ labels: [{ label: 'travel' }, { label: false }] });
    expect(appOverviewData(book, ledger, NOW).lists.labels).toEqual(['travel']);
  });
});

describe('what a record tells the page it may do', () => {
  it('names which rows may be renamed: everything a bank will not fetch again', () => {
    expect(descriptionIsEditable('enablebanking')).toBe(false);
    for (const source of ['manual', 'transfer-leg', 'csv:budgetbakers', '']) expect(descriptionIsEditable(source), source).toBe(true);
  });

  it('names which rows may be deleted, which is a narrower list than that', () => {
    // A transfer leg and an imported row are editable and not deletable.
    expect(recordIsDeletable('manual')).toBe(true);
    for (const source of ['enablebanking', 'transfer-leg', 'csv:budgetbakers', '', null, undefined]) {
      expect(recordIsDeletable(source), String(source)).toBe(false);
    }
  });

  it('names which rows may have their amount changed: cash you typed, while no transfer mirrors it', () => {
    expect(amountIsEditable('manual', '')).toBe(true);
    expect(amountIsEditable('manual', 'tr:u-1')).toBe(false);
    for (const source of ['enablebanking', 'transfer-leg', 'csv:budgetbakers', '', null, undefined]) {
      expect(amountIsEditable(source, ''), String(source)).toBe(false);
    }
  });

  it('sends each of those answers, and the merchant key, with the row', () => {
    const { book, ledger } = bookOf({
      transactions: [
        tx({ uid: 'u-bank', description: 'ESSELUNGA CARTA *1234 12/07' }),
        tx({ uid: 'u-cash', source: 'manual' })
      ]
    });
    const rows = appRecordsData(book, ledger, last12, 0, NOW).rows;
    const bank = rows.find((r) => r.uid === 'u-bank')!;
    const cash = rows.find((r) => r.uid === 'u-cash')!;

    expect([cash.deletable, cash.editableAmount, cash.editableDescription]).toEqual([true, true, true]);
    expect([bank.deletable, bank.editableAmount, bank.editableDescription]).toEqual([false, false, false]);
    expect(bank.merchantKey).toBe(normalizeMerchant('ESSELUNGA CARTA *1234 12/07', ''));
    expect(bank.merchantKey).not.toMatch(/1234/);
  });

  it('does not read a boolean labels cell as a label called "false"', () => {
    expect(splitLabels(false)).toEqual([]);
    expect(splitLabels(true)).toEqual([]);
    const { book, ledger } = bookOf({ transactions: [tx({ labels: false })] });
    expect(appRecordsData(book, ledger, last12, 0, NOW).rows[0].labels).toEqual([]);
  });
});
