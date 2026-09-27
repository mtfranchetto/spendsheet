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
import { addCash, addRule, decide, deleteRecord, nextRow, RULE_COLUMNS, transfer, transferLegUid } from './actions';
import { FakeGoogle } from './fake-google';
import { ACCOUNT_COLUMNS, CATEGORY_COLUMNS, TX_COLUMNS } from '../src/domain/schema';
import { MAX_DECISIONS, TRANSFER_OUTSIDE } from '../src/api/contract';
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
    expect(tab.rows).toBe(6);
    expect(google.cell('transactions', 6, col('account_id'))).toBe('acc-house');
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
});
