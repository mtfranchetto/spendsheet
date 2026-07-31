/**
 * setup() — structure and idempotency.
 *
 * Idempotency is the load-bearing property here: setup() is how the repo
 * doubles as the spreadsheet template, so it gets re-run after every upgrade.
 * If a second run mutated anything, upgrading would be destructive and the
 * "no binary artefact to keep in sync" design would collapse.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const EXPECTED_TABS = [
  'transactions', 'pending', 'accounts', 'rules', 'categories', 'recurring',
  'cashflow', 'cash_entry', 'dashboard',
  '_anomalies', '_status', '_runs', '_config', '_import_map', '_category_map',
  '_memory', '_import_raw', '_import_staged', '_tests'
];

describe('setup()', () => {
  it('builds exactly the 19 documented tabs', () => {
    const ctx = load();
    ctx.setup();

    const names = ctx.__spreadsheet.getSheets().map((s) => s.getName());
    expect(names.sort()).toEqual([...EXPECTED_TABS].sort());
    expect(names).toHaveLength(19);
  });

  it('removes the blank starter tab but never a sheet with content', () => {
    const ctx = load();
    ctx.__spreadsheet.getSheetByName('Sheet1').getRange('A1').setValue('my notes');
    ctx.setup();

    expect(ctx.__spreadsheet.getSheetByName('Sheet1')).not.toBeNull();
  });

  it('changes nothing on a second run', () => {
    const ctx = load();
    ctx.setup();
    const first = JSON.stringify(ctx.__spreadsheet.snapshot());

    ctx.setup();
    const second = JSON.stringify(ctx.__spreadsheet.snapshot());

    expect(second).toEqual(first);
  });

  it('restores seed data if you empty a seeded tab, but does not duplicate it', () => {
    const ctx = load();
    ctx.setup();
    const rules = ctx.__spreadsheet.getSheetByName('rules');
    const seededRows = rules.getLastRow();
    expect(seededRows).toBeGreaterThan(40);

    // Re-running must not append the seed a second time.
    ctx.setup();
    expect(rules.getLastRow()).toBe(seededRows);

    // But emptying it and re-running gets the defaults back.
    rules.clear();
    ctx.setup();
    expect(rules.getLastRow()).toBe(seededRows);
  });

  it('writes the documented column contract on transactions', () => {
    const ctx = load();
    ctx.setup();
    const headers = ctx.__spreadsheet.getSheetByName('transactions').headers();

    // A-O are code-owned, P onward belong to formulas and the user.
    expect(headers.slice(0, 15)).toEqual(ctx.TX_COLUMNS_CODE);
    expect(headers[6]).toBe('amount');      // G
    expect(headers[15]).toBe('amount_eur'); // P
    expect(headers).toHaveLength(26);
  });

  it('hides every _-prefixed tab and no others', () => {
    const ctx = load();
    ctx.setup();

    for (const sheet of ctx.__spreadsheet.getSheets()) {
      expect(sheet.isSheetHidden()).toBe(sheet.getName().startsWith('_'));
    }
  });

  it('protects machine-owned ranges as warning-only, without stacking duplicates', () => {
    const ctx = load();
    ctx.setup();
    ctx.setup();
    ctx.setup();

    const tx = ctx.__spreadsheet.getSheetByName('transactions');
    const protections = tx.getProtections();

    expect(protections.length).toBe(3);
    for (const p of protections) {
      // Warning-only on purpose: a hard lock is friction on a single-user
      // sheet, and you legitimately need to fix things sometimes.
      expect(p.isWarningOnly()).toBe(true);
    }
  });

  it('freezes the header row on every table', () => {
    const ctx = load();
    ctx.setup();

    for (const name of ['transactions', 'accounts', 'rules', 'categories']) {
      expect(ctx.__spreadsheet.getSheetByName(name).getFrozenRows()).toBe(1);
    }
  });

  it('seeds a category taxonomy whose kinds cover the three transaction types', () => {
    const ctx = load();
    ctx.setup();
    const cats = ctx.__spreadsheet.getSheetByName('categories');
    const rows = cats.getRange(2, 1, cats.getLastRow() - 1, 4).getValues();
    const kinds = new Set(rows.map((r) => r[2]));

    expect(kinds).toEqual(new Set(['income', 'expense', 'transfer']));
  });
});

describe('running setup twice at once', () => {
  it('refuses the second rather than racing on the same tabs', () => {
    // Setup takes long enough that clicking the menu item twice feels
    // reasonable, and two runs creating and deleting the same sheets is how
    // the locale probe ended up deleted out from under its own cleanup.
    const c = load();
    c.setup();
    c.__setLockHeld(true);

    expect(() => c.setup()).toThrow(/already running/);
  });

  it('leaves no locale probe behind', () => {
    // Named per execution so two runs cannot share one, and cleaned up by
    // name rather than through a reference that may have gone stale.
    const c = load();
    c.setup();

    const strays = c.__spreadsheet.getSheets()
      .map((s) => s.getName())
      .filter((name) => name.indexOf('__spendsheet_locale_probe') === 0);

    expect(strays).toEqual([]);
  });

  it('does not leave the book pointing at a sheet that no longer exists', () => {
    // insertSheet activates what it creates, so deleting the probe strands
    // the active sheet — and the next call that touches it fails with
    // "A sheet with ID ... doesn't exist".
    const c = load();
    c.setup();

    const active = c.__spreadsheet.getActiveSheet();
    expect(c.__spreadsheet.getSheets()).toContain(active);
  });
});
