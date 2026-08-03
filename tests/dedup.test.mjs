/**
 * Identity.
 *
 * Sync fetches an overlapping window every night, so almost everything it
 * returns is already in the sheet and dedup runs on nearly every row. The
 * asymmetry that shapes these tests: a duplicate is visible and annoying,
 * whereas a transaction silently swallowed leaves a sheet that looks
 * completely fine and is quietly wrong. So the cases that matter most are the
 * ones where two different transactions could collide.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

function record(over) {
  return Object.assign({
    account_id: 'acc-1',
    booking_date: new Date(2026, 6, 28),
    amount: -3,
    description: 'BAR ROMA',
    entry_reference: ''
  }, over || {});
}

describe('sha256Hex', () => {
  it('is a hash, not a string with minus signs in it', () => {
    // computeDigest returns signed bytes: without the mask, any byte over
    // 127 renders as something like "-4d".
    const hash = ctx.sha256Hex('spendsheet');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('agrees with the reference value for the empty string', () => {
    expect(ctx.sha256Hex(''))
      .toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('normalizeDescription', () => {
  it('survives a bank changing its spacing and punctuation', () => {
    expect(ctx.normalizeDescription('PAGAMENTO POS  12/03  CARTA *1234 ESSELUNGA'))
      .toBe(ctx.normalizeDescription('PAGAMENTO-POS 12 03 CARTA 1234 ESSELUNGA'));
  });

  it('is case-insensitive and tolerates nothing at all', () => {
    expect(ctx.normalizeDescription('Bar Roma')).toBe('BAR ROMA');
    expect(ctx.normalizeDescription(null)).toBe('');
    expect(ctx.normalizeDescription(undefined)).toBe('');
  });
});

describe('dateKey and amountKey', () => {
  it('reads a Date and an ISO string as the same day', () => {
    expect(ctx.dateKey(new Date(2026, 6, 28))).toBe('2026-07-28');
    expect(ctx.dateKey('2026-07-28T00:00:00Z')).toBe('2026-07-28');
    expect(ctx.dateKey('')).toBe('');
  });

  it('reads 3, 3.00 and "3.0" as one amount', () => {
    expect(ctx.amountKey(3)).toBe('3.00');
    expect(ctx.amountKey('3.0')).toBe('3.00');
    expect(ctx.amountKey(3.004)).toBe('3.00');
    expect(ctx.amountKey('x')).toBe('');
  });

  it('does not read an emptied cell as a confident zero', () => {
    // Number('') is 0, so a blank would otherwise compare equal to a genuine
    // zero-euro row — and a cleared amount is missing data, not a value.
    expect(ctx.amountKey('')).toBe('');
    expect(ctx.amountKey(null)).toBe('');
    expect(ctx.amountKey(0)).toBe('0.00');
  });
});

describe('computeUid', () => {
  it('uses entry_reference with the account, never on its own', () => {
    // entry_reference is immutable per account but not globally unique, and
    // some providers reuse it outright.
    const a = ctx.computeUid(record({ entry_reference: 'REF1' }), 0);
    const b = ctx.computeUid(record({ account_id: 'acc-2', entry_reference: 'REF1' }), 0);
    expect(a).not.toBe(b);
  });

  it('ignores the ordinal when there is a strong key', () => {
    expect(ctx.computeUid(record({ entry_reference: 'REF1' }), 0))
      .toBe(ctx.computeUid(record({ entry_reference: 'REF1' }), 7));
  });

  it('is stable across a re-fetch of the same transaction', () => {
    expect(ctx.computeUid(record(), 0)).toBe(ctx.computeUid(record(), 0));
    expect(ctx.computeUid(record({ booking_date: '2026-07-28' }), 0))
      .toBe(ctx.computeUid(record({ booking_date: new Date(2026, 6, 28) }), 0));
  });

  it('separates transactions that differ in any fact it uses', () => {
    const base = ctx.computeUid(record(), 0);
    expect(ctx.computeUid(record({ amount: -3.01 }), 0)).not.toBe(base);
    expect(ctx.computeUid(record({ booking_date: new Date(2026, 6, 29) }), 0)).not.toBe(base);
    expect(ctx.computeUid(record({ description: 'BAR MILANO' }), 0)).not.toBe(base);
    expect(ctx.computeUid(record({ account_id: 'acc-2' }), 0)).not.toBe(base);
    expect(ctx.computeUid(record(), 1)).not.toBe(base);
  });
});

describe('assignUids', () => {
  it('keeps two identical coffees apart', () => {
    // Two genuine €3 coffees at the same bar on the same day are identical
    // in every field a bank reports. Without the ordinal they hash the same
    // and one of them silently never existed.
    const [first, second] = ctx.assignUids([record(), record()]);
    expect(first.uid).not.toBe(second.uid);
  });

  it('gives the same batch the same uids on the next sync', () => {
    const today = ctx.assignUids([record(), record(), record({ amount: -5 })]);
    const tomorrow = ctx.assignUids([record(), record(), record({ amount: -5 })]);
    expect(tomorrow.map((r) => r.uid)).toEqual(today.map((r) => r.uid));
  });

  it('counts ordinals per group, not across the batch', () => {
    const rows = ctx.assignUids([record(), record({ amount: -5 }), record()]);
    // The third row is the second of *its* group, so it must match what a
    // batch of just those two would produce.
    const pair = ctx.assignUids([record(), record()]);
    expect(rows[2].uid).toBe(pair[1].uid);
  });

  it('does not need an ordinal when the bank supplies a reference', () => {
    const rows = ctx.assignUids([
      record({ entry_reference: 'A' }),
      record({ entry_reference: 'B' })
    ]);
    expect(rows[0].uid).toBe(ctx.computeUid(record({ entry_reference: 'A' }), 0));
    expect(rows[1].uid).not.toBe(rows[0].uid);
  });
});

describe('partitionByUid', () => {
  const held = {};
  const rows = ctx.assignUids([record({ entry_reference: 'A' }), record({ entry_reference: 'B' })]);
  held[rows[0].uid] = { amount: rows[0].amount, booking_date: rows[0].booking_date };

  it('inserts what is new and drops what is already held', () => {
    const result = ctx.partitionByUid(rows, held);
    expect(result.fresh.map((r) => r.entry_reference)).toEqual(['B']);
    expect(result.duplicates.map((r) => r.entry_reference)).toEqual(['A']);
    expect(result.conflicts).toHaveLength(0);
  });

  it('flags a reference that came back describing something else', () => {
    // Same account and entry_reference, different amount: a provider bug,
    // not a duplicate. It must not overwrite history, which is append-only.
    const changed = ctx.assignUids([record({ entry_reference: 'A', amount: -30 })]);
    const result = ctx.partitionByUid(changed, held);

    expect(result.fresh).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
    expect(result.conflicts).toHaveLength(1);
    expect(ctx.amountKey(result.conflicts[0].previous.amount)).toBe('-3.00');
  });

  it('catches a provider repeating a reference within one response', () => {
    const twice = [
      record({ entry_reference: 'C' }),
      record({ entry_reference: 'C', amount: -99 })
    ].map((r) => Object.assign(r, { uid: ctx.computeUid(r, 0) }));

    const result = ctx.partitionByUid(twice, {});
    expect(result.fresh).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
  });

  it('handles an empty batch and an empty sheet', () => {
    expect(ctx.partitionByUid([], {})).toEqual({ fresh: [], duplicates: [], conflicts: [] });
    expect(ctx.partitionByUid(null, {}).fresh).toEqual([]);
  });
});

/**
 * The duplicate a uid cannot see.
 *
 * An imported row's key is `csv:budgetbakers:import1#4332` and a fetched one's
 * is a hash — nothing about either can tell you they are the same transaction.
 * The staging cutoff was supposed to make that impossible; it only looks at
 * the API rows that exist when you import, so importing before an account's
 * first sync stages everything and the next run writes a second copy of the
 * overlap. That is what these cover.
 */
describe('crossSourceKey', () => {
  it('ignores the description, which is the field that differs by source', () => {
    const bank = record({ description: 'PAGAMENTO POS 12/07 ESSELUNGA SPA TORINO' });
    const csv = record({ description: 'Esselunga' });

    expect(ctx.crossSourceKey(bank)).toBe(ctx.crossSourceKey(csv));
  });

  it('reads 3, 3.00 and "3.0" as one amount, and a Date as its day', () => {
    expect(ctx.crossSourceKey(record({ amount: -3 })))
      .toBe(ctx.crossSourceKey(record({ amount: '-3.00' })));
    expect(ctx.crossSourceKey(record({ booking_date: new Date(2026, 6, 28, 23, 30) })))
      .toBe(ctx.crossSourceKey(record({ booking_date: '2026-07-28' })));
  });

  it('separates the same amount on the same day in two accounts', () => {
    expect(ctx.crossSourceKey(record({ account_id: 'acc-2' })))
      .not.toBe(ctx.crossSourceKey(record()));
  });
});

describe('partitionByImport', () => {
  it('drops a fetched row the import already covers', () => {
    const counts = ctx.indexImportedRows([record()]);
    const result = ctx.partitionByImport([record()], counts);

    expect(result.fresh).toHaveLength(0);
    expect(result.shadowed).toHaveLength(1);
  });

  it('lets the third coffee through when only two were imported', () => {
    // The whole reason the index counts rather than flags. Two genuine €3
    // coffees at the same bar on one day are identical in every field, so a
    // boolean "we have one of these" would swallow every later one forever.
    const counts = ctx.indexImportedRows([record(), record()]);
    const result = ctx.partitionByImport([record(), record(), record()], counts);

    expect(result.shadowed).toHaveLength(2);
    expect(result.fresh).toHaveLength(1);
  });

  it('leaves a genuinely new transaction alone', () => {
    const counts = ctx.indexImportedRows([record({ booking_date: new Date(2026, 6, 20) })]);
    const result = ctx.partitionByImport([record()], counts);

    expect(result.fresh).toHaveLength(1);
    expect(result.shadowed).toHaveLength(0);
  });

  it('consumes the index, so one imported row cannot cover two accounts of runs', () => {
    const counts = ctx.indexImportedRows([record()]);

    expect(ctx.partitionByImport([record()], counts).shadowed).toHaveLength(1);
    expect(ctx.partitionByImport([record()], counts).shadowed).toHaveLength(0);
  });

  it('never matches two rows on the strength of what is missing from both', () => {
    // amountKey and dateKey both return '' for a blank, so without the guard
    // two unreadable rows key alike and one is swallowed on no evidence at all.
    ['amount', 'booking_date', 'account_id'].forEach((field) => {
      const blank = record({ [field]: '' });
      expect(ctx.crossSourceKey(blank)).toBe('');

      const counts = ctx.indexImportedRows([blank]);
      expect(ctx.partitionByImport([blank], counts).fresh).toHaveLength(1);
    });
  });

  it('handles an empty batch and no import at all', () => {
    expect(ctx.partitionByImport([], {})).toEqual({ fresh: [], shadowed: [] });
    expect(ctx.partitionByImport(null, {}).fresh).toEqual([]);
    expect(ctx.partitionByImport([record()], {}).fresh).toHaveLength(1);
  });
});
