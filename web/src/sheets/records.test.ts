/**
 * The adapter, and mostly the one thing it exists to prevent.
 *
 * `readRecords_`'s own behaviour is already covered by `tests/sheets.test.mjs`
 * against the fake `getValues()`. What is new here — and what no existing test
 * could have caught, because the `.gs` cannot produce it — is that the Sheets
 * REST API returns ragged rows. So the truncation cases are the ones asserted
 * hardest, and each is written so that deleting `pad` turns it red.
 */

import { describe, it, expect } from 'vitest';
import { records, dataRows, lastRecordIndex, ANY_COLUMN } from './records';

const HEADERS = ['uid', 'account_name', 'amount', 'description', 'category'] as const;

describe('records', () => {
  it('keys each row by column name and stamps the sheet row', () => {
    const rows = [
      ['u-1', 'Revolut', 12.5, 'COOP', 'Groceries'],
      ['u-2', 'Fineco', 40, 'ENI', 'Transport']
    ];

    expect(records(rows, HEADERS)).toEqual([
      { _row: 2, uid: 'u-1', account_name: 'Revolut', amount: 12.5, description: 'COOP', category: 'Groceries' },
      { _row: 3, uid: 'u-2', account_name: 'Fineco', amount: 40, description: 'ENI', category: 'Transport' }
    ]);
  });

  // The whole reason this file exists. A row whose tail is blank comes back
  // short from the REST API, and reading it positionally gives `undefined` —
  // which is not `''`, so `isBlankCell_` downstream is never even consulted.
  it('pads a truncated row so a missing tail reads as empty, not absent', () => {
    const rows = [['u-1', 'Revolut', 12.5]];

    const [row] = records(rows, HEADERS);

    expect(row.description).toBe('');
    expect(row.category).toBe('');
    expect('category' in row).toBe(true);
  });

  it('pads to exactly the schema width even when the row is empty past the key', () => {
    const rows = [['u-1']];

    expect(records(rows, HEADERS)[0]).toEqual({
      _row: 2, uid: 'u-1', account_name: '', amount: '', description: '', category: ''
    });
  });

  // The newest rows are the likeliest to be short — nothing reviewed, no
  // overrides set — so an unpadded read would lose the recent end of the
  // ledger while every old row looked perfect.
  it('gives a short new row the same shape as a full old one', () => {
    const rows = [
      ['u-old', 'Revolut', 12.5, 'COOP', 'Groceries'],
      ['u-new', 'Revolut', 9]
    ];

    const [old, fresh] = records(rows, HEADERS);

    // Compared by *value*, not by key. An unpadded row still has every key —
    // it is assigned `undefined` — so `Object.keys` matches on both and this
    // assertion stayed green with the padding deliberately removed. Found by
    // breaking it on purpose, which is the only way that ever shows up.
    expect(Object.keys(fresh).sort()).toEqual(Object.keys(old).sort());
    for (const name of HEADERS) expect(fresh[name]).not.toBeUndefined();
  });

  it('reads only the schema block, leaving columns to the right alone', () => {
    const rows = [['u-1', 'Revolut', 12.5, 'COOP', 'Groceries', 'my own note']];

    expect(Object.keys(records(rows, HEADERS)[0])).toHaveLength(HEADERS.length + 1);
  });

  // A tab carrying an ARRAYFORMULA spills to the sheet's last row, not to the
  // last record — the same lie `getLastRow()` tells, arriving by another route.
  it('stops at the last row with a key, not at the end of the array', () => {
    const rows = [
      ['u-1', 'Revolut', 12.5, 'COOP', 'Groceries'],
      ['', '', '', '', ''],
      ['', '', '', '', '']
    ];

    expect(records(rows, HEADERS)).toHaveLength(1);
  });

  it('returns nothing when no row carries a key', () => {
    expect(records([['', '', '']], HEADERS)).toEqual([]);
    expect(records([], HEADERS)).toEqual([]);
  });

  // `cash_entry` is typed into in no fixed order, so a row whose first cell is
  // still empty is a real row and must not be invisible.
  it('ANY_COLUMN counts a row that is filled anywhere in the block', () => {
    const rows = [['', '', 25, 'lunch', '']];

    expect(records(rows, HEADERS, ANY_COLUMN)).toHaveLength(1);
    expect(records(rows, HEADERS)).toHaveLength(0);
  });

  it('counts by the key column it is given, not always the first', () => {
    const rows = [['', 'Revolut', 12.5, 'COOP', 'Groceries']];

    expect(lastRecordIndex(rows, HEADERS.length, 2)).toBe(1);
    expect(lastRecordIndex(rows, HEADERS.length, 1)).toBe(0);
  });

  it('treats null the way the API sends a cleared cell', () => {
    expect(lastRecordIndex([[null, null]], 2, 1)).toBe(0);
  });
});

describe('dataRows', () => {
  it('drops the header row', () => {
    expect(dataRows([['uid', 'amount'], ['u-1', 5]])).toEqual([['u-1', 5]]);
  });

  // A tab with a header and no records comes back as one row, and an empty
  // range comes back absent entirely rather than as [].
  it('is empty for a header-only or missing range', () => {
    expect(dataRows([['uid', 'amount']])).toEqual([]);
    expect(dataRows(undefined)).toEqual([]);
  });
});
