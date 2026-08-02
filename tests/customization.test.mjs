/**
 * What survives re-running setup().
 *
 * setup() is meant to be re-run after every upgrade, so the boundary between
 * "code owns this" and "you own this" has to hold across runs. These tests
 * pin that boundary down, because the failure mode — quietly discarding a
 * customisation — is one you'd notice weeks later, if at all.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

describe('your customisations survive setup()', () => {
  it('keeps a column you appended past the schema', () => {
    const ctx = load();
    ctx.setup();
    const tx = ctx.__spreadsheet.getSheetByName('transactions');

    // One past whatever the schema currently ends at, so adding a column to
    // the schema moves this test rather than breaking the promise it makes.
    const mine = ctx.TX_COLUMNS.length + 1;
    tx.maxColumns = mine;
    tx.getRange(1, mine).setValue('my_column');
    tx.getRange(2, mine).setValue('my note');

    ctx.setup();

    expect(tx.getRange(1, mine).getValue()).toBe('my_column');
    expect(tx.getRange(2, mine).getValue()).toBe('my note');
  });

  it('keeps a tab you created yourself', () => {
    const ctx = load();
    ctx.setup();
    ctx.__spreadsheet.insertSheet('my analysis').getRange('A1').setValue('mine');

    ctx.setup();

    const mine = ctx.__spreadsheet.getSheetByName('my analysis');
    expect(mine).not.toBeNull();
    expect(mine.getRange('A1').getValue()).toBe('mine');
  });

  it('keeps rules you edited, added or deleted', () => {
    const ctx = load();
    ctx.setup();
    const rules = ctx.__spreadsheet.getSheetByName('rules');

    rules.getRange(2, 6).setValue('My Category');
    const rowCount = rules.getLastRow();
    rules.getRange(rowCount + 1, 1, 1, 9)
      .setValues([[999, 'description', 'contains', 'MYSHOP', '', 'Shopping', 'Home', 'expense', true]]);

    ctx.setup();

    expect(rules.getRange(2, 6).getValue()).toBe('My Category');
    expect(rules.getRange(rowCount + 1, 4).getValue()).toBe('MYSHOP');
  });

  it('keeps a hidden tab visible once you unhide it', () => {
    const ctx = load();
    ctx.setup();
    const config = ctx.__spreadsheet.getSheetByName('_config');
    expect(config.isSheetHidden()).toBe(true);

    config.showSheet();
    ctx.setup();

    expect(config.isSheetHidden()).toBe(false);
  });

  it('keeps _config values you changed', () => {
    const ctx = load();
    ctx.setup();
    const config = ctx.__spreadsheet.getSheetByName('_config');

    const rows = config.getRange(2, 1, config.getLastRow() - 1, 3).getValues();
    const row = rows.findIndex((r) => r[0] === 'stale_threshold_days') + 2;
    config.getRange(row, 2).setValue(7);

    ctx.setup();

    expect(config.getRange(row, 2).getValue()).toBe(7);
  });
});

describe('setup() reasserts what code owns', () => {
  it('restores a header you renamed', () => {
    const ctx = load();
    ctx.setup();
    const tx = ctx.__spreadsheet.getSheetByName('transactions');

    tx.getRange('G1').setValue('importo');
    ctx.setup();

    // Code addresses columns by position and reads this row to confirm it.
    // A renamed header would make the sheet lie about its own contract.
    expect(tx.getRange('G1').getValue()).toBe('amount');
  });

  it('restores a formula you overwrote', () => {
    const ctx = load();
    ctx.setup();
    const accounts = ctx.__spreadsheet.getSheetByName('accounts');

    accounts.getRange('J2').setFormula('=1');
    ctx.setup();

    expect(accounts.getRange('J2').getFormula()).toContain('ARRAYFORMULA');
  });

  it('restores seed rules only when you have emptied the tab entirely', () => {
    const ctx = load();
    ctx.setup();
    const rules = ctx.__spreadsheet.getSheetByName('rules');
    const seeded = rules.getLastRow();

    rules.clear();
    ctx.setup();
    expect(rules.getLastRow()).toBe(seeded);
  });
});
