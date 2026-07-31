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

/** Type a row into cash_entry, as you would on a phone. */
function type(c, row, values) {
  const sheet = c.__spreadsheet.getSheetByName('cash_entry');
  ['date', 'account', 'amount', 'category', 'note'].forEach((name, i) => {
    if (values[name] !== undefined) sheet.getRange(row, i + 1).setValue(values[name]);
  });
}

const drain = (c) => c.drainCashEntries_(c.readExistingIndex_(
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
    expect(drain(c)).toEqual({ inserted: 0, incomplete: 0 });
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
