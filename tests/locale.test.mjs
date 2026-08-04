/**
 * Locale-dependent argument separators.
 *
 * Sheets in a decimal-comma locale (it-IT, de-DE, fr-FR, es-ES...) separates
 * formula arguments with `;`, and setFormula() does not convert — a comma
 * form lands as a #ERROR! parse failure. Every formula this project writes
 * has to survive that, so the translation happens once at the write boundary
 * rather than in each builder.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

describe('localizeFormula', () => {
  it('leaves a formula untouched in a comma locale', () => {
    const f = '=IF(A1="x",1,2)';
    expect(ctx.localizeFormula(f, ',')).toBe(f);
    expect(ctx.localizeFormula(f, undefined)).toBe(f);
  });

  it('swaps argument separators in a semicolon locale', () => {
    expect(ctx.localizeFormula('=SUM(1,2,3)', ';')).toBe('=SUM(1;2;3)');
    expect(ctx.localizeFormula('=IF(A1=1,"a","b")', ';')).toBe('=IF(A1=1;"a";"b")');
  });

  it('never touches a comma inside a string literal', () => {
    // The reason this is character-by-character rather than a replace():
    // a naive swap corrupts data that merely looks like syntax.
    expect(ctx.localizeFormula('=IF(A1=1,"one, two","x")', ';'))
      .toBe('=IF(A1=1;"one, two";"x")');
    expect(ctx.localizeFormula('=CONCAT("a,b","c,d")', ';'))
      .toBe('=CONCAT("a,b";"c,d")');
  });

  it('handles nesting and empty string arguments', () => {
    expect(ctx.localizeFormula('=IF(LEN(A1)=0,"",IF(B1="x",1,2))', ';'))
      .toBe('=IF(LEN(A1)=0;"";IF(B1="x";1;2))');
  });

  it('round-trips: swapping back yields the original', () => {
    const original = ctx.accountBalanceFormula();
    const localized = ctx.localizeFormula(original, ';');

    expect(localized).not.toBe(original);
    expect(localized.split(';').length).toBe(original.split(',').length);
  });
});

describe('setup() in a decimal-comma locale', () => {
  it('writes every formula with semicolon separators', () => {
    const it = load({ locale: 'semicolon' });
    it.setup();

    const balance = it.__spreadsheet.getSheetByName('accounts').getRange('J2').getFormula();
    const amountEur = it.__spreadsheet.getSheetByName('transactions').getRange('P2').getFormula();

    expect(balance).toContain(';');
    expect(balance).not.toMatch(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
    expect(amountEur).toContain(';');
    expect(amountEur).toContain('"EUR"');
  });

  it('writes commas in a comma locale', () => {
    const us = load({ locale: 'comma' });
    us.setup();

    const balance = us.__spreadsheet.getSheetByName('accounts').getRange('J2').getFormula();
    expect(balance).toContain(',');
    expect(balance).not.toContain(';');
  });

  it('leaves no probe sheet behind, in either locale', () => {
    for (const locale of ['comma', 'semicolon']) {
      const c = load({ locale });
      c.setup();
      const names = c.__spreadsheet.getSheets().map((s) => s.getName());

      expect(names.some((n) => n.indexOf('probe') !== -1)).toBe(false);
      expect(names).toHaveLength(22);
    }
  });

  it('is still idempotent in a semicolon locale', () => {
    const it = load({ locale: 'semicolon' });
    it.setup();
    const first = JSON.stringify(it.__spreadsheet.snapshot());
    it.setup();

    expect(JSON.stringify(it.__spreadsheet.snapshot())).toBe(first);
  });
});

describe('accountBalanceFormula', () => {
  it('coerces a blank opening_balance without N()', () => {
    // N() does not vectorise reliably inside ARRAYFORMULA, and a blank
    // opening_balance would otherwise poison the addition with #VALUE!.
    const f = ctx.accountBalanceFormula();
    expect(f).not.toContain('N($G');
    expect(f).toContain('$G$2:$G="",0,');
  });
});
