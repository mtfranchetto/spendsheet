/**
 * The five writes, against a spreadsheet in memory.
 *
 * Each refusal asserts that **nothing was written** — a check that turns a
 * request away after writing half of it has not turned it away. The book has
 * the shape that has bitten this project before: an `ARRAYFORMULA` spilling
 * `FALSE` down `in_reports` far past the last record, so "the next row" is
 * wrong if it is read off anything but column A.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { addCash, addRule, cashEntryAmount, decide, deleteRecord, nextRow, RULE_COLUMNS, transfer, transferLegUid } from './actions';
import { FakeGoogle } from './fake-google';
import { ACCOUNT_COLUMNS, CATEGORY_COLUMNS, TX_COLUMNS } from '../src/domain/schema';
import { MAX_DECISIONS, TRANSFER_OUTSIDE } from '../src/api/contract';
import type { CashRequest, FreshRows } from '../src/api/contract';
import type { Cell } from '../src/sheets/records';

const col = (name: string) => TX_COLUMNS.indexOf(name as never) + 1;

function tx(fields: { [name: string]: Cell }): Cell[] {
  return TX_COLUMNS.map((name) => (name in fields ? fields[name] : ''));
}

// 2026-03-02 and 2026-03-03, as serials.
const MAR2 = 46083;
const MAR3 = 46084;
// 2026-03-03 10:00 in Rome is 09:00 UTC.
const NOW = new Date('2026-03-03T09:00:00Z');

let google: FakeGoogle;

beforeEach(() => {
  const transactions: Cell[][] = [
    [...TX_COLUMNS],
    tx({ uid: 'anchor', account_id: 'acc-bank', account_name: 'Revolut', amount: -1, source: 'enablebanking', in_reports: true }),
    tx({ uid: 'bank-1', account_id: 'acc-bank', account_name: 'Revolut', booking_date: MAR2, amount: -50, currency: 'EUR', description: 'To Fineco', source: 'enablebanking', type: 'expense', in_reports: true }),
    tx({ uid: 'cash-1', account_id: 'acc-cash', account_name: 'Wallet', booking_date: MAR2, amount: -12.5, currency: 'EUR', description: 'Coffee', source: 'manual', type: 'expense', in_reports: true }),
    tx({ uid: 'fineco-in', account_id: 'acc-bank2', account_name: 'Fineco', booking_date: MAR3, amount: 50, currency: 'EUR', description: 'From Revolut', source: 'enablebanking', type: 'income', in_reports: true })
  ];
  // The spill: `in_reports` says FALSE on every row the formula reaches.
  for (let r = 0; r < 15; r++) transactions.push(tx({ in_reports: false }));

  const account = (fields: { [name: string]: Cell }) => ACCOUNT_COLUMNS.map((name) => (name in fields ? fields[name] : ''));
  google = new FakeGoogle()
    .tab('transactions', transactions, 20)
    .tab('accounts', [
      [...ACCOUNT_COLUMNS],
      account({ account_id: 'acc-bank', name: 'Revolut', kind: 'bank', active: true }),
      account({ account_id: 'acc-bank2', name: 'Fineco', kind: 'bank', active: true }),
      account({ account_id: 'acc-cash', name: 'Wallet', kind: 'cash', active: true }),
      account({ account_id: 'acc-house', name: 'House', kind: 'asset', active: true }),
      account({ account_id: 'acc-old', name: 'Old', kind: 'cash', active: false })
    ])
    .tab('categories', [
      [...CATEGORY_COLUMNS.slice(0, 4)],
      ['Groceries', 'Supermarket', 'expense', '🛒'],
      ['Income', 'Salary', 'income', ''],
      ['Transfer', 'Between accounts', 'transfer', ''],
      ['Transfer', 'Cash withdrawal', 'transfer', ''],
      ['Transfer', 'Valuation change', 'transfer', '']
    ])
    .tab('_config', [['key', 'value'], ['base_currency', 'EUR'], ['transfer_window_days', 4]])
    .tab('_removed', [[...TX_COLUMNS]], 1)
    .tab('rules', [
      [...RULE_COLUMNS],
      [10, 'description', 'contains', 'COOP', '', 'Groceries', 'Supermarket', '', true],
      [30, 'description', 'contains', 'ENI', '', 'Groceries', '', '', true]
    ], 3);
});

describe('nextRow', () => {
  it('is after the last uid, not after the last thing a formula wrote', () => {
    expect(nextRow([['uid'], ['a'], ['b']])).toBe(4);
    expect(nextRow([['uid']])).toBe(2);
    expect(nextRow([])).toBe(2);
  });
});

describe('decide', () => {
  it('writes each cell at its own address, as typed values, and answers the rows read back', async () => {
    const answer = await decide(google, {
      decisions: [{ uid: 'bank-1', row: 3, confirmed: true, category_override: 'Groceries', subcategory_override: 'Supermarket', labels: ['trip', ' trip ', 'food'] }]
    });
    expect(answer).toMatchObject({ written: 1, skipped: 0, capped: false });
    expect(google.cell('transactions', 3, col('confirmed'))).toBe(true);
    expect(google.cell('transactions', 3, col('category_override'))).toBe('Groceries');
    expect(google.cell('transactions', 3, col('labels'))).toBe('trip, food');
    expect(answer.rows['3'][col('uid') - 1]).toBe('bank-1');
    expect(answer.rows['3']).toHaveLength(TX_COLUMNS.length);
  });

  it('refuses a row whose uid has moved, and writes nothing to it', async () => {
    const answer = await decide(google, { decisions: [{ uid: 'bank-1', row: 4, confirmed: true }] });
    expect(answer.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/moved/) });
    expect(google.writes).toEqual([]);
  });

  it('writes none of a decision whose amount or description is refused', async () => {
    const answer = await decide(google, {
      decisions: [
        { uid: 'bank-1', row: 3, confirmed: true, amount: 10 },
        { uid: 'bank-1', row: 3, category_override: 'Groceries', description: 'mine now' }
      ]
    });
    expect(answer.skipped).toBe(2);
    expect(google.writes).toEqual([]);
  });

  it('keeps the stored sign when cash is resized, and refuses a typed minus', async () => {
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, amount: 20 }] });
    expect(google.cell('transactions', 4, col('amount'))).toBe(-20);
    const refused = await decide(google, { decisions: [{ uid: 'cash-1', row: 4, amount: -5 }] });
    expect(refused.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/without a sign/) });
  });

  it('stores a description that looks like a formula as text', async () => {
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, description: '=IMPORTDATA("x")' }] });
    const write = google.writes[0].detail as { range: string; values: Cell[][] }[];
    expect(write).toEqual([{ range: "'transactions'!I4", values: [['=IMPORTDATA("x")']] }]);
  });

  it('refuses labels on a transfer and writes the rest', async () => {
    const answer = await decide(google, {
      decisions: [{ uid: 'bank-1', row: 3, category_override: 'Transfer', confirmed: true, labels: ['trip'] }]
    });
    expect(answer.results[0]).toMatchObject({ ok: true, refused: ['labels'] });
    expect(google.cell('transactions', 3, col('labels'))).toBe('');
    expect(google.cell('transactions', 3, col('confirmed'))).toBe(true);
  });

  it(`takes at most ${MAX_DECISIONS} and says it stopped`, async () => {
    const many = Array.from({ length: MAX_DECISIONS + 5 }, () => ({ uid: 'cash-1', row: 4, confirmed: true }));
    const answer = await decide(google, { decisions: many });
    expect(answer.capped).toBe(true);
    expect(answer.results).toHaveLength(MAX_DECISIONS);
  });

  it('refuses a decision with no row before reading anything', async () => {
    await expect(decide(google, { decisions: [{ uid: 'cash-1', confirmed: true }] })).rejects.toThrow(/uid and a row/);
    expect(google.calls).toEqual([]);
  });
});

describe('transfer', () => {
  it('marks a row going outside and stops there', async () => {
    const answer = await transfer(google, { uid: 'bank-1', row: 3, destination: TRANSFER_OUTSIDE }, NOW);
    expect(answer.message).toMatch(/out of your tracked accounts/);
    expect(google.cell('transactions', 3, col('category_override'))).toBe('Transfer');
    expect(google.cell('transactions', 3, col('subcategory_override'))).toBe('Between accounts');
    expect(google.cell('transactions', 3, col('confirmed'))).toBe(true);
    expect(google.cell('transactions', 3, col('transfer_group'))).toBe('');
  });

  it('writes the cash leg after the last uid, growing the grid, and a second tap finds it', async () => {
    const answer = await transfer(google, { uid: 'bank-1', row: 3, destination: 'Wallet' }, NOW);
    const leg = await transferLegUid('bank-1', 'acc-cash');
    expect(google.cell('transactions', 6, col('uid'))).toBe(leg);
    expect(google.cell('transactions', 6, col('amount'))).toBe(50);
    expect(google.cell('transactions', 6, col('description'))).toBe('Transfer from Revolut');
    expect(google.cell('transactions', 6, col('source'))).toBe('transfer-leg');
    expect(google.cell('transactions', 6, col('booking_date'))).toBe(MAR2);
    expect(google.cell('transactions', 6, col('subcategory_override'))).toBe('Cash withdrawal');
    expect(google.cell('transactions', 3, col('transfer_group'))).toBe('tr:bank-1');
    expect(google.cell('transactions', 6, col('transfer_group'))).toBe('tr:bank-1');
    expect(Object.keys(answer.rows).sort()).toEqual(['3', '6']);

    const again = await transfer(google, { uid: 'bank-1', row: 3, destination: 'Wallet' }, NOW);
    expect(again.message).toMatch(/already recorded/);
    expect(google.cell('transactions', 7, col('uid'))).toBe('');
  });

  it('adds grid rows when the next row is past the end', async () => {
    const tab = google.tabs.transactions;
    tab.grid.length = 5;
    tab.rows = 5;
    await transfer(google, { uid: 'bank-1', row: 3, destination: 'House' }, NOW);
    expect(google.cell('transactions', 6, col('account_id'))).toBe('acc-house');
    expect(tab.rows).toBeGreaterThanOrEqual(6);
  });

  it('pushes a row another writer put there meanwhile down, never over it', async () => {
    // The nightly sync appends at the same next row between this read and this write.
    google.meanwhile = () => {
      google.tabs.transactions.grid[5] = ['synced-meanwhile'];
    };
    await addCash(google, { id: 'phone-entry-0003', account: 'Wallet', amount: 2, category: 'Groceries' }, NOW);
    expect(google.cell('transactions', 6, col('account_name'))).toBe('Wallet');
    expect(google.cell('transactions', 7, col('uid'))).toBe('synced-meanwhile');
  });

  it('pairs a bank row with the counter leg the page named', async () => {
    const answer = await transfer(google, { uid: 'bank-1', row: 3, destination: 'Fineco', counter: { uid: 'fineco-in', row: 5 } }, NOW);
    expect(answer.message).toMatch(/Paired/);
    expect(google.cell('transactions', 3, col('transfer_group'))).toBe('tr:bank-1');
    expect(google.cell('transactions', 5, col('transfer_group'))).toBe('tr:bank-1');
    expect(google.cell('transactions', 5, col('confirmed'))).toBe(true);
    expect(google.cell('transactions', 6, col('uid'))).toBe('');
  });

  it('marks a bank row and waits when the page found no counter leg', async () => {
    const answer = await transfer(google, { uid: 'bank-1', row: 3, destination: 'Fineco' }, NOW);
    expect(answer.message).toMatch(/Nothing on that account matches it yet/);
    expect(google.cell('transactions', 3, col('transfer_group'))).toBe('');
  });

  it('says where an arriving row came from, not where it went', async () => {
    const paired = await transfer(google, { uid: 'fineco-in', row: 5, destination: 'Revolut' }, NOW);
    expect(paired.message).toMatch(/^Marked as a transfer from Revolut\./);
    const outside = await transfer(google, { uid: 'fineco-in', row: 5, destination: TRANSFER_OUTSIDE }, NOW);
    expect(outside.message).toMatch(/in from outside your tracked accounts/);
  });

  it('refuses a counter leg that is not one, and writes nothing', async () => {
    google.tabs.transactions.grid[4][col('amount') - 1] = 49.99;
    await expect(
      transfer(google, { uid: 'bank-1', row: 3, destination: 'Fineco', counter: { uid: 'fineco-in', row: 5 } }, NOW)
    ).rejects.toThrow(/amounts differ/);
    expect(google.writes).toEqual([]);
  });

  it('refuses an inactive account, the same account, and a moved row, writing nothing', async () => {
    await expect(transfer(google, { uid: 'cash-1', row: 4, destination: 'Old' }, NOW)).rejects.toThrow(/not an active account/);
    await expect(transfer(google, { uid: 'cash-1', row: 4, destination: 'Wallet' }, NOW)).rejects.toThrow(/same account/);
    await expect(transfer(google, { uid: 'cash-1', row: 3, destination: 'Wallet' }, NOW)).rejects.toThrow(/moved/);
    expect(google.writes).toEqual([]);
  });
});

describe('rule', () => {
  it('goes after the last rule, below every priority there', async () => {
    await addRule(google, { field: 'description', match_type: 'contains', pattern: ' LIDL ', category: 'Groceries', subcategory: 'Supermarket' });
    expect(google.row('rules', 4)).toEqual([40, 'description', 'contains', 'LIDL', '', 'Groceries', 'Supermarket', '', true]);
    expect(google.tabs.rules.rows).toBe(4);
  });

  it('refuses what ruleProblem_ refuses, writing nothing', async () => {
    const base = { field: 'description', match_type: 'contains', pattern: 'LIDL', category: 'Groceries' };
    await expect(addRule(google, { ...base, pattern: 'L' })).rejects.toThrow(/too short/);
    await expect(addRule(google, { ...base, category: 'Nope' })).rejects.toThrow(/no category called/);
    await expect(addRule(google, { ...base, subcategory: 'Salary' })).rejects.toThrow(/not under Groceries/);
    await expect(addRule(google, { ...base, match_type: 'regex', pattern: '((' })).rejects.toThrow(/not a pattern/);
    await expect(addRule(google, { ...base, field: 'notes' })).rejects.toThrow(/can only match on/);
    expect(google.writes).toEqual([]);
  });
});

describe('cash', () => {
  const entry = { id: 'phone-entry-0001', account: 'Wallet', amount: 3.5, category: 'Groceries', subcategory: 'Supermarket', note: 'Bread', labels: ['home'] };

  it('writes the row the drain would have, at the next row, and a retry lands once', async () => {
    const answer = await addCash(google, entry, NOW);
    const row = google.row('transactions', 6);
    expect(row[col('account_id') - 1]).toBe('acc-cash');
    expect(row[col('account_name') - 1]).toBe('Wallet');
    expect(row[col('amount') - 1]).toBe(-3.5);
    expect(row[col('currency') - 1]).toBe('EUR');
    expect(row[col('description') - 1]).toBe('Bread');
    expect(row[col('source') - 1]).toBe('manual');
    expect(row[col('category_override') - 1]).toBe('Groceries');
    expect(row[col('subcategory_override') - 1]).toBe('Supermarket');
    expect(row[col('labels') - 1]).toBe('home');
    // Today, so the moment it was typed: 10:00 in Rome.
    expect(row[col('booking_date') - 1]).toBeCloseTo(MAR3 + 10 / 24, 6);
    expect(row[col('value_date') - 1]).toBe('');
    expect(Object.keys(answer.rows)).toEqual(['6']);

    const again = await addCash(google, entry, NOW);
    expect(again.message).toBe('Already added.');
    expect(google.cell('transactions', 7, col('uid'))).toBe('');
  });

  it('dates a past entry at its day and keeps a typed minus', async () => {
    await addCash(google, { ...entry, id: 'phone-entry-0002', date: '2026-03-02', amount: -4, category: 'Transfer', subcategory: 'Valuation change', labels: [] }, NOW);
    const row = google.row('transactions', 6);
    expect(row[col('booking_date') - 1]).toBe(MAR2);
    expect(row[col('value_date') - 1]).toBe(MAR2);
    expect(row[col('transaction_date') - 1]).toBe(MAR2);
    expect(row[col('amount') - 1]).toBe(-4);
  });

  it('refuses what webAppAddCash_ refuses, writing nothing', async () => {
    await expect(addCash(google, { ...entry, id: 'x' }, NOW)).rejects.toThrow(/no id/);
    await expect(addCash(google, { ...entry, amount: 0 }, NOW)).rejects.toThrow(/zero-euro/);
    await expect(addCash(google, { ...entry, date: '2026-03-05' }, NOW)).rejects.toThrow(/in the future/);
    await expect(addCash(google, { ...entry, direction: 'income' }, NOW)).rejects.toThrow(/Income needs an Income category/);
    await expect(addCash(google, { ...entry, category: 'Transfer', subcategory: 'Between accounts' }, NOW)).rejects.toThrow(/transfer takes no labels/);
    await expect(addCash(google, { ...entry, category: 'Nope', subcategory: '' }, NOW)).rejects.toThrow(/no "Nope" category/);
    expect(google.writes).toEqual([]);
  });
});

describe('delete', () => {
  it('archives the row to _removed and deletes it, in one update', async () => {
    const answer = await deleteRecord(google, { uid: 'cash-1', row: 4 });
    expect(answer.removed).toBe(4);
    expect(google.writes).toHaveLength(1);
    expect(google.row('_removed', 2)[0]).toBe('cash-1');
    expect(google.cell('transactions', 4, col('uid'))).toBe('fineco-in');
  });

  it('refuses a synced row, row 2, and a moved row, writing nothing', async () => {
    await expect(deleteRecord(google, { uid: 'bank-1', row: 3 })).rejects.toThrow(/Only a cash transaction/);
    google.tabs.transactions.grid[1][col('source') - 1] = 'manual';
    await expect(deleteRecord(google, { uid: 'anchor', row: 2 })).rejects.toThrow(/row 2/);
    await expect(deleteRecord(google, { uid: 'cash-1', row: 5 })).rejects.toThrow(/moved/);
    expect(google.writes).toEqual([]);
  });

  it('archives the row as it was while it still existed', async () => {
    await deleteRecord(google, { uid: 'cash-1', row: 4 });
    const archived = google.row('_removed', 2);
    expect([archived[col('description') - 1], archived[col('amount') - 1]]).toEqual(['Coffee', -12.5]);
  });

  it('refuses a transfer leg and an imported row, each of which something else depends on', async () => {
    for (const source of ['transfer-leg', 'csv:budgetbakers']) {
      set(4, 'source', source);
      await expect(deleteRecord(google, { uid: 'cash-1', row: 4 }), source).rejects.toThrow(/cash transaction you typed/);
    }
    await expect(deleteRecord(google, {} as never)).rejects.toThrow(/Which transaction/);
    expect(google.writes).toEqual([]);
  });
});

/** Overwrite one `transactions` cell, as a test's precondition. */
function set(row: number, name: string, value: Cell) {
  google.tabs.transactions.grid[row - 1][col(name) - 1] = value;
}
const cell = (row: number, name: string) => google.cell('transactions', row, col(name));

describe('decide, case by case', () => {
  it('does not read a blank override as an instruction to clear one', async () => {
    // A form that serialised an empty input is not a person clearing a category.
    set(4, 'category_override', 'Groceries');
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, confirmed: true, category_override: '', subcategory_override: '' }] });
    expect(cell(4, 'category_override')).toBe('Groceries');
  });

  it('writes confirmed only when it was supplied', async () => {
    // Writing it every time would un-confirm a ticked row whose category you corrected.
    set(4, 'confirmed', true);
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, subcategory_override: 'Supermarket' }] });
    expect(cell(4, 'confirmed')).toBe(true);
    expect(cell(4, 'subcategory_override')).toBe('Supermarket');
  });

  it('un-ticks when sent false, since that is a value someone chose', async () => {
    set(4, 'confirmed', true);
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, confirmed: false }] });
    expect(cell(4, 'confirmed')).toBe(false);
  });

  it('writes the rows it can and says which it could not', async () => {
    const answer = await decide(google, {
      decisions: [{ uid: 'cash-1', row: 4, confirmed: true }, { uid: 'gone', row: 3, confirmed: true }]
    });
    expect(answer).toMatchObject({ written: 1, skipped: 1 });
    expect(answer.results[1]).toMatchObject({ uid: 'gone', ok: false });
    expect(Object.keys(answer.rows)).toEqual(['4']);
  });

  it('writes nothing outside the cells that are yours', async () => {
    // The sheet's protections are warnings; they do not stop a write.
    await decide(google, {
      decisions: [{ uid: 'cash-1', row: 4, confirmed: true, category_override: 'Groceries', subcategory_override: 'Supermarket', labels: ['x'] }]
    });
    const columns = (google.writes[0].detail as { range: string }[]).map((w) => w.range.split('!')[1].replace(/\d+$/, ''));
    expect(columns.sort()).toEqual(['AA', 'AB', 'AD', 'T']);
  });

  it('does nothing at all when handed nothing', async () => {
    expect(await decide(google, { decisions: [] })).toMatchObject({ written: 0, skipped: 0 });
    expect(await decide(google, { decisions: null })).toMatchObject({ written: 0 });
    expect(await decide(google, {})).toMatchObject({ written: 0 });
    expect(google.calls).toEqual([]);
  });

  // Labels follow `confirmed` rather than the overrides: an empty value is a value.
  it('clears labels when sent an empty list, unlike an override', async () => {
    set(4, 'labels', 'kids, travel');
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, labels: [] }] });
    expect(cell(4, 'labels')).toBe('');
  });

  it('leaves labels alone when the key is absent', async () => {
    set(4, 'labels', 'kids, travel');
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, confirmed: true }] });
    expect(cell(4, 'labels')).toBe('kids, travel');
  });

  it('stores labels in the shape splitLabels reads back, from a list or the string the tab holds', async () => {
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, labels: ['travel', '', ' travel ', null, 'kids'] }] });
    expect(cell(4, 'labels')).toBe('travel, kids');
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, labels: 'home,kids' }] });
    expect(cell(4, 'labels')).toBe('home, kids');
  });

  it('does not lose a label called constructor', async () => {
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, labels: ['constructor', 'toString'] }] });
    expect(cell(4, 'labels')).toBe('constructor, toString');
  });

  it('does not write a boolean back as a label called "false"', async () => {
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, confirmed: true, labels: false }] });
    expect(cell(4, 'labels')).toBe('');
  });

  it('refuses a label on a row that is already a transfer, and writes the rest', async () => {
    set(4, 'type', 'transfer');
    const answer = await decide(google, { decisions: [{ uid: 'cash-1', row: 4, confirmed: true, labels: ['travel'] }] });
    expect(answer.results[0]).toMatchObject({ ok: true, refused: ['labels'] });
    expect(cell(4, 'labels')).toBe('');
    expect(cell(4, 'confirmed')).toBe(true);
  });

  it('says why, rather than "nothing to write", when the label was all there was', async () => {
    set(4, 'type', 'transfer');
    const answer = await decide(google, { decisions: [{ uid: 'cash-1', row: 4, labels: ['travel'] }] });
    expect(answer.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/transfer/) });
  });

  /*
    A description is changed only where no bank will fetch the row again:
    without an `entry_reference`, a synced row's uid hashes its description,
    and a renamed one would come back as a duplicate.
  */
  it('renames cash you typed, a transfer leg and an imported row', async () => {
    for (const [source, name] of [['manual', 'Coffee with Ana'], ['transfer-leg', 'Cash for the weekend'], ['csv:budgetbakers', 'IKEA kitchen']]) {
      set(4, 'source', source);
      await decide(google, { decisions: [{ uid: 'cash-1', row: 4, description: name }] });
      expect(cell(4, 'description'), source).toBe(name);
    }
  });

  it('refuses to rename a synced row, and says why', async () => {
    const answer = await decide(google, { decisions: [{ uid: 'bank-1', row: 3, description: 'Not this' }] });
    expect(answer.results[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/bank/) });
    expect(cell(3, 'description')).toBe('To Fineco');
  });

  it('refuses a blank description, and leaves an absent one alone', async () => {
    const answer = await decide(google, { decisions: [{ uid: 'cash-1', row: 4, description: '   ' }] });
    expect(answer.results[0].ok).toBe(false);
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, confirmed: true }] });
    expect(cell(4, 'description')).toBe('Coffee');
  });

  // An amount is how much, never which way.
  it('keeps the direction of a row that goes the other way', async () => {
    set(4, 'amount', 50);
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, amount: 60 }] });
    expect(cell(4, 'amount')).toBe(60);
  });

  it('refuses a blank amount, a zero and a word', async () => {
    for (const [amount, says] of [['', /blank/], [0, /not a transaction/], ['lots', /not a number/]] as const) {
      const answer = await decide(google, { decisions: [{ uid: 'cash-1', row: 4, amount }] });
      expect(answer.results[0], String(amount)).toMatchObject({ ok: false, reason: expect.stringMatching(says) });
    }
    expect(cell(4, 'amount')).toBe(-12.5);
  });

  it('refuses an amount on anything but cash you typed, and on cash already half of a transfer', async () => {
    // Hashed into a synced uid, half of an imported row's pairing key, mirrored by a leg's partner.
    for (const source of ['enablebanking', 'csv:budgetbakers', 'transfer-leg']) {
      set(4, 'source', source);
      const answer = await decide(google, { decisions: [{ uid: 'cash-1', row: 4, amount: 8 }] });
      expect(answer.results[0], source).toMatchObject({ ok: false, reason: expect.stringMatching(/cash you typed/) });
    }
    set(4, 'source', 'manual');
    set(4, 'transfer_group', 'tr:cash-1');
    expect((await decide(google, { decisions: [{ uid: 'cash-1', row: 4, amount: 8 }] })).results[0].ok).toBe(false);
    expect(google.writes).toEqual([]);
  });

  it('leaves the amount alone when the key is absent, and answers the figure it holds when present', async () => {
    await decide(google, { decisions: [{ uid: 'cash-1', row: 4, confirmed: true }] });
    expect(cell(4, 'amount')).toBe(-12.5);
    const answer = await decide(google, { decisions: [{ uid: 'cash-1', row: 4, amount: 8 }] });
    expect(answer.rows['4'][col('amount') - 1]).toBe(-8);
  });
});

describe('a rule, case by case', () => {
  const good = { field: 'description', match_type: 'contains', pattern: 'esselunga', category: 'Groceries', subcategory: 'Supermarket' };

  it('keeps the rules already there, and says it changes nothing already in the book', async () => {
    const answer = await addRule(google, good);
    expect(answer.message).toMatch(/next sync/);
    expect(google.row('rules', 2)[3]).toBe('COOP');
    expect(google.row('rules', 4).slice(0, 4)).toEqual([40, 'description', 'contains', 'esselunga']);
  });

  it('refuses a blank pattern and a match type it cannot apply, and takes a rule with no subcategory', async () => {
    // Each refusal is a rule that would otherwise sit on the tab matching nothing, for ever.
    await expect(addRule(google, { ...good, pattern: '' })).rejects.toThrow(/Type something/);
    await expect(addRule(google, { ...good, match_type: 'fuzzy' })).rejects.toThrow(/can only match by/);
    expect(google.writes).toEqual([]);
    await expect(addRule(google, { ...good, subcategory: '' })).resolves.toBeTruthy();
  });
});

describe('a transfer, case by case', () => {
  it('takes the transfer subcategory you picked, and ignores one that is not a transfer', async () => {
    await transfer(google, { uid: 'bank-1', row: 3, destination: TRANSFER_OUTSIDE, subcategory: 'Valuation change' }, NOW);
    expect(cell(3, 'subcategory_override')).toBe('Valuation change');
    // A name from another parent would resolve to that parent's kind and put the row back into spending.
    await transfer(google, { uid: 'bank-1', row: 3, destination: TRANSFER_OUTSIDE, subcategory: 'Supermarket' }, NOW);
    expect(cell(3, 'subcategory_override')).toBe('Between accounts');
  });

  it('keys the group on the debit, whichever side it was marked from', async () => {
    await transfer(google, { uid: 'fineco-in', row: 5, destination: 'Revolut', counter: { uid: 'bank-1', row: 3 } }, NOW);
    expect([cell(3, 'transfer_group'), cell(5, 'transfer_group')]).toEqual(['tr:bank-1', 'tr:bank-1']);
  });

  it('does not take a row that is already half of another pair', async () => {
    set(5, 'transfer_group', 'tr:other');
    await expect(transfer(google, { uid: 'bank-1', row: 3, destination: 'Fineco', counter: { uid: 'fineco-in', row: 5 } }, NOW))
      .rejects.toThrow(/already in a transfer/);
    expect(google.writes).toEqual([]);
  });

  it('does not pair across a gap wider than transfer_window_days', async () => {
    set(5, 'booking_date', MAR3 + 10);
    await expect(transfer(google, { uid: 'bank-1', row: 3, destination: 'Fineco', counter: { uid: 'fineco-in', row: 5 } }, NOW))
      .rejects.toThrow(/too far apart/);
    expect(google.writes).toEqual([]);
  });

  it('debits the destination when the money came in', async () => {
    // Cash paid into a bank: the leg is the debit, or both accounts gain.
    await transfer(google, { uid: 'fineco-in', row: 5, destination: 'Wallet' }, NOW);
    expect(cell(6, 'amount')).toBe(-50);
    expect(cell(6, 'description')).toBe('Transfer to Fineco');
  });

  it('does not read an unanswered destination as "it left my accounts"', async () => {
    await expect(transfer(google, { uid: 'bank-1', row: 3, destination: '' }, NOW)).rejects.toThrow(/where the money went/);
    expect(google.calls).toEqual([]);
  });

  it('builds the leg from an amount corrected in the same press', async () => {
    await transfer(google, { uid: 'cash-1', row: 4, destination: 'House', amount: 20 }, NOW);
    expect(cell(4, 'amount')).toBe(-20);
    expect(cell(6, 'amount')).toBe(20);
  });

  it('refuses an amount on a row that is not cash you typed, before writing anything', async () => {
    await expect(transfer(google, { uid: 'bank-1', row: 3, destination: 'Wallet', amount: 120 }, NOW)).rejects.toThrow(/cash you typed/);
    expect(google.writes).toEqual([]);
  });
});

describe('a new row, and the formulas around it', () => {
  it("writes only the stored columns, never a formula's", async () => {
    await transfer(google, { uid: 'bank-1', row: 3, destination: 'Wallet' }, NOW);
    type Request = { updateCells?: { start: { columnIndex: number }; rows: { values: unknown[] }[] } };
    const requests = google.writes.filter((w) => w.kind === 'update').flatMap((w) => w.detail as Request[]);
    const written = requests.flatMap((r) =>
      r.updateCells ? r.updateCells.rows[0].values.map((_, i) => TX_COLUMNS[r.updateCells!.start.columnIndex + i]) : []);
    expect(written).toContain('transfer_group');
    for (const spilled of ['amount_base', 'category_auto', 'subcategory_auto', 'category_source', 'category', 'subcategory', 'type', 'in_reports']) {
      expect(written, spilled).not.toContain(spilled);
    }
  });

  it('writes the first row of an empty book in place, under the formulas row 2 anchors', async () => {
    // An insert at row 2 would push every anchor down to row 3.
    const anchors = tx({ type: '=ARRAYFORMULA(type)', in_reports: '=ARRAYFORMULA(in_reports)' });
    google.tabs.transactions.grid.splice(1, google.tabs.transactions.grid.length - 1, anchors);
    await addCash(google, { id: 'phone-entry-0009', account: 'Wallet', amount: 2, category: 'Groceries' }, NOW);
    expect(cell(2, 'account_name')).toBe('Wallet');
    expect(cell(2, 'type')).toBe('=ARRAYFORMULA(type)');
    expect(cell(2, 'in_reports')).toBe('=ARRAYFORMULA(in_reports)');
    expect(google.row('transactions', 3)).toEqual([]);
  });
});

describe('cash, case by case', () => {
  let n = 0;
  const entry = (over: { [key: string]: unknown } = {}) =>
    ({ id: `phone-entry-${String(++n).padStart(4, '0')}`, account: 'Wallet', amount: 3, ...over }) as unknown as CashRequest;
  const amountOf = (answer: { rows: FreshRows }) => Object.values(answer.rows)[0][col('amount') - 1];

  it('signs an amount by its category, and by the direction the page chose', async () => {
    const cases: [{ [key: string]: unknown }, number][] = [
      [{ amount: 3.5, category: 'Groceries' }, -3.5],
      [{ amount: 200, category: 'Income' }, 200],
      [{ amount: 3.5, direction: 'expense', category: 'Groceries' }, -3.5],
      [{ amount: -3.5, direction: 'expense' }, -3.5],
      [{ amount: -200, direction: 'income', category: 'Income' }, 200],
      [{ amount: 50, direction: 'income', category: 'Transfer' }, 50],
      [{ amount: 50, direction: 'expense', category: 'Transfer' }, -50]
    ];
    for (const [over, amount] of cases) {
      expect(amountOf(await addCash(google, entry(over), NOW)), JSON.stringify(over)).toBe(amount);
    }
  });

  it('refuses an income the ledger would record as spending, and a direction it does not know', async () => {
    await expect(addCash(google, entry({ amount: 200, direction: 'income' }), NOW)).rejects.toThrow(/Income needs an Income category/);
    await expect(addCash(google, entry({ amount: 200, direction: 'income', category: 'Groceries' }), NOW)).rejects.toThrow(/Income needs/);
    await expect(addCash(google, entry({ direction: 'sideways' }), NOW)).rejects.toThrow(/Choose Expense or Income/);
    expect(google.writes).toEqual([]);
  });

  it('gives two identical coffees two rows, because they are two entries', async () => {
    await addCash(google, entry({ note: 'coffee' }), NOW);
    await addCash(google, entry({ note: 'coffee' }), NOW);
    expect(cell(6, 'uid')).not.toBe(cell(7, 'uid'));
    expect([cell(6, 'description'), cell(7, 'description')]).toEqual(['coffee', 'coffee']);
  });

  it('takes today, any day before it, no day, and tomorrow — a phone east of the book is already there', async () => {
    for (const date of ['2026-03-03', '2024-01-01', '', '2026-03-04']) {
      await expect(addCash(google, entry({ date }), NOW), date).resolves.toBeTruthy();
    }
  });

  it('refuses a blank amount, a zero, a word, and no account', async () => {
    // Number('') is 0 and isFinite(0) is true, so the obvious guard passes.
    await expect(addCash(google, entry({ amount: '' }), NOW)).rejects.toThrow(/Type an amount/);
    await expect(addCash(google, entry({ amount: '0' }), NOW)).rejects.toThrow(/not a transaction/);
    await expect(addCash(google, entry({ amount: 'lots' }), NOW)).rejects.toThrow(/not a number/);
    await expect(addCash(google, entry({ account: '' }), NOW)).rejects.toThrow(/Pick an account/);
    expect(google.writes).toEqual([]);
  });

  it('stores labels in the shape splitLabels reads back, from a list or a string', async () => {
    await addCash(google, entry({ labels: ['travel', '', 'travel', 'kids'] }), NOW);
    expect(cell(6, 'labels')).toBe('travel, kids');
    await addCash(google, entry({ labels: 'travel,kids' }), NOW);
    expect(cell(7, 'labels')).toBe('travel, kids');
  });

  it('takes a transfer that carries no labels, which is how a revaluation arrives', async () => {
    await addCash(google, entry({ account: 'House', amount: 1500, category: 'Transfer', subcategory: 'Valuation change', labels: [] }), NOW);
    expect([cell(6, 'account_name'), cell(6, 'amount'), cell(6, 'subcategory_override')]).toEqual(['House', 1500, 'Valuation change']);
  });

  it('refuses a category this book does not have, by name, and says Setup is the fix', async () => {
    // Stored, it would belong to no parent and move no balance.
    await expect(addCash(google, entry({ category: 'Transfer', subcategory: 'Revaluation' }), NOW)).rejects.toThrow(/Revaluation.*Setup sheet/);
    await expect(addCash(google, entry({ category: 'Reconciliation' }), NOW)).rejects.toThrow(/Reconciliation/);
    await expect(addCash(google, entry(), NOW)).resolves.toBeTruthy();
  });

  it('keeps a gain positive and a loss negative under a transfer category', () => {
    expect(cashEntryAmount(1500, 'transfer')).toBe(1500);
    expect(cashEntryAmount(-800, 'transfer')).toBe(-800);
    expect(cashEntryAmount(3, 'expense')).toBe(-3);
  });
});
