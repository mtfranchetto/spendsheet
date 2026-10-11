/**
 * The long view, asked directly.
 *
 * What gets tested hard is what a long window makes easy to get wrong:
 *
 *   **The edges of a year.** "A year ago" has no answer on 29 February, and a
 *   window that is a day long or short is a total that looks right.
 *
 *   **The month in progress**, which must never appear in a monthly series.
 *
 *   **Short ledgers.** Five months is not a year, and nothing here may pretend
 *   it is by dividing by twelve.
 *
 *   **Blanks.** A month with no income has no savings rate.
 *
 * Ledgers are a salary on the 1st and rent on the 15th of every month, so each
 * expected figure is a count of 1sts and 15ths inside a window.
 */

import { describe, expect, it } from 'vitest';
import { dayKey, SERIAL_EPOCH, type Clock } from './days';
import { completeMonths, longView, longWindows, sameDate } from './longview';
import { netWorthNow } from './query';
import { at, bookOf, serial, type Values } from './testing';

const BANK: Values = {
  account_id: 'b', name: 'Bank', kind: 'bank', currency: 'EUR', balance: 10000,
  include_in_net_worth: true, active: true
};

let uid = 0;
function row(year: number, month: number, date: number, amount: number, over: Values = {}): Values {
  return {
    uid: 'u-' + ++uid,
    account_id: 'b',
    account_name: 'Bank',
    booking_date: serial(year, month, date),
    amount: Math.abs(amount),
    amount_base: amount,
    currency: 'EUR',
    category: amount < 0 ? 'Housing' : 'Income',
    subcategory: amount < 0 ? 'Rent' : 'Salary',
    type: amount < 0 ? 'expense' : 'income',
    in_reports: true,
    ...over
  };
}

/** `count` whole months ending with `lastMonth` of `lastYear`: `income` on the 1st, `rent` on the 15th. */
function monthsEnding(lastYear: number, lastMonth: number, count: number, income = 3000, rent = 2000): Values[] {
  const rows: Values[] = [];
  for (let back = count - 1; back >= 0; back--) {
    const when = new Date(Date.UTC(lastYear, lastMonth - 1 - back, 1));
    const year = when.getUTCFullYear();
    const month = when.getUTCMonth() + 1;
    if (income) rows.push(row(year, month, 1, income));
    if (rent) rows.push(row(year, month, 15, -rent));
  }
  return rows;
}

function view(transactions: Values[], clock: Clock, accounts: Values[] = [BANK]) {
  const { book, ledger } = bookOf({ transactions, accounts });
  return longView(book, ledger, clock);
}

/** 11 October 2026: every ledger below ends with September, the last complete month. */
const NOW = at(2026, 10, 11);

describe('the windows', () => {
  const keys = (clock: Clock) => {
    const { t12, p12 } = longWindows(clock);
    return [dayKey(t12.from), dayKey(t12.to), dayKey(p12.from), dayKey(p12.to)];
  };

  it('runs T12 from the day after the same date a year ago, and P12 the year before it', () => {
    expect(keys(NOW)).toEqual(['2025-10-12', '2026-10-11', '2024-10-12', '2025-10-11']);
  });

  it('takes 28 February for a 29th that last year did not have', () => {
    const leap = at(2028, 2, 29);
    expect(dayKey(sameDate(leap, 1))).toBe('2027-02-28');
    expect(keys(leap)).toEqual(['2027-03-01', '2028-02-29', '2026-03-01', '2027-02-28']);
  });

  it('crosses the year on 1 January and the month on the 1st', () => {
    expect(keys(at(2026, 1, 1))).toEqual(['2025-01-02', '2026-01-01', '2024-01-02', '2025-01-01']);
    expect(keys(at(2026, 10, 1))).toEqual(['2025-10-02', '2026-10-01', '2024-10-02', '2025-10-01']);
  });

  it('counts the first month only when the ledger starts on its 1st, and never the month in progress', () => {
    const months = (year: number, month: number, date: number) =>
      completeMonths(serial(year, month, date) - SERIAL_EPOCH, NOW).map(dayKey);
    expect(months(2026, 7, 1)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01']);
    expect(months(2026, 7, 2)).toEqual(['2026-08-01', '2026-09-01']);
    expect(months(2026, 10, 1)).toEqual([]);
    expect(completeMonths(null, NOW)).toEqual([]);
  });
});

describe('a ledger of five months', () => {
  const data = view(monthsEnding(2026, 9, 5), NOW);

  it('says how many months it holds, and divides nothing by twelve', () => {
    expect(data.history).toEqual({ months: 5, aYear: false, twoYears: false });
    expect(data.spending).toEqual({ total: 10000, monthly: null });
    expect(data.runway).toEqual({ liquid: 10000, months: null });
    expect(data.pace).toBeNull();
    expect(data.categories[0]).toMatchObject({ name: 'Housing', total: 10000, share: 1, monthly: null });
  });

  it('still has a savings rate, which is a ratio and needs no year', () => {
    expect(data.income).toBe(15000);
    expect(data.savingsRate).toBeCloseTo(1 / 3);
  });

  it('compares nothing with a year it does not have', () => {
    expect(data.rolling).toEqual([]);
    expect(data.compared).toBeNull();
    expect(data.movers).toBeNull();
    expect(data.years).toEqual([]);
  });

  it('measures the change in net worth from its first row, and says so', () => {
    expect(data.netWorth).toMatchObject({ now: 10000, before: 5000, change: 5000, since: '2026-04-30', sinceStart: true });
  });

  it('leaves a calendar month it has never seen blank rather than free', () => {
    expect(data.typical.months).toEqual([null, null, null, null, 2000, 2000, 2000, 2000, 2000, null, null, null]);
    expect(data.typical.usual).toBe(2000);
  });
});

describe('a ledger of thirteen months', () => {
  const data = view(monthsEnding(2026, 9, 13), NOW);

  it('has a year: twelve 15ths and eleven 1sts fall inside T12', () => {
    expect(data.history).toEqual({ months: 13, aYear: true, twoYears: false });
    expect(data.window).toEqual({ from: '2025-10-12', to: '2026-10-11' });
    expect(data.spending).toEqual({ total: 24000, monthly: 2000 });
    expect(data.income).toBe(33000);
    expect(data.saved).toBe(9000);
    expect(data.runway.months).toBe(5);
  });

  it('draws one rolling point per complete month that has eleven before it', () => {
    expect(data.rolling).toEqual([
      { key: '2026-08', income: 36000, expenses: 24000 },
      { key: '2026-09', income: 36000, expenses: 24000 }
    ]);
  });

  it('projects at this pace with no growth, and still compares nothing with P12', () => {
    expect(data.pace).toEqual([{ years: 1, value: 19000 }, { years: 5, value: 55000 }, { years: 10, value: 100000 }]);
    expect(data.compared).toBeNull();
    expect(data.movers).toBeNull();
  });

  it("lists only the year it covers from January, to today's date", () => {
    expect(data.years).toEqual([{ year: 2026, toDate: 18000, full: null }]);
    expect(data.yearTo).toBe('2026-10-11');
  });

  it('keeps the last twelve complete months of savings rate', () => {
    expect(data.rates).toHaveLength(12);
    expect(data.rates[0].key).toBe('2025-10');
    expect(data.rates[11]).toEqual({ key: '2026-09', income: 3000, expenses: 2000, rate: 1 / 3 });
  });

  it('shows the decline when more is spent than earned', () => {
    const losing = view(monthsEnding(2026, 9, 13, 3000, 4000), NOW);
    expect(losing.saved).toBe(-15000);
    expect(losing.savingsRate).toBeCloseTo(-15000 / 33000);
    expect(losing.pace).toEqual([{ years: 1, value: -5000 }, { years: 5, value: -65000 }, { years: 10, value: -140000 }]);
  });
});

describe('a ledger of twenty-five months', () => {
  const data = view([
    ...monthsEnding(2026, 9, 25),
    row(2026, 8, 20, -600, { category: 'Travel', subcategory: 'Flights' }),
    row(2025, 8, 20, -300, { category: 'Health', subcategory: 'Pharmacy' })
  ], NOW);

  it('compares T12 with P12, which holds twelve of each', () => {
    expect(data.history).toEqual({ months: 25, aYear: true, twoYears: true });
    expect(data.previous).toEqual({ from: '2024-10-12', to: '2025-10-11' });
    expect(data.compared!.income).toBeCloseTo(33000 / 36000 - 1);
    expect(data.compared!.spending).toBeCloseTo(24600 / 24300 - 1);
    expect(data.compared!.savedBefore).toBe(11700);
  });

  it('counts a category absent from one window as zero there, and leaves out one that did not move', () => {
    expect(data.movers).toEqual([
      { name: 'Travel', now: 600, before: 0, change: 600 },
      { name: 'Health', now: 0, before: 300, change: -300 }
    ]);
  });

  it('compares every category, not only the thirty largest of each window', () => {
    // Forty categories in each year. `Small` is the smallest of last year's and
    // among the largest of this one: cut from last year's list, it would read
    // as a thousand of new spending rather than nine hundred more.
    const many = (year: number) => Array.from({ length: 40 }, (_, i) =>
      row(year, 8, 20, -(1000 + i), { category: 'Category ' + i, subcategory: 'Any' }));
    const answer = view([
      ...monthsEnding(2026, 9, 25),
      ...many(2025), ...many(2026),
      row(2025, 8, 21, -100, { category: 'Small', subcategory: 'Any' }),
      row(2026, 8, 21, -1000, { category: 'Small', subcategory: 'Any' })
    ], NOW);
    expect(answer.movers).toEqual([{ name: 'Small', now: 1000, before: 100, change: 900 }]);
  });

  it('gives a finished year its whole, and both years the same stretch from January', () => {
    expect(data.years).toEqual([
      { year: 2025, toDate: 18300, full: 24300 },
      { year: 2026, toDate: 18600, full: null }
    ]);
  });

  it('gives each category its share of spending and a monthly average', () => {
    expect(data.categories.map((entry) => entry.name)).toEqual(['Housing', 'Travel']);
    expect(data.categories[1]).toMatchObject({ total: 600, monthly: 50 });
    expect(data.categories[1].share).toBeCloseTo(600 / 24600);
  });

  it('averages each calendar month over every complete one', () => {
    // September three times; August twice, once with the flight and once with the pharmacy.
    expect(data.typical.months[8]).toBe(2000);
    expect(data.typical.months[7]).toBe(2450);
  });
});

describe('awkward instants', () => {
  it('on 1 January, ends the monthly series with December and gives the new year one day', () => {
    const data = view(monthsEnding(2025, 12, 12), at(2026, 1, 1));
    expect(data.history.months).toBe(12);
    expect(data.rates[11].key).toBe('2025-12');
    // T12 starts on 2 January, so the salary of 1 January 2025 is outside it.
    expect(data.income).toBe(33000);
    expect(data.years).toEqual([
      { year: 2025, toDate: 0, full: 24000 },
      { year: 2026, toDate: 0, full: null }
    ]);
  });

  it('on the first of a month, counts the month that ended yesterday and not the one starting', () => {
    const data = view([...monthsEnding(2026, 9, 13), row(2026, 10, 1, 3000)], at(2026, 10, 1));
    expect(data.rates[11].key).toBe('2026-09');
    // Twelve 1sts from November to today's, twelve 15ths from October to September.
    expect(data.income).toBe(36000);
    expect(data.spending.total).toBe(24000);
  });

  it('on 29 February, takes a window of whole months', () => {
    const data = view(monthsEnding(2028, 1, 13), at(2028, 2, 29));
    expect(data.window).toEqual({ from: '2027-03-01', to: '2028-02-29' });
    // March 2027 to January 2028: eleven of each.
    expect(data.income).toBe(33000);
    expect(data.spending.total).toBe(22000);
    expect(data.rates[11].key).toBe('2028-01');
  });

  it('keeps the month in progress out of every monthly series, and in the year', () => {
    const data = view([...monthsEnding(2026, 9, 13), row(2026, 10, 5, -500)], NOW);
    expect(data.rates.map((month) => month.key)).not.toContain('2026-10');
    expect(data.rolling[data.rolling.length - 1]).toEqual({ key: '2026-09', income: 36000, expenses: 24000 });
    expect(data.typical.months[9]).toBe(2000);
    expect(data.spending.total).toBe(24500);
  });
});

describe('blanks', () => {
  it('gives a month with no income no savings rate', () => {
    const rows = monthsEnding(2026, 9, 3).filter((entry) => entry.booking_date !== serial(2026, 8, 1));
    const data = view(rows, NOW);
    expect(data.rates.map((month) => month.rate)).toEqual([1 / 3, null, 1 / 3]);
    expect(data.rates[1]).toMatchObject({ income: 0, expenses: 2000 });
  });

  it('gives a year with no income no savings rate either', () => {
    const data = view(monthsEnding(2026, 9, 13, 0, 2000), NOW);
    expect(data.income).toBe(0);
    expect(data.savingsRate).toBeNull();
  });

  it('gives a year with no spending no runway', () => {
    expect(view(monthsEnding(2026, 9, 13, 3000, 0), NOW).runway.months).toBeNull();
  });

  it('counts a row with no base amount as left out, not as zero', () => {
    const data = view([...monthsEnding(2026, 9, 13), row(2026, 9, 20, -45, { amount_base: '', currency: 'GBP' })], NOW);
    expect(data.unconvertible).toBe(1);
    expect(data.spending.total).toBe(24000);
  });

  it('answers an empty ledger with nothing rather than with zeros that look like a quiet year', () => {
    const data = view([], NOW);
    expect(data.history.months).toBe(0);
    expect(data.savingsRate).toBeNull();
    expect(data.netWorth.series).toEqual([]);
    expect(data.rates).toEqual([]);
    expect(data.typical).toEqual({ months: Array(12).fill(null), usual: null });
  });
});

describe('net worth', () => {
  const accounts: Values[] = [
    BANK,
    { account_id: 'w', name: 'Wallet', kind: 'cash', currency: 'EUR', balance: 200, include_in_net_worth: true, active: true },
    { account_id: 'f', name: 'Fund', kind: 'asset', currency: 'EUR', balance: 50000, include_in_net_worth: true, active: true },
    { account_id: 'o', name: 'Old', kind: 'bank', currency: 'EUR', balance: 999, include_in_net_worth: false, active: true },
    { account_id: 'd', name: 'Dollars', kind: 'bank', currency: 'USD', balance: 500, include_in_net_worth: true, active: true }
  ];
  const moved = { category: 'Transfer', type: 'transfer', in_reports: false };
  const transactions = [
    row(2026, 3, 1, 3000),
    row(2026, 3, 15, -1000),
    row(2026, 4, 1, 700, { account_name: 'Fund', ...moved, subcategory: 'Valuation change' }),
    row(2026, 5, 1, 250, { ...moved, subcategory: 'Between accounts' }),
    row(2026, 6, 1, -40, { account_name: 'Old' }),
    // Before T12: part of the line, no part of the year's change.
    row(2025, 6, 1, 5000)
  ];
  const { book, ledger } = bookOf({ transactions, accounts });
  const data = longView(book, ledger, NOW);

  it('counts the accounts net worth counts, and the rows booked on them', () => {
    expect(data.netWorth.now).toBe(netWorthNow(book, {}).total);
    expect(data.netWorth).toMatchObject({ now: 60200, change: 2950, before: 57250, since: '2025-10-11', sinceStart: false });
  });

  it('splits the change three ways and keeps the remainder apart', () => {
    // Saved includes the €40 spent from an account net worth does not count;
    // the remainder is that and the €250 that arrived as neither income nor spending.
    expect(data.sources).toEqual({ saved: 1960, revalued: 700, other: 290 });
    expect(data.sources.saved + data.sources.revalued + data.sources.other).toBe(data.netWorth.change);
  });

  it('has no remainder when income, spending and revaluation explain the change', () => {
    const plain = bookOf({ transactions: transactions.slice(0, 3), accounts });
    expect(longView(plain.book, plain.ledger, NOW).sources).toEqual({ saved: 2000, revalued: 700, other: 0 });
  });

  it('does not count a revaluation twice when a book reports it as income', () => {
    const reported = bookOf({
      transactions: [row(2026, 4, 1, 700, { account_name: 'Fund', category: 'Transfer', subcategory: 'Valuation change' })],
      accounts
    });
    expect(longView(reported.book, reported.ledger, NOW).sources).toEqual({ saved: 700, revalued: 0, other: 0 });
  });

  it('says where it sits by kind, assets first, with changes that sum to the whole', () => {
    expect(data.held.map((entry) => [entry.kind, entry.balance, entry.change])).toEqual([
      ['asset', 50000, 700], ['bank', 10000, 2250], ['cash', 200, 0]
    ]);
    expect(data.held.reduce((sum, entry) => sum + entry.change, 0)).toBe(data.netWorth.change);
    expect(data.held.reduce((sum, entry) => sum + (entry.share as number), 0)).toBeCloseTo(1);
  });

  it('counts bank and cash as what can be spent, and not the fund', () => {
    expect(data.runway.liquid).toBe(10200);
  });

  it('gathers an account of a kind it does not know under its own row, so the rows still sum', () => {
    const odd = bookOf({
      transactions: [row(2026, 3, 1, 400, { account_name: 'Pension' })],
      accounts: [...accounts, { account_id: 'p', name: 'Pension', kind: 'Savings pot', currency: 'EUR', balance: 8000, include_in_net_worth: true, active: true }]
    });
    const answer = longView(odd.book, odd.ledger, NOW);
    expect(answer.held.map((entry) => [entry.kind, entry.balance, entry.change])).toEqual([
      ['asset', 50000, 0], ['bank', 10000, 0], ['cash', 200, 0], ['other', 8000, 400]
    ]);
    expect(answer.held.reduce((sum, entry) => sum + entry.balance, 0)).toBe(answer.netWorth.now);
    // Not spendable until it says what it is.
    expect(answer.runway.liquid).toBe(10200);
  });

  it('counts history from the first reported row, not from a revaluation dated before it', () => {
    const backdated = bookOf({
      transactions: [
        ...monthsEnding(2026, 9, 5),
        row(2019, 1, 1, 100, { account_name: 'Fund', ...moved, subcategory: 'Valuation change' })
      ],
      accounts
    });
    const answer = longView(backdated.book, backdated.ledger, NOW);
    expect(answer.history.months).toBe(5);
    expect(answer.years).toEqual([]);
    // The line is of net worth, and does start where its first row is.
    expect(answer.netWorth.series[0].key).toBe('2019-01-01');
  });

  it('draws the line from the first row through each month end to today', () => {
    const series = data.netWorth.series;
    expect(series[0]).toEqual({ key: '2025-06-01', value: 60200 - 2950 });
    expect(series[1].key).toBe('2025-06-30');
    expect(series[series.length - 2]).toEqual({ key: '2026-09-30', value: 60200 });
    expect(series[series.length - 1]).toEqual({ key: '2026-10-11', value: 60200 });
    expect(series.find((point) => point.key === '2026-03-31')!.value).toBe(59250);
  });
});
