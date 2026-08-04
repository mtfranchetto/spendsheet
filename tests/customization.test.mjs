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

/**
 * A column an upgrade adds is the one case where hiding on a re-run is right.
 *
 * `applyColumnVisibility_` otherwise touches nothing after the first run,
 * because unhiding a column is a decision and re-hiding it would undo that
 * decision exactly when you are chasing something. A column that did not exist
 * five seconds ago carries no decision to respect — and `in_reports` is a
 * thousand rows of FALSE if it lands visible.
 */
describe('a column added by an upgrade', () => {
  /** A book from before the column existed: same tab, one header short. */
  function olderBook() {
    const ctx = load();
    ctx.setup();
    const tx = ctx.__spreadsheet.getSheetByName('transactions');
    const column = ctx.colIndex_(ctx.TX_COLUMNS, 'in_reports');

    tx.getRange(1, column).setValue('');
    tx.showColumns(column);
    return { ctx, tx, column };
  }

  it('is hidden, the same way a new book would hide it', () => {
    const { ctx, tx, column } = olderBook();
    const report = ctx.setup();

    expect(report.newColumns).toEqual([
      { tab: 'transactions', name: 'in_reports', index: column }
    ]);
    expect(tx.isColumnHiddenByUser(column)).toBe(true);
  });

  it('leaves a column you unhid yourself unhidden', () => {
    const ctx = load();
    ctx.setup();
    const tx = ctx.__spreadsheet.getSheetByName('transactions');
    const column = ctx.colIndex_(ctx.TX_COLUMNS, 'category_auto');

    tx.showColumns(column);
    ctx.setup();

    expect(tx.isColumnHiddenByUser(column)).toBe(false);
  });

  it('reports nothing on a run that added no column', () => {
    const ctx = load();
    ctx.setup();
    expect(ctx.setup().newColumns).toEqual([]);
  });
});

/**
 * The schema grows rightwards, and so do you — into the same slot.
 *
 * This is not hypothetical: `in_reports` landed on column AC of a book that
 * already had something in AC, and the header row went straight over it. The
 * cost was two symptoms that do not point at each other — a column of yours
 * quietly renamed, and an ARRAYFORMULA that cannot expand through data and
 * reports `#REF!` instead, which emptied every report gated on it.
 */
describe('a column of yours in the slot the schema grew into', () => {
  /**
   * A book one column short of the current schema, with a column of your own
   * sitting exactly where the next one lands.
   *
   * Derived from the *last* schema column rather than naming `in_reports`,
   * which is the column the incident happened to. Two more have been appended
   * since, and a test naming one of them would go on passing while exercising
   * a slot the schema no longer grows into.
   */
  function bookWithMineInTheWay(value, name) {
    const ctx = load();
    ctx.setup();
    const tx = ctx.__spreadsheet.getSheetByName('transactions');
    const last = name || ctx.TX_COLUMNS[ctx.TX_COLUMNS.length - 1];
    const column = ctx.colIndex_(ctx.TX_COLUMNS, last);

    // Blank the header, which is what a book built before the column looks
    // like. Without this the column is not new and nothing makes room.
    tx.getRange(1, column).setValue('');

    tx.getRange(1, column).setValue('my_flag');
    tx.getRange(3, column).setValue(value);
    return { ctx, tx, column, last };
  }

  it('is shifted right rather than written over', () => {
    const { ctx, tx, column } = bookWithMineInTheWay('mine');
    ctx.setup();

    expect(tx.getRange(1, column + 1).getValue()).toBe('my_flag');
    expect(tx.getRange(3, column + 1).getValue()).toBe('mine');
  });

  it('leaves the new column an empty slot for its formula to expand into', () => {
    // Named explicitly rather than derived, because this assertion is about a
    // column that carries an ARRAYFORMULA and the schema's last column is a
    // field you type into. `in_reports` is also the column it happened to.
    const { ctx, tx, column, last } = bookWithMineInTheWay('mine', 'in_reports');
    ctx.setup();

    expect(tx.getRange(1, column).getValue()).toBe(last);
    expect(tx.getRange(2, column).getFormula()).toContain('ARRAYFORMULA');
    // The whole point: nothing below the anchor, so the array can expand.
    expect(tx.getRange(3, column).getValue()).toBe('');
  });

  it('says which column it moved, because a shift you did not ask for is news', () => {
    const { ctx, column, last } = bookWithMineInTheWay('mine');

    expect(ctx.setup().movedColumns).toEqual([
      { tab: 'transactions', index: column, madeRoomFor: last }
    ]);
  });

  it('moves a formula of yours as a formula, not as the value it happened to show', () => {
    const { ctx, tx, column } = bookWithMineInTheWay('');
    tx.getRange(3, column).setFormula('=1+1');

    ctx.setup();
    expect(tx.getRange(3, column + 1).getFormula()).toBe('=1+1');
  });

  it('does not insert a column when the slot is genuinely empty', () => {
    const ctx = load();
    ctx.setup();
    const tx = ctx.__spreadsheet.getSheetByName('transactions');
    const before = tx.getMaxColumns();

    tx.getRange(1, ctx.colIndex_(ctx.TX_COLUMNS, 'in_reports')).setValue('');

    expect(ctx.setup().movedColumns).toEqual([]);
    expect(tx.getMaxColumns()).toBe(before);
  });
});
