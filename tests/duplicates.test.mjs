/**
 * One transaction, two rows, two sources.
 *
 * The cutoff in `_import_staged` only looks backwards. Import a bank's history
 * before its first sync and every row stages legitimately, because at that
 * moment there is nothing older to compare against — and then the next run
 * writes a second copy of everything the two overlap on. 09_sync stops that
 * happening now, *when the two rows agree on the day*. The pairs a day apart it
 * cannot see at all, and those are what `pairNear_` is for.
 *
 * The first block below is the one that matters most, and it is first for that
 * reason: every pair has one imported side and one synced side, and relaxing
 * the date would be indefensible without it.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

function txRow(c, over = {}) {
  c.appendRows_(c.__spreadsheet.getSheetByName('transactions'), 1,
    [c.toRow_(c.TX_COLUMNS_CODE, {
      account_id: 'revolut',
      account_name: 'Revolut',
      booking_date: new Date(2026, 6, 17),
      amount: -11.42,
      currency: 'EUR',
      ...over
    })]);
}

function imported(c, over = {}) {
  txRow(c, {
    uid: 'csv:budgetbakers:import1#4332',
    description: 'ALLIANZ GLOBAL LIFE',
    source: 'csv:budgetbakers',
    ...over
  });
}

function synced(c, over = {}) {
  txRow(c, {
    uid: 'a1b2c3',
    description: 'ALLIANZ GLOBAL LIFE DESIGNATED ACTIVITY Addebito SDD',
    entry_reference: 'MjAyNjA3MTdf',
    source: 'enablebanking',
    ...over
  });
}

const rowsIn = (c) =>
  c.readColumn_(c.__spreadsheet.getSheetByName('transactions'), 1).filter(Boolean);

/** A record as `readRecords_` hands it over, without needing a sheet. */
function record(over = {}) {
  return {
    account_id: 'revolut',
    account_name: 'Revolut',
    booking_date: new Date(2026, 5, 16),
    amount: 24.08,
    description: 'Refund from Amzn Mktp It',
    source: 'csv:budgetbakers',
    _row: 2,
    ...over
  };
}

/**
 * The constraint the widened window rests on.
 *
 * 08_dedup rejects a date tolerance because it "would make every recurring €50
 * withdrawal a candidate for every other one" — right, about a window applied
 * to one source's own history. These say that case cannot arise: a pair always
 * has one `csv:` side and one `enablebanking` side, so two rows from the same
 * source are never offered to each other however close their dates are.
 */
describe('pairing only ever crosses the two sources', () => {
  const c = load();

  it('never pairs two imported rows a day apart', () => {
    const a = record({ _row: 2 });
    const b = record({ _row: 3, booking_date: new Date(2026, 5, 17) });

    expect(c.pairAcrossSources_([a, b], [], 3).near).toEqual([]);
    expect(c.pairAcrossSources_([a, b], [], 3).exact).toEqual([]);
  });

  it('never pairs two synced rows a day apart', () => {
    const a = record({ source: 'enablebanking', _row: 2 });
    const b = record({ source: 'enablebanking', _row: 3, booking_date: new Date(2026, 5, 17) });

    expect(c.pairAcrossSources_([], [a, b], 3).near).toEqual([]);
  });

  it('pairs two €120 withdrawals on consecutive days only across sources', () => {
    // The concrete case 08_dedup names. Both synced: never a pair. One of each:
    // a pair, because an import and a bank describing the same withdrawal is
    // exactly what this exists to find.
    const monday = { amount: -120, description: 'PRELIEVO ATM' };
    const tuesday = { amount: -120, description: 'PRELIEVO ATM', booking_date: new Date(2026, 5, 17) };

    const bothSynced = c.pairAcrossSources_([],
      [record({ ...monday, source: 'enablebanking' }), record({ ...tuesday, source: 'enablebanking' })], 3);
    expect(bothSynced.near).toEqual([]);

    const oneEach = c.pairAcrossSources_(
      [record(monday)], [record({ ...tuesday, source: 'enablebanking' })], 3);
    expect(oneEach.near).toHaveLength(1);
    expect(oneEach.near[0].gap).toBe(1);
  });

  it('pairs nothing with a manual row or a leg this project wrote', () => {
    // Neither is `csv:` and neither is exactly `enablebanking`, so neither
    // reaches either side of a pair. `planSyncedDuplicates_` filters them out
    // before they get here; this is the second half of that promise.
    const c2 = load();
    c2.setup();
    imported(c2);
    txRow(c2, { uid: 'cash-1', source: 'manual' });
    txRow(c2, { uid: 'leg-1', source: 'transfer-leg' });

    expect(c2.removeSyncedDuplicates().error).toMatch(/No imported row pairs/);
    expect(rowsIn(c2)).toHaveLength(3);
  });
});

describe('the exact pass', () => {
  const c = load();

  it('agrees with partitionByImport on which rows are shadowed', () => {
    // The cleanup and the nightly suppression have to be one rule — a cleanup
    // that disagreed would undo what tonight's sync is about to do. Written as
    // a queue here only because the pairing now has to be named, not counted.
    const importedRows = [record({ _row: 2 }), record({ _row: 3 })];
    const fetchedRows = [
      record({ source: 'enablebanking', _row: 4 }),
      record({ source: 'enablebanking', _row: 5 }),
      record({ source: 'enablebanking', _row: 6 })
    ];

    const pairs = c.pairExact_(importedRows, fetchedRows).pairs;
    const shadowed = c.partitionByImport(fetchedRows, c.indexImportedRows(importedRows)).shadowed;

    expect(pairs.map((pair) => pair.synced._row)).toEqual(shadowed.map((row) => row._row));
    expect(pairs).toHaveLength(2);
  });

  it('leaves what it did not pair for the near pass to see', () => {
    const result = c.pairExact_(
      [record({ _row: 2 })],
      [record({ source: 'enablebanking', _row: 3 }),
        record({ source: 'enablebanking', _row: 4, booking_date: new Date(2026, 5, 17) })]);

    expect(result.pairs).toHaveLength(1);
    expect(result.fetchedLeft.map((row) => row._row)).toEqual([4]);
    expect(result.importedLeft).toEqual([]);
  });
});

describe('the near pass', () => {
  const c = load();

  const near = (gap, windowDays = 3) => c.pairNear_(
    [record({ _row: 2 })],
    [record({
      source: 'enablebanking',
      _row: 3,
      booking_date: new Date(2026, 5, 16 + gap)
    })],
    windowDays);

  it('pairs inside the window and stops at its edge', () => {
    expect(near(0)).toHaveLength(1);
    expect(near(1)).toHaveLength(1);
    expect(near(3)).toHaveLength(1);
    expect(near(4)).toHaveLength(0);
  });

  it('pairs nothing when the window is zero', () => {
    // A book that set `duplicate_window_days` to 0 has asked for the old
    // behaviour, and must get it rather than a window of one.
    expect(near(1, 0)).toHaveLength(0);
  });

  it('breaks a tie on how well the descriptions agree', () => {
    // Two candidates the same distance away: the one whose description the
    // bank's contains is the one meant. Never a requirement — an export says
    // `Esselunga` where the bank says `PAGAMENTO POS 12/07 ESSELUNGA SPA`.
    const pairs = c.pairNear_(
      [record({ _row: 2, description: 'Unrelated' }),
        record({ _row: 3, description: 'Esselunga' })],
      [record({
        source: 'enablebanking',
        _row: 4,
        booking_date: new Date(2026, 5, 17),
        description: 'PAGAMENTO POS 12/07 ESSELUNGA SPA TORINO'
      })],
      3);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].imported._row).toBe(3);
  });

  it('prefers the nearer date over the better description', () => {
    const pairs = c.pairNear_(
      [record({ _row: 2, booking_date: new Date(2026, 5, 13), description: 'Esselunga' }),
        record({ _row: 3, booking_date: new Date(2026, 5, 15), description: 'Unrelated' })],
      [record({
        source: 'enablebanking',
        _row: 4,
        booking_date: new Date(2026, 5, 16),
        description: 'PAGAMENTO POS ESSELUNGA SPA'
      })],
      3);

    expect(pairs[0].imported._row).toBe(3);
  });

  it('pairs each row at most once', () => {
    // Three fetched €4 fares meeting two imported ones must leave one.
    const pairs = c.pairNear_(
      [record({ _row: 2 }), record({ _row: 3 })],
      [record({ source: 'enablebanking', _row: 4, booking_date: new Date(2026, 5, 17) }),
        record({ source: 'enablebanking', _row: 5, booking_date: new Date(2026, 5, 17) }),
        record({ source: 'enablebanking', _row: 6, booking_date: new Date(2026, 5, 17) })],
      3);

    expect(pairs).toHaveLength(2);
    expect(pairs.map((pair) => pair.imported._row)).toEqual([2, 3]);
  });

  it('pairs nothing when the account or the amount is missing', () => {
    // Same guard as `crossSourceKey`, and the same reason: a row with no
    // readable amount would otherwise match every other unreadable row.
    expect(c.pairNear_([record({ account_id: '' })],
      [record({ source: 'enablebanking', account_id: '' })], 3)).toEqual([]);
    expect(c.pairNear_([record({ amount: '' })],
      [record({ source: 'enablebanking', amount: '' })], 3)).toEqual([]);
  });

  it('does not pair a different amount, however close the dates', () => {
    expect(c.pairNear_([record()],
      [record({ source: 'enablebanking', amount: 24.09 })], 3)).toEqual([]);
  });

  it('does not pair across accounts', () => {
    expect(c.pairNear_([record()],
      [record({ source: 'enablebanking', account_id: 'fineco' })], 3)).toEqual([]);
  });
});

/**
 * The Amazon refund that started this.
 *
 * BudgetBakers recorded it on the day it appeared and the bank booked it the
 * next morning. Same account, same €24.08, the same description verbatim — and
 * one day between them, which was enough for both the sync suppression and this
 * tool to see nothing at all.
 */
describe('removing duplicates of imported rows', () => {
  it('finds the pair that is one day apart', () => {
    const c = load();
    c.setup();
    imported(c, {
      uid: 'csv:budgetbakers:import1#4201',
      booking_date: new Date(2026, 5, 16),
      amount: 24.08,
      description: 'Refund from Amzn Mktp It'
    });
    synced(c, {
      uid: '5df1fab2',
      booking_date: new Date(2026, 5, 17),
      amount: 24.08,
      description: 'Refund from Amzn Mktp It'
    });

    const plan = c.planSyncedDuplicates_();

    expect(plan.exact).toHaveLength(0);
    expect(plan.near).toHaveLength(1);
    expect(plan.near[0].gap).toBe(1);
  });

  it('removes the imported row and keeps the one the bank will send again', () => {
    // The old rule was the other way round, and it was not wrong about what
    // the imported row carries — only about that being enough. A synced row
    // deleted inside the sync window is fetched again by morning.
    const c = load();
    c.setup();
    synced(c);
    imported(c);

    const result = c.removeSyncedDuplicates();

    expect(result.removed).toBe(1);
    expect(rowsIn(c)).toEqual(['a1b2c3']);
  });

  it('carries the imported row’s category and labels onto the survivor', () => {
    const c = load();
    c.setup();
    synced(c);
    imported(c);

    // Row 2 is the synced row and row 3 is the imported one — the opinions
    // being carried over are on the row that is about to go.
    const tx = c.__spreadsheet.getSheetByName('transactions');
    c.writeCell_(tx, 3, c.TX_COLUMNS, 'category_override', 'Insurance');
    c.writeCell_(tx, 3, c.TX_COLUMNS, 'labels', 'household');

    const result = c.removeSyncedDuplicates();

    expect(result.merged).toBe(2);
    expect(c.readCell_(tx, 2, c.TX_COLUMNS, 'category_override')).toBe('Insurance');
    expect(c.readCell_(tx, 2, c.TX_COLUMNS, 'labels')).toBe('household');
    expect(c.readCell_(tx, 2, c.TX_COLUMNS, 'uid')).toBe('a1b2c3');
  });

  it('never overwrites something the survivor already says', () => {
    // The imported row is older information about the same money, and older
    // information does not get to win.
    const c = load();
    c.setup();
    synced(c);
    imported(c);

    const tx = c.__spreadsheet.getSheetByName('transactions');
    c.writeCell_(tx, 2, c.TX_COLUMNS, 'category_override', 'Insurance');
    c.writeCell_(tx, 3, c.TX_COLUMNS, 'category_override', 'Housing');

    c.removeSyncedDuplicates();

    expect(c.readCell_(tx, 2, c.TX_COLUMNS, 'category_override')).toBe('Insurance');
  });

  it('leaves a synced row the import never covered', () => {
    const c = load();
    c.setup();
    synced(c);
    imported(c);
    synced(c, { uid: 'd4e5f6', booking_date: new Date(2026, 6, 30) });

    c.removeSyncedDuplicates();

    expect(rowsIn(c)).toEqual(['a1b2c3', 'd4e5f6']);
  });

  it('removes one imported row per synced copy and no more', () => {
    const c = load();
    c.setup();
    synced(c);
    imported(c);
    imported(c, { uid: 'csv:budgetbakers:import1#4333' });

    expect(c.removeSyncedDuplicates().removed).toBe(1);
    expect(rowsIn(c)).toEqual(['a1b2c3', 'csv:budgetbakers:import1#4333']);
  });

  it('copies every row to _removed before deleting it', () => {
    // The only place in the project that deletes a row of history, and version
    // history on a free account is 30 days or 100 revisions — a daily sync
    // burns 100 in about three months.
    const c = load();
    c.setup();
    synced(c);
    imported(c);

    const result = c.removeSyncedDuplicates();
    const removed = c.__spreadsheet.getSheetByName('_removed');

    expect(result.kept).toBe(1);
    expect(removed.getRange('A2').getValue()).toBe('csv:budgetbakers:import1#4332');
    expect(removed.headers()).toEqual(c.TX_COLUMNS);
  });

  it('needs no Drive scope, so a book that never snapshotted still works', () => {
    // Backing up to Drive here meant the delete died on exactly the books
    // most likely to need it — and the Drive write was refused for want of a
    // scope on every book, for months, which nothing in the suite could see.
    // The undo for a destructive operation does not leave the spreadsheet.
    const c = load({ refuseDriveFolders: true });
    c.setup();
    synced(c);
    imported(c);

    expect(c.removeSyncedDuplicates().removed).toBe(1);
    expect(c.__driveFiles).toHaveLength(0);
  });

  it('appends on a second run rather than overwriting the first evidence', () => {
    const c = load();
    c.setup();
    synced(c);
    imported(c);
    c.removeSyncedDuplicates();

    imported(c, { uid: 'csv:budgetbakers:import1#4400' });
    synced(c, { uid: 'later-sync' });
    c.removeSyncedDuplicates();

    expect(c.readColumn_(c.__spreadsheet.getSheetByName('_removed'), 1).filter(Boolean))
      .toEqual(['csv:budgetbakers:import1#4332', 'csv:budgetbakers:import1#4400']);
  });

  it('re-baselines the row-loss detector, which would otherwise block every sync', () => {
    const c = load();
    c.setup();
    synced(c);
    imported(c);
    c.rememberRowCount_();

    c.removeSyncedDuplicates();

    expect(() => c.assertNoRowLoss_()).not.toThrow();
  });

  it('removes nothing at all when the answer is no', () => {
    const c = load({ alertResponse: 'NO' });
    c.setup();
    synced(c);
    imported(c);

    c.removeSyncedDuplicates();
    expect(rowsIn(c)).toHaveLength(2);
  });

  it('refuses to take row 2, where every ARRAYFORMULA is anchored', () => {
    // Deleting it does not move the formula, it destroys it — the tab loses
    // amount_base and every category column at once.
    const c = load();
    c.setup();
    imported(c);
    synced(c);

    expect(c.planSyncedDuplicates_().protectsAnchor).toBe(true);
    expect(() => c.removeSyncedDuplicates()).toThrow(/row 2/);
    expect(rowsIn(c)).toHaveLength(2);
  });

  it('says there is nothing to do rather than nothing at all', () => {
    const c = load();
    c.setup();
    imported(c);
    synced(c, { amount: -99 });

    expect(c.removeSyncedDuplicates().error).toMatch(/No imported row pairs/);
  });

  it('refuses when nothing came from an import', () => {
    const c = load();
    c.setup();
    synced(c);

    expect(c.removeSyncedDuplicates().error).toMatch(/came from an import/);
  });

  it('warns when the match has clearly gone wrong', () => {
    // A quarter of the tab is not an overlap. Not a refusal — a genuinely
    // double-imported history looks the same and genuinely needs clearing —
    // but the moment to notice is before the delete.
    const c = load();
    c.setup();
    synced(c);
    imported(c);

    expect(c.describeSyncedDuplicates_(c.planSyncedDuplicates_())).toMatch(/50% of the tab/);
  });

  it('lists the near pairs one by one and says so when it stops', () => {
    // A pair the machine relaxed a rule to find is one you should read. A
    // dialog that silently showed the first twenty-five would be worse than
    // the count alone — you would believe you had seen them all.
    const c = load();
    const pairs = [];
    for (let i = 0; i < 30; i++) {
      pairs.push({
        kind: 'near',
        gap: 1,
        imported: record({ description: 'Refund from Amzn Mktp It' }),
        synced: record({ source: 'enablebanking', booking_date: new Date(2026, 5, 17) })
      });
    }

    const lines = c.describeNearPairs_(pairs);

    expect(lines).toHaveLength(26);
    expect(lines[0]).toMatch(/1d\s+2026-06-16 → 2026-06-17\s+24\.08/);
    expect(lines[25]).toMatch(/and 5 more, not shown/);
  });
});

describe('runsOfRows_', () => {
  it('groups descending row numbers into blocks that stay descending', () => {
    // Deleting renumbers everything below, so the walk has to go bottom-up and
    // each block has to be one deleteRows call, not one per row.
    const c = load();

    expect(c.runsOfRows_([9, 8, 7, 4, 2])).toEqual([
      { start: 7, count: 3 },
      { start: 4, count: 1 },
      { start: 2, count: 1 }
    ]);
    expect(c.runsOfRows_([])).toEqual([]);
  });
});
