/**
 * Recurring detection and the cashflow projection.
 *
 * The detector is pure and gets tested properly.
 *
 * The dashboard checks used to live here, because the dashboard shipped in
 * this phase. They moved to `analytics.test.mjs` when it was rebuilt — tests
 * belong with the code they cover, and there is now enough of that code to
 * need a file of its own.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

/** A transaction, with only the fields the detector reads. */
const tx = (date, over = {}) => Object.assign({
  description: 'NETFLIX.COM',
  counterparty: '',
  account_id: 'revolut',
  amount: -12.99,
  booking_date: date,
  type: 'expense',
  excluded: '',
  category: 'Entertainment',
  category_override: '',
  category_auto: ''
}, over);

const monthly = (count, day = 15, over = {}) => {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(tx(new Date(2026, i, day), over));
  return rows;
};

describe('deriveRecurring_', () => {
  it('needs three occurrences, because two always fit something', () => {
    // With two dates there is exactly one gap, so every pair matches some
    // cadence perfectly. Three is the first count at which the interval can
    // disagree with itself.
    expect(ctx.deriveRecurring_(monthly(2))).toHaveLength(0);
    expect(ctx.deriveRecurring_(monthly(3))).toHaveLength(1);
  });

  it('detects a monthly charge by day of month, not by day count', () => {
    // Jan 15 to Feb 15 is 31 days; Feb 15 to Mar 15 is 28. A fixed tolerance
    // wide enough to hold both also swallows the 4-weekly cycle.
    const found = ctx.deriveRecurring_(monthly(6))[0];
    expect(found.cadence_days).toBe(30);
    expect(found._label).toBe('monthly');
    expect(found.occurrences).toBe(6);
  });

  it('tolerates a few days of drift around the billing date', () => {
    const rows = [
      tx(new Date(2026, 0, 15)), tx(new Date(2026, 1, 17)),
      tx(new Date(2026, 2, 13)), tx(new Date(2026, 3, 16))
    ];
    expect(ctx.deriveRecurring_(rows)[0]._label).toBe('monthly');
  });

  it('treats a month-end charge as one rhythm, not three', () => {
    // 31st, 28th, 30th, 31st is a single monthly charge that the calendar
    // keeps moving. Folding to the 28th is what makes them agree.
    const rows = [
      tx(new Date(2026, 0, 31)), tx(new Date(2026, 1, 28)),
      tx(new Date(2026, 2, 31)), tx(new Date(2026, 3, 30))
    ];
    expect(ctx.deriveRecurring_(rows)[0]._label).toBe('monthly');
  });

  it('detects weekly, fortnightly and yearly', () => {
    const every = (days, count) => {
      const rows = [];
      for (let i = 0; i < count; i++) rows.push(tx(new Date(2026, 0, 5 + days * i)));
      return rows;
    };

    expect(ctx.deriveRecurring_(every(7, 6))[0]._label).toBe('weekly');
    expect(ctx.deriveRecurring_(every(14, 6))[0]._label).toBe('fortnightly');

    const yearly = [
      tx(new Date(2023, 5, 3)), tx(new Date(2024, 5, 1)), tx(new Date(2025, 5, 8))
    ];
    expect(ctx.deriveRecurring_(yearly)[0]._label).toBe('yearly');
  });

  it('lets a longer cycle wander further than a short one', () => {
    // Three days out of seven is a different week; three days out of a year is
    // a bank holiday. A flat tolerance either rejects every annual premium or
    // accepts anything weekly.
    expect(ctx.cadenceTolerance_(7)).toBe(3);
    expect(ctx.cadenceTolerance_(365)).toBeGreaterThan(30);
  });

  it('survives one missed payment, because the median shrugs it off', () => {
    // A subscription you paused for a month is still a subscription. A mean gap
    // would be dragged far enough by the double-length gap to match nothing.
    const rows = [
      tx(new Date(2026, 0, 5)), tx(new Date(2026, 0, 12)),
      tx(new Date(2026, 0, 26)),                              // one week skipped
      tx(new Date(2026, 1, 2)), tx(new Date(2026, 1, 9))
    ];
    const found = ctx.deriveRecurring_(rows)[0];
    expect(found._label).toBe('weekly');
    expect(found.confidence).toBeLessThan(1);
  });

  it('rejects a series with no rhythm at all', () => {
    const rows = [
      tx(new Date(2026, 0, 3)), tx(new Date(2026, 0, 9)), tx(new Date(2026, 2, 21))
    ];
    expect(ctx.deriveRecurring_(rows)).toHaveLength(0);
  });

  it('rejects a burst of charges in one week that happen to land near the 15th', () => {
    // Without the distinct-months check, twelve charges in one week would read
    // as a year of subscription.
    const rows = [
      tx(new Date(2026, 0, 14)), tx(new Date(2026, 0, 15)), tx(new Date(2026, 0, 16))
    ];
    expect(ctx.deriveRecurring_(rows)).toHaveLength(0);
  });

  it('never treats a transfer as recurring', () => {
    // Both legs are yours, so projecting it counts the same money leaving and
    // arriving — twice.
    expect(ctx.deriveRecurring_(monthly(6, 15, { type: 'transfer' }))).toHaveLength(0);
  });

  it('ignores rows you excluded', () => {
    expect(ctx.deriveRecurring_(monthly(6, 15, { excluded: true }))).toHaveLength(0);
  });

  it('keeps money in and money out apart', () => {
    // A merchant you both pay and are refunded by is two rhythms, and averaging
    // them gives a number that is neither.
    const out = monthly(4, 15);
    const back = monthly(4, 20, { amount: 12.99 });
    const found = ctx.deriveRecurring_(out.concat(back));

    expect(found).toHaveLength(2);
    expect(found.map((f) => f.avg_amount).sort()).toEqual([-12.99, 12.99]);
  });

  it('ignores a blank amount rather than reading it as zero', () => {
    // Number('') is 0 and isFinite(0) is true, so the obvious guard passes.
    expect(ctx.deriveRecurring_(monthly(6, 15, { amount: '' }))).toHaveLength(0);
  });

  it('projects the next date one cadence past the last one seen', () => {
    const found = ctx.deriveRecurring_(monthly(4))[0];
    expect(found.last_seen).toEqual(new Date(2026, 3, 15));
    expect(found.next_expected).toEqual(new Date(2026, 4, 15));
  });

  it('groups by merchant rather than by raw descriptor', () => {
    // The same reduction the cascade uses. Two functions answering "is this the
    // same merchant" differently would be a bug nobody could see.
    const rows = [
      tx(new Date(2026, 0, 15), { description: 'PAGAMENTO POS 15/01 CARTA *1234 NETFLIX' }),
      tx(new Date(2026, 1, 15), { description: 'PAGAMENTO POS 15/02 CARTA *1234 NETFLIX' }),
      tx(new Date(2026, 2, 15), { description: 'PAGAMENTO POS 15/03 CARTA *1234 NETFLIX' })
    ];
    expect(ctx.deriveRecurring_(rows)).toHaveLength(1);
  });
});

describe('projectCashflow_', () => {
  const item = (over = {}) => Object.assign({
    cadence_days: 30, avg_amount: -50,
    next_expected: new Date(2026, 4, 5), active: true
  }, over);

  const from = new Date(2026, 4, 1);

  it('produces one row per day of the horizon, starting tomorrow', () => {
    const days = ctx.projectCashflow_([item()], 1000, from, 90);
    expect(days).toHaveLength(90);
    expect(days[0].date).toEqual(new Date(2026, 4, 2));
  });

  it('carries the closing balance into the next opening', () => {
    const days = ctx.projectCashflow_([item()], 1000, from, 10);
    expect(days[0].opening).toBe(1000);
    expect(days[3].expected_out).toBe(50);
    expect(days[3].closing).toBe(950);
    expect(days[4].opening).toBe(950);
  });

  it('splits money in from money out', () => {
    const days = ctx.projectCashflow_(
      [item({ avg_amount: 2000, next_expected: new Date(2026, 4, 3) })], 0, from, 10);
    expect(days[1].expected_in).toBe(2000);
    expect(days[1].expected_out).toBe(0);
  });

  it('repeats a weekly item across the horizon and a yearly one at most once', () => {
    const weekly = ctx.projectCashflow_(
      [item({ cadence_days: 7, next_expected: new Date(2026, 4, 2) })], 0, from, 28);
    expect(weekly.filter((d) => d.expected_out > 0)).toHaveLength(4);

    const yearly = ctx.projectCashflow_(
      [item({ cadence_days: 365, next_expected: new Date(2026, 4, 2) })], 0, from, 90);
    expect(yearly.filter((d) => d.expected_out > 0)).toHaveLength(1);
  });

  it('rolls a stale next_expected forward instead of dumping it on day one', () => {
    // A detection run you forgot to re-run should not make tomorrow look
    // catastrophic.
    const stale = ctx.projectCashflow_(
      [item({ next_expected: new Date(2025, 0, 5) })], 1000, from, 40);

    expect(stale[0].expected_out).toBe(0);
    expect(stale.filter((d) => d.expected_out > 0).length).toBeGreaterThan(0);
  });

  it('ignores an item with no cadence rather than looping forever', () => {
    const days = ctx.projectCashflow_([item({ cadence_days: 0 })], 1000, from, 10);
    expect(days.every((d) => d.expected_out === 0)).toBe(true);
  });

  it('ignores an item with no next date', () => {
    const days = ctx.projectCashflow_([item({ next_expected: '' })], 1000, from, 10);
    expect(days.every((d) => d.expected_out === 0)).toBe(true);
  });

  it('names the day the money runs out, which is the only number worth reading', () => {
    const days = ctx.projectCashflow_(
      [item({ avg_amount: -600, cadence_days: 30, next_expected: new Date(2026, 4, 5) })],
      1000, from, 90);

    // 1000, less 600 on 5 May, less 600 on 4 June.
    expect(ctx.firstNegativeDay_(days)).toEqual(new Date(2026, 5, 4));
  });

  it('returns nothing to worry about when the projection stays positive', () => {
    const days = ctx.projectCashflow_([item()], 100000, from, 90);
    expect(ctx.firstNegativeDay_(days)).toBe(null);
  });
});

describe('the cashflow opening balance', () => {
  function accounts(rows) {
    const c = load();
    c.setup();
    const sheet = c.__spreadsheet.getSheetByName('accounts');
    const values = rows.map((row) => c.ACCOUNT_COLUMNS.map((n) => (n in row ? row[n] : '')));
    sheet.getRange(2, 1, values.length, c.ACCOUNT_COLUMNS.length).setValues(values);
    return { c, sheet };
  }

  it('counts bank and cash but not assets', () => {
    // A projection asks whether money runs out, and a flat you cannot sell by
    // Thursday does not stop that happening.
    const { c, sheet } = accounts([
      { account_id: 'a', kind: 'bank', balance: 1000, active: true },
      { account_id: 'b', kind: 'cash', balance: 50, active: true },
      { account_id: 'c', kind: 'asset', balance: 250000, active: true }
    ]);
    expect(c.liquidBalance_(sheet)).toBe(1050);
  });

  it('skips an account you switched off', () => {
    const { c, sheet } = accounts([
      { account_id: 'a', kind: 'bank', balance: 1000, active: true },
      { account_id: 'b', kind: 'bank', balance: 999, active: false }
    ]);
    expect(c.liquidBalance_(sheet)).toBe(1000);
  });

  it('treats a blank balance as unknown, not as zero', () => {
    const { c, sheet } = accounts([
      { account_id: 'a', kind: 'bank', balance: '', active: true },
      { account_id: 'b', kind: 'bank', balance: 40, active: true }
    ]);
    expect(c.liquidBalance_(sheet)).toBe(40);
  });
});

describe('writing the recurring tab', () => {
  it('keeps the active ticks you set, across a re-detect', () => {
    // `active` is how you say "yes this repeats, and no, do not forecast it".
    // Rebuilding without it would silently re-enable everything you turned off,
    // and you would find out months later in a projection that was always wrong.
    const c = load();
    c.setup();
    const sheet = c.__spreadsheet.getSheetByName('recurring');

    const plan = { sheet, items: c.deriveRecurring_(monthly(4)), existing: {} };
    c.writeRecurring_(plan);

    const key = c.readRecords_(sheet, c.RECURRING_COLUMNS, 1)[0].key;
    c.writeRecurring_({ sheet, items: plan.items, existing: { [key]: false } });

    expect(c.readRecords_(sheet, c.RECURRING_COLUMNS, 1)[0].active).toBe(false);
  });

  it('defaults a newly found item to active', () => {
    const c = load();
    c.setup();
    const sheet = c.__spreadsheet.getSheetByName('recurring');
    c.writeRecurring_({ sheet, items: c.deriveRecurring_(monthly(4)), existing: {} });

    expect(c.readRecords_(sheet, c.RECURRING_COLUMNS, 1)[0].active).toBe(true);
  });
});
