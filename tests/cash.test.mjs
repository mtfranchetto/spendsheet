/**
 * Cash entries.
 *
 * The half of phase 5 that is code. The other half — adding a manual account —
 * is typing a row into `accounts`, and the absence of a test for it is the
 * point: there is nothing to test, because there is nothing to run.
 *
 * Two things get most of the attention. Direction, because a bare `3` typed
 * standing in a bar has to become `-3` while an ATM withdrawal has to become
 * `+100`. And identity, because two identical coffees typed hours apart are
 * exactly the case a within-batch ordinal cannot see.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

/** A sheet with a wallet and a bank account, ready to type into. */
function withWallet() {
  const c = load();
  c.setup();

  const accounts = c.__spreadsheet.getSheetByName('accounts');
  accounts.getRange('A2').setValue('wallet');
  accounts.getRange('B2').setValue('Wallet');
  accounts.getRange('C2').setValue('cash');
  accounts.getRange('G2').setValue(50);       // opening_balance
  accounts.getRange('O2').setValue(true);
  return c;
}

/**
 * Type a row into cash_entry, as you would on a phone.
 *
 * Addressed by column *name* rather than by position. The tab's column order
 * is deliberately not a contract — it is the order you fill the form in, and it
 * has already been reordered once to put subcategory beside category.
 */
function type(c, row, values) {
  const sheet = c.__spreadsheet.getSheetByName('cash_entry');
  Object.keys(values).forEach((name) => {
    sheet.getRange(row, c.colIndex_(c.CASH_ENTRY_COLUMNS, name)).setValue(values[name]);
  });
}

/**
 * Drain the tab the way the immediate path does.
 *
 * `readUidIndex_` rather than `readExistingIndex_`, because the drain asks the
 * ledger one question — is this uid already there — and the wide index is the
 * sync's, shared across every account it fetches. Handing the wrong shape here
 * would not fail: the lookup would simply never match, every entry would look
 * fresh, and the `processed` stamp would go on covering for it.
 */
const drain = (c) => c.drainCashEntries_(c.readUidIndex_(
  c.__spreadsheet.getSheetByName('transactions')), new Date());

const tx = (c) => c.__spreadsheet.getSheetByName('transactions');

describe('cashEntryAmount', () => {
  it('reads a bare number as spending', () => {
    // Standing in a bar you type 3, not -3.
    expect(ctx.cashEntryAmount(3, 'expense')).toBe(-3);
    expect(ctx.cashEntryAmount(3, undefined)).toBe(-3);
    expect(ctx.cashEntryAmount('3.50', '')).toBe(-3.5);
  });

  it('makes an ATM withdrawal add to the wallet', () => {
    // The bank side is -100 and this side is +100, so the pair nets to zero.
    expect(ctx.cashEntryAmount(100, 'transfer')).toBe(100);
  });

  it('makes income positive', () => {
    expect(ctx.cashEntryAmount(50, 'income')).toBe(50);
  });

  it('respects a minus sign you typed deliberately', () => {
    // That is how you record cash going back into a bank.
    expect(ctx.cashEntryAmount(-100, 'transfer')).toBe(-100);
    expect(ctx.cashEntryAmount(-3, 'expense')).toBe(-3);
  });

  it('reports an unreadable amount rather than guessing', () => {
    expect(ctx.cashEntryAmount('', 'expense')).toBe(null);
    expect(ctx.cashEntryAmount('abc', 'expense')).toBe(null);
  });
});

describe('draining', () => {
  it('moves a completed entry into transactions and marks it done', () => {
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, category: 'Bars & Cafes', note: 'coffee' });

    const result = drain(c);

    expect(result.inserted).toBe(1);
    expect(tx(c).getRange('B2').getValue()).toBe('wallet');
    expect(tx(c).getRange('C2').getValue()).toBe('Wallet');
    expect(tx(c).getRange('G2').getValue()).toBe(-3);
    expect(tx(c).getRange('I2').getValue()).toBe('coffee');
    expect(tx(c).getRange('N2').getValue()).toBe('manual');
    expect(c.__spreadsheet.getSheetByName('cash_entry').getRange('F2').getValue()).toBeTruthy();
  });

  it('carries the moment it was typed when the entry is for today', () => {
    const c = withWallet();
    const now = new Date(2026, 6, 30, 14, 32);
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3 });
    c.drainCashEntries_(c.readUidIndex_(tx(c)), now);

    const at = tx(c).getRange(2, c.colIndex_(c.TX_COLUMNS, 'transaction_date')).getValue();
    expect([at.getHours(), at.getMinutes()]).toEqual([14, 32]);
    // The day it belongs to is unchanged, and it is what identity reads.
    expect(c.dateKey(tx(c).getRange('D2').getValue())).toBe('2026-07-30');
  });

  it('keeps a bare date on an entry drained on another day', () => {
    // Left on the tab for the nightly sync, or typed for last week: the drain
    // happened at a moment that says nothing about when it was spent.
    //
    // Typed as 02:00 because that is what the app's `yyyy-mm-dd` becomes in
    // Rome: `new Date('2026-07-28')` is UTC midnight. A test that typed local
    // midnight passed while the app showed 02:00 on every back-dated entry.
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 28, 2, 0), account: 'wallet', amount: 3 });
    c.drainCashEntries_(c.readUidIndex_(tx(c)), new Date(2026, 6, 30, 4, 0));

    const at = tx(c).getRange(2, c.colIndex_(c.TX_COLUMNS, 'transaction_date')).getValue();
    expect([at.getHours(), at.getMinutes()]).toEqual([0, 0]);
  });

  it('puts the category you picked in the override column', () => {
    // You chose it, so it is not a guess the cascade may overrule.
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, category: 'Bars & Cafes' });
    drain(c);

    expect(tx(c).getRange('T2').getValue()).toBe('Bars & Cafes');
    expect(tx(c).getRange('P2').getFormula()).toContain('ARRAYFORMULA');
  });

  it('does not process the same entry twice', () => {
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3 });

    expect(drain(c).inserted).toBe(1);
    expect(drain(c).inserted).toBe(0);
    expect(c.readColumn_(tx(c), 1).filter(Boolean)).toHaveLength(1);
  });

  it('keeps two identical coffees typed hours apart', () => {
    // The case a within-batch ordinal cannot see: same wallet, same day,
    // same amount, same note, different drains.
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, note: 'coffee' });
    drain(c);

    type(c, 3, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, note: 'coffee' });
    drain(c);

    expect(c.readColumn_(tx(c), 1).filter(Boolean)).toHaveLength(2);
  });

  it('keeps two identical coffees typed in the same batch', () => {
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, note: 'coffee' });
    type(c, 3, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, note: 'coffee' });

    expect(drain(c).inserted).toBe(2);
  });

  it('leaves a half-typed row alone and says how many are waiting', () => {
    // On a phone, a row with a date and no amount yet is someone mid-typing.
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet' });

    const result = drain(c);

    expect(result.inserted).toBe(0);
    expect(result.incomplete).toBe(1);
    expect(c.__spreadsheet.getSheetByName('cash_entry').getRange('F2').getValue()).toBe('');
  });

  it('sees a row whose date you have not typed yet', () => {
    // The columns get filled in whatever order suits you. Keying on the
    // first column would make this row invisible, and a transaction you
    // typed would silently never sync.
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3, note: 'coffee' });

    expect(drain(c).inserted).toBe(1);
    expect(tx(c).getRange('D2').getValue()).toBeInstanceOf(Date);
  });

  it('does nothing when there is nothing typed', () => {
    const c = withWallet();
    expect(drain(c)).toEqual({ inserted: 0, incomplete: 0, stamped: [] });
  });

  it('refuses a uid the ledger already holds', () => {
    // The net under a lost sequence counter, and the only thing `readUidIndex_`
    // is read for. Asserted directly because the `processed` stamp hides it:
    // every other path to a second copy is stopped before identity is reached,
    // so a membership map that never matched would pass every test but this.
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, note: 'coffee' });
    drain(c);

    const uid = tx(c).getRange('A2').getValue();
    expect(uid).toBeTruthy();

    type(c, 3, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, note: 'again' });
    const known = c.readUidIndex_(tx(c));
    expect(known[uid]).toBeTruthy();

    // Every uid this drain could compute, already claimed.
    c.computeCashUid = () => uid;
    expect(c.drainCashEntries_(known, new Date()).inserted).toBe(0);
  });

  it('reads `categories` once when the caller has already read it', () => {
    // `appAddCash` validates the category and then drains, a few lines apart in
    // one request. Two reads of the same tab is three round trips paid twice
    // with somebody watching the button.
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 100, category: 'Transfer' });

    const index = c.categoryIndex_();
    expect(index.present).toBe(true);
    expect(index.kinds.Transfer).toBe('transfer');

    // The only way to prove a read did not happen is to make it fail.
    c.categoryIndex_ = () => { throw new Error('read categories a second time'); };

    expect(c.drainCashEntries_(
      c.readUidIndex_(tx(c)), new Date(), index).inserted).toBe(1);
    // An ATM withdrawal adds to the wallet — the direction came from `kinds`.
    expect(tx(c).getRange('G2').getValue()).toBe(100);
  });
});

describe('the wallet balance', () => {
  it('is derived from its own entries, not typed', () => {
    // opening_balance + SUMIF(transactions) — the ARRAYFORMULA setup() wrote
    // covers every row you will ever add, which is why adding a manual
    // account needs no code at all.
    const c = withWallet();
    const formula = c.__spreadsheet.getSheetByName('accounts').getRange('J2').getFormula();

    expect(formula).toContain('SUMIF');
    expect(formula).toContain('transactions!');
    expect(formula).toContain('"cash"');
  });
});

describe('through a sync', () => {
  it('lands even when there is no bank connected at all', () => {
    // Cash entries need nothing from the network, so a bank outage — or not
    // having a bank in the sheet yet — must not hold them up.
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet', amount: 3, category: 'Bars & Cafes' });

    const summary = c.syncNow();

    expect(summary.inserted).toBe(1);
    expect(summary.result).toBe('OK');
    expect(tx(c).getRange('G2').getValue()).toBe(-3);
  });

  it('mentions the rows that are missing something', () => {
    const c = withWallet();
    type(c, 2, { date: new Date(2026, 6, 30), account: 'wallet' });

    expect(c.syncNow().message).toMatch(/1 cash entry is missing/);
  });
});

/**
 * The form.
 *
 * `cash_entry` used to be a tab you appended to, drained hours later by the
 * nightly sync. For roughly one entry a day that is a queue of one and a delay
 * you cannot see the end of. The row now lands on the edit that completes it.
 */
describe('typing one entry', () => {
  /** What Apps Script hands a simple trigger. */
  const edit = (c, row, column) => c.onEdit({
    range: c.__spreadsheet.getSheetByName('cash_entry').getRange(row, column)
  });

  it('lands in transactions on the edit that completes the row', () => {
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3.5, category: 'Food & Drink' });
    edit(c, 2, 3);

    const rows = c.readRecords_(tx(c), c.TX_COLUMNS).filter((r) => r.source === 'manual');
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(-3.5);
  });

  it('empties the row so the tab is ready for the next one', () => {
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3.5, category: 'Food & Drink' });
    edit(c, 2, 3);

    const sheet = c.__spreadsheet.getSheetByName('cash_entry');
    expect(sheet.getRange('B2').getValue()).toBe('');
    expect(sheet.getRange('C2').getValue()).toBe('');
  });

  it('says what happened, where a phone can see it', () => {
    // A simple onEdit fails silently and no toast survives on mobile, so the
    // only feedback that works is a cell.
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3.5 });
    edit(c, 2, 3);

    expect(String(c.__spreadsheet.getSheetByName('cash_entry')
      .getRange(c.CASH_CONFIRM_CELL).getValue())).toContain('added');
  });

  it('leaves a half-typed row exactly alone', () => {
    // A date typed and an amount not yet is someone mid-entry, not an error.
    const c = withWallet();
    type(c, 2, { account: 'wallet' });
    edit(c, 2, 2);

    const sheet = c.__spreadsheet.getSheetByName('cash_entry');
    expect(sheet.getRange('B2').getValue()).toBe('wallet');
    expect(c.readRecords_(tx(c), c.TX_COLUMNS).filter((r) => r.source === 'manual'))
      .toHaveLength(0);
  });

  it('does not retrigger on its own confirmation', () => {
    // The confirmation is written to a cell on the same sheet, which is an
    // edit. Without the column guard this recurses.
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3.5 });

    const column = c.columnIndexOf_(c.CASH_CONFIRM_CELL.charAt(0));
    edit(c, 2, column);

    expect(c.readRecords_(tx(c), c.TX_COLUMNS).filter((r) => r.source === 'manual'))
      .toHaveLength(0);
  });

  it('ignores the header row', () => {
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3.5 });
    edit(c, 1, 1);

    expect(c.readRecords_(tx(c), c.TX_COLUMNS).filter((r) => r.source === 'manual'))
      .toHaveLength(0);
  });

  it('still drains through the sync when the trigger never fired', () => {
    // The immediate path is an optimisation over a mechanism that already
    // worked. A simple onEdit fails silently, so the backstop is the point.
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3.5 });

    expect(drain(c).inserted).toBe(1);
  });

  it('clears only the rows that made it in', () => {
    const c = withWallet();
    type(c, 2, { account: 'wallet', amount: 3.5 });
    type(c, 3, { note: 'still typing this one' });
    edit(c, 2, 3);

    const sheet = c.__spreadsheet.getSheetByName('cash_entry');
    expect(sheet.getRange('B2').getValue()).toBe('');
    expect(sheet.getRange(c.colOf(c.CASH_ENTRY_COLUMNS, 'note') + '3').getValue())
      .toBe('still typing this one');
  });
});
