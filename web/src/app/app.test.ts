import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount } from './amount';
import { agoWords, dayHeading, fullDate, money, percent, rangeTitle, shortDate, withIcon } from './format';
import {
  barGeometry, columnGeometry, donutSlices, lineGeometry, linesGeometry, pixelsOf, spacedMarks, MARK_GAP_PIXELS
} from './geometry';
import { chosenAccounts, defaultView, parseView, periodFromId, periodId, periodUnit, stepPeriod, viewSearch } from './view';

describe('format', () => {
  it('groups thousands at four digits as well as five, so a column lines up', () => {
    const four = money(8920.4, 'EUR');
    const five = money(14500, 'EUR');
    const separator = /\d(\D)\d{3}\D/.exec(five)?.[1];
    expect(separator).toBeTruthy();
    expect(four).toContain('8' + separator + '920');
  });

  it('draws nothing as a dash, and survives a currency Intl has never heard of', () => {
    expect(money(null, 'EUR')).toBe('—');
    expect(money(12, 'NOT_A_CODE')).toBe('12.00 NOT_A_CODE');
    expect(money(12.4, 'NOT_A_CODE', { whole: true })).toBe('12 NOT_A_CODE');
  });

  it('shortens a day and a month without the year', () => {
    expect(shortDate('2026-08-06')).toBe('6 Aug');
    expect(shortDate('2026-08')).toBe('Aug 2026');
    expect(shortDate('')).toBe('');
  });

  it('keeps the year on a date that may be years back', () => {
    expect(fullDate('2024-08-06')).toBe('6 Aug 2024');
    expect(fullDate('')).toBe('');
  });

  it('signs a change, and leaves no change unsigned', () => {
    expect(money(700, 'EUR', { signed: true })).toMatch(/^\+/);
    expect(money(-700, 'EUR', { signed: true })).toMatch(/^[-−]/);
    expect(money(0, 'EUR', { signed: true })).not.toMatch(/^[+\-−]/);
    expect(money(700, 'EUR')).not.toMatch(/^\+/);
  });

  it('prints a share as a percentage, and nothing as a dash rather than 0%', () => {
    expect(percent(0.3086)).toMatch(/^31\s?%$/);
    expect(percent(-0.0833, { digits: 1, signed: true })).toMatch(/^[-−]8[.,]3\s?%$/);
    expect(percent(0.03, { digits: 1, signed: true })).toMatch(/^\+3[.,]0\s?%$/);
    expect(percent(null)).toBe('—');
  });

  it('rounds an age outward', () => {
    const now = 1_000_000_000_000;
    expect(agoWords(now - 60_000, now)).toBe('a moment ago');
    expect(agoWords(now - 10 * 60_000, now)).toBe('10 min ago');
    expect(agoWords(now - 60 * 60_000, now)).toBe('an hour ago');
    expect(agoWords(now - 30 * 60 * 60_000, now)).toBe('yesterday');
  });

  it("heads a day by the book's today, with a year only when it is not this one", () => {
    expect(dayHeading('2026-09-27', '2026-09-27')).toBe('Today');
    expect(dayHeading('2026-09-20', '2026-09-27')).toMatch(/^20 \S+$/);
    expect(dayHeading('2025-09-20', '2026-09-27')).toMatch(/^20 \S+ 2025$/);
  });

  it('puts no leading space before a name with no icon', () => {
    expect(withIcon('', 'Groceries')).toBe('Groceries');
    expect(withIcon('🛒', 'Groceries')).toBe('🛒 Groceries');
  });
});

describe('rangeTitle', () => {
  it('leaves the year off a range inside this one, and names it at both ends otherwise', () => {
    expect(rangeTitle('2026-09-01', '2026-10-11', 2026)).toBe('1 Sep – 11 Oct');
    expect(rangeTitle('2024-08-06', '2025-09-03', 2026)).toBe('6 Aug 2024 – 3 Sep 2025');
    expect(rangeTitle('2025-12-20', '2026-01-05', 2026)).toBe('20 Dec 2025 – 5 Jan 2026');
  });

  it('puts the earlier day first, as the window does', () => {
    expect(rangeTitle('2026-10-11', '2026-09-01', 2026)).toBe('1 Sep – 11 Oct');
  });
});

describe('geometry', () => {
  const label = (value: number) => String(Math.round(value));

  it('keeps marks in priority order and drops the one that would overprint', () => {
    const kept = spacedMarks([{ y: 30, label: 'zero' }, { y: 31, label: 'close' }, { y: 5, label: 'far' }]);
    expect(kept.map((m) => m.label)).toEqual(['zero', 'far']);
    expect(Math.abs(pixelsOf(30) - pixelsOf(31))).toBeLessThan(MARK_GAP_PIXELS);
  });

  it('centres a flat line and gives it one mark', () => {
    const flat = lineGeometry([{ key: 'a', value: 5 }, { key: 'b', value: 5 }], label);
    expect(flat.points).toBe('0.00,20.00 100.00,20.00');
    expect(flat.marks).toEqual([{ y: 20, label: '5' }]);
  });

  it('marks both ends of a line before its middle', () => {
    const line = lineGeometry([{ key: 'a', value: 0 }, { key: 'b', value: 100 }], label);
    expect(line.marks.map((m) => m.label)).toEqual(['100', '0', '50']);
  });

  it('puts the zero line where the data says, and marks it first', () => {
    const bars = barGeometry([{ key: 'a', income: 300, expenses: 100 }], label);
    expect(bars.marks[0].label).toBe('0');
    const income = bars.bars.find((bar) => bar.up)!;
    const spend = bars.bars.find((bar) => !bar.up)!;
    expect(income.y + income.height).toBeCloseTo(bars.zero);
    expect(spend.y).toBeCloseTo(bars.zero);
    // No income at all: no mark reading nothing above zero.
    expect(barGeometry([{ key: 'a', income: 0, expenses: 50 }], label).marks.map((m) => m.label)).toEqual(['0', '-50']);
  });

  it('puts several lines on one scale, so the gap between them is an amount', () => {
    const drawn = linesGeometry([
      [{ key: 'a', value: 100 }, { key: 'b', value: 200 }],
      [{ key: 'a', value: 0 }, { key: 'b', value: 100 }]
    ], label);
    // 100 is the top line's start and the bottom line's end: the same height on both.
    expect(drawn.lines).toEqual(['0.00,20.00 100.00,2.00', '0.00,38.00 100.00,20.00']);
    expect(drawn.marks.map((m) => m.label)).toEqual(['200', '0', '100']);
  });

  it('centres lines that never move and gives them one mark', () => {
    const flat = linesGeometry([[{ key: 'a', value: 7 }, { key: 'b', value: 7 }]], label);
    expect(flat.lines).toEqual(['0.00,20.00 100.00,20.00']);
    expect(flat.marks).toEqual([{ y: 20, label: '7' }]);
  });

  it('draws single-sign bars from zero, the tallest to the top', () => {
    const columns = columnGeometry([50, 100], label);
    expect(columns.marks.map((m) => m.label)).toEqual(['0', '100', '50']);
    const [half, full] = columns.bars;
    expect(full.y).toBeCloseTo(1);
    expect(full.y + full.height).toBeCloseTo(39);
    expect(half.height).toBeCloseTo(full.height / 2);
  });

  it('keeps the slot of a value that is missing, and draws nothing in it', () => {
    const columns = columnGeometry([10, null, 10], label);
    expect(columns.bars.map((bar) => bar.index)).toEqual([0, 2]);
    expect(columns.bars[1].x).toBeCloseTo((2 * 100) / 3 + (100 / 3) * 0.15);
    // Nothing at all: a zero mark, and no peak that would read as a scale.
    expect(columnGeometry([null, null], label)).toEqual({ bars: [], marks: [{ y: 39, label: '0' }] });
    expect(columnGeometry([], label).bars).toEqual([]);
  });

  it('slices a ring of at most five whose dashes sum to the circumference', () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ name: 'c' + i, total: 10 }));
    const slices = donutSlices(rows);
    expect(slices).toHaveLength(5);
    expect(slices[0].dash).toBe('20.00 80.00');
    expect(donutSlices([])).toEqual([]);
  });
});

describe('view', () => {
  it('writes nothing for the ordinary open', () => {
    expect(viewSearch(defaultView())).toBe('');
  });

  it('round-trips a Records view through its address', () => {
    const view = defaultView();
    view.screen = 'records';
    view.records = { ...view.records, period: { kind: 'month', year: 2026, month: 3 }, account: ['Revolut', 'Fineco'], label: 'travel', search: 'hotel', unconfirmedOnly: true };
    const search = viewSearch(view);
    expect(search).toBe('?v=records&p=month%3A2026-03&a=Revolut&a=Fineco&l=travel&q=hotel&u=1');
    const back = parseView(search, 2026);
    expect(back.screen).toBe('records');
    expect(back.records.period).toEqual({ kind: 'month', year: 2026, month: 3 });
    expect(back.records.account).toEqual(['Fineco', 'Revolut']);
    expect(back.records.search).toBe('hotel');
    expect(back.records.unconfirmedOnly).toBe(true);
  });

  it('keeps search and the review toggle off Charts, which has no control for either', () => {
    const view = parseView('?v=analytics&q=hotel&u=1&p=last_month', 2026);
    expect(view.analytics.period).toEqual({ kind: 'last_month' });
    expect(view.records.search).toBe('');
    expect(view.records.unconfirmedOnly).toBe(false);
  });

  it('refuses a period it cannot resolve rather than building a window from a NaN', () => {
    expect(periodFromId('month:2026-13', null, null, 2026)).toBeNull();
    expect(periodFromId('year:2999', null, null, 2026)).toBeNull();
    expect(periodFromId('custom', '2026-01-01', null, 2026)).toBeNull();
    expect(periodFromId('custom', '2026-01-01', '2026-02-01', 2026)).toEqual({ kind: 'custom', from: '2026-01-01', to: '2026-02-01' });
    expect(periodFromId('fortnight', null, null, 2026)).toBeNull();
    expect(parseView('?v=records&p=month:2026-13', 2026).records.period).toEqual({ kind: 'ytd' });
  });

  it('keeps the month and the year in the id', () => {
    expect(periodId({ kind: 'month', year: 2026, month: 3 })).toBe('month:2026-03');
    expect(periodId({ kind: 'year', year: 2024 })).toBe('year:2024');
  });

  // October 2026: `month` is zero-based, as the book's clock has it.
  const october = { year: 2026, month: 9 };

  it('reads a period as the one month or one year it covers, or neither', () => {
    expect(periodUnit({ kind: 'mtd' }, october)).toEqual({ unit: 'month', year: 2026, month: 10 });
    expect(periodUnit({ kind: 'last_month' }, october)).toEqual({ unit: 'month', year: 2026, month: 9 });
    expect(periodUnit({ kind: 'last_month' }, { year: 2026, month: 0 })).toEqual({ unit: 'month', year: 2025, month: 12 });
    expect(periodUnit({ kind: 'month', year: 2024, month: 2 }, october)).toEqual({ unit: 'month', year: 2024, month: 2 });
    expect(periodUnit({ kind: 'ytd' }, october)).toEqual({ unit: 'year', year: 2026 });
    expect(periodUnit({ kind: 'year', year: 2024 }, october)).toEqual({ unit: 'year', year: 2024 });
    for (const kind of ['week', 'last_12', 'custom']) expect(periodUnit({ kind }, october)).toBeNull();
  });

  // The book's first row is in March 2024.
  const first = { year: 2024, month: 3 };

  it('steps a month at a time, across the turn of a year', () => {
    expect(stepPeriod({ kind: 'mtd' }, -1, october, first)).toEqual({ kind: 'month', year: 2026, month: 9 });
    expect(stepPeriod({ kind: 'last_month' }, -1, october, first)).toEqual({ kind: 'month', year: 2026, month: 8 });
    expect(stepPeriod({ kind: 'month', year: 2026, month: 1 }, -1, october, first)).toEqual({ kind: 'month', year: 2025, month: 12 });
    expect(stepPeriod({ kind: 'month', year: 2025, month: 12 }, 1, october, first)).toEqual({ kind: 'month', year: 2026, month: 1 });
  });

  it('steps a year at a time', () => {
    expect(stepPeriod({ kind: 'ytd' }, -1, october, first)).toEqual({ kind: 'year', year: 2025 });
    expect(stepPeriod({ kind: 'year', year: 2024 }, 1, october, first)).toEqual({ kind: 'year', year: 2025 });
  });

  it('arrives at the present as the default, so stepping away and back is the bare address', () => {
    expect(stepPeriod({ kind: 'month', year: 2026, month: 9 }, 1, october, first)).toEqual({ kind: 'mtd' });
    expect(stepPeriod({ kind: 'year', year: 2025 }, 1, october, first)).toEqual({ kind: 'ytd' });
    const view = defaultView();
    view.screen = 'analytics';
    view.analytics.period = stepPeriod(stepPeriod(view.analytics.period, -1, october, first)!, 1, october, first)!;
    expect(viewSearch(view)).toBe('?v=analytics');
  });

  it('has no step into a month or a year that has not started, nor from a period with no unit', () => {
    expect(stepPeriod({ kind: 'mtd' }, 1, october, first)).toBeNull();
    expect(stepPeriod({ kind: 'ytd' }, 1, october, first)).toBeNull();
    expect(stepPeriod({ kind: 'last_12' }, -1, october, first)).toBeNull();
  });

  it('has no step back past the book\'s first row, and none at all behind the present for a book with no rows', () => {
    expect(stepPeriod({ kind: 'month', year: 2024, month: 4 }, -1, october, first)).toEqual({ kind: 'month', year: 2024, month: 3 });
    expect(stepPeriod({ kind: 'month', year: 2024, month: 3 }, -1, october, first)).toBeNull();
    expect(stepPeriod({ kind: 'year', year: 2024 }, -1, october, first)).toBeNull();
    expect(stepPeriod({ kind: 'mtd' }, -1, october, null)).toBeNull();
    expect(stepPeriod({ kind: 'ytd' }, -1, october, null)).toBeNull();
  });

  it('steps back in from a month outside both ends, which a bookmark can name', () => {
    expect(stepPeriod({ kind: 'month', year: 2027, month: 3 }, -1, october, first)).toEqual({ kind: 'month', year: 2027, month: 2 });
    expect(stepPeriod({ kind: 'month', year: 2027, month: 3 }, 1, october, first)).toBeNull();
    expect(stepPeriod({ kind: 'month', year: 1989, month: 5 }, 1, october, first)).toEqual({ kind: 'month', year: 1989, month: 6 });
    expect(stepPeriod({ kind: 'month', year: 1989, month: 5 }, -1, october, first)).toBeNull();
  });

  it('gives every step an id the address can read back', () => {
    const stepped = stepPeriod({ kind: 'mtd' }, -1, october, first)!;
    expect(periodFromId(periodId(stepped), null, null, 2026)).toEqual(stepped);
  });

  it('reads All and an empty list as the same answer', () => {
    expect(chosenAccounts('All')).toEqual([]);
    expect(chosenAccounts('Revolut')).toEqual(['Revolut']);
    expect(chosenAccounts(['A', 'B'])).toEqual(['A', 'B']);
  });

  it('writes the long view as its mode alone, and reads it back', () => {
    const view = defaultView();
    view.screen = 'analytics';
    expect(viewSearch(view)).toBe('?v=analytics');
    view.charts = 'long';
    // No period: the long view reads none, so its address claims none.
    view.analytics = { ...view.analytics, period: { kind: 'last_month' } };
    expect(viewSearch(view)).toBe('?v=analytics&m=long');
    expect(parseView('?v=analytics&m=long', 2026).charts).toBe('long');
    expect(parseView('?v=analytics', 2026).charts).toBe('period');
  });

  it('reads a mode only on Charts, and only the one it knows', () => {
    expect(parseView('?v=records&m=long', 2026).charts).toBe('period');
    expect(parseView('?m=long', 2026).charts).toBe('period');
    expect(parseView('?v=analytics&m=forever', 2026).charts).toBe('period');
    const records = parseView('?v=records&m=long', 2026);
    expect(viewSearch(records)).toBe('?v=records');
  });

  it('ignores a screen it does not know', () => {
    expect(parseView('?v=settings', 2026).screen).toBe('dashboard');
  });

  it('addresses the two forms by screen alone', () => {
    expect(parseView('?v=add', 2026).screen).toBe('add');
    const view = defaultView();
    view.screen = 'value';
    expect(viewSearch(view)).toBe('?v=value');
  });
});

describe('amount', () => {
  const itIT = { group: '.', decimal: ',' };
  const enUS = { group: ',', decimal: '.' };

  it('reads the last separator as the point when one or two digits follow it', () => {
    expect(parseAmount('3,50', itIT)).toBe(3.5);
    expect(parseAmount('3.5', itIT)).toBe(3.5);
    expect(parseAmount('1.250', itIT)).toBe(1250);
    expect(parseAmount('1.250,75', itIT)).toBe(1250.75);
    expect(parseAmount('1,250', enUS)).toBe(1250);
    expect(parseAmount('-12', enUS)).toBe(-12);
  });

  it('reads nothing as NaN, never as zero', () => {
    expect(parseAmount('', itIT)).toBeNaN();
    expect(parseAmount('abc', itIT)).toBeNaN();
  });

  it('groups at four digits and keeps two decimals', () => {
    expect(formatAmount(8920.4, itIT)).toBe('8.920,40');
    expect(formatAmount(3.5, enUS)).toBe('3.50');
    expect(formatAmount(null, enUS)).toBe('');
  });
});
