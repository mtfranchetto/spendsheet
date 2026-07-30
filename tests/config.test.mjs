/**
 * Column helpers and the formula builders.
 *
 * The formulas are built from colOf() rather than hardcoded letters so that
 * inserting a column can't silently repoint a formula at the wrong data —
 * a class of bug that produces plausible numbers rather than an error.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

describe('columnLetter', () => {
  it('maps 1-based indexes to spreadsheet letters', () => {
    expect(ctx.columnLetter(1)).toBe('A');
    expect(ctx.columnLetter(15)).toBe('O');
    expect(ctx.columnLetter(26)).toBe('Z');
    expect(ctx.columnLetter(27)).toBe('AA');
    expect(ctx.columnLetter(52)).toBe('AZ');
    expect(ctx.columnLetter(53)).toBe('BA');
    expect(ctx.columnLetter(702)).toBe('ZZ');
    expect(ctx.columnLetter(703)).toBe('AAA');
  });

  it('refuses a 0-based index rather than silently returning nonsense', () => {
    expect(() => ctx.columnLetter(0)).toThrow();
    expect(() => ctx.columnLetter(-1)).toThrow();
  });
});

describe('colOf', () => {
  it('locates the documented columns', () => {
    expect(ctx.colOf(ctx.TX_COLUMNS, 'uid')).toBe('A');
    expect(ctx.colOf(ctx.TX_COLUMNS, 'amount')).toBe('G');
    expect(ctx.colOf(ctx.TX_COLUMNS, 'imported_at')).toBe('O');
    expect(ctx.colOf(ctx.TX_COLUMNS, 'amount_eur')).toBe('P');
    expect(ctx.colOf(ctx.TX_COLUMNS, 'excluded')).toBe('Z');
    expect(ctx.colOf(ctx.ACCOUNT_COLUMNS, 'balance')).toBe('J');
  });

  it('throws on an unknown column instead of returning a wrong letter', () => {
    expect(() => ctx.colOf(ctx.TX_COLUMNS, 'nope')).toThrow(/no column named/);
  });
});

describe('the column contract', () => {
  it('keeps code-owned columns in A-O and derived ones from P', () => {
    expect(ctx.TX_COLUMNS_CODE).toHaveLength(15);
    expect(ctx.TX_COLUMNS).toHaveLength(26);
    expect(ctx.TX_COLUMNS.slice(0, 15)).toEqual(ctx.TX_COLUMNS_CODE);
  });

  it('gives pending the same code-owned columns and nothing else', () => {
    expect(ctx.PENDING_COLUMNS).toEqual(ctx.TX_COLUMNS_CODE);
  });

  it('orders balance preference with closing-booked first', () => {
    expect(ctx.BALANCE_PREFERENCE[0]).toBe('CLBD');
    expect(new Set(ctx.BALANCE_PREFERENCE).size).toBe(ctx.BALANCE_PREFERENCE.length);
  });
});

describe('amountEurFormula', () => {
  const f = ctx.amountEurFormula();

  it('reads the amount and currency columns', () => {
    expect(f).toContain('$G$2:$G');
    expect(f).toContain('$H$2:$H');
  });

  it('leaves non-matching currencies blank rather than copying the raw amount', () => {
    // Wrong-and-quiet is the failure worth engineering against: a GBP figure
    // summed as EUR looks entirely plausible.
    expect(f).toMatch(/,""\)+$/);
  });

  it('takes the base currency from _config, defaulting to EUR', () => {
    expect(f).toContain('_config');
    expect(f).toContain('"EUR"');
  });
});

describe('categoryFormula', () => {
  it('lets a manual override win over the cascade', () => {
    const f = ctx.categoryFormula();
    const override = ctx.colOf(ctx.TX_COLUMNS, 'category_override');
    const auto = ctx.colOf(ctx.TX_COLUMNS, 'category_auto');

    expect(f.indexOf(`$${override}$2`)).toBeLessThan(f.lastIndexOf(`$${auto}$2`));
    expect(f).toContain('ARRAYFORMULA');
  });

  it('clears the auto subcategory when you override the category', () => {
    // A subcategory belonging to a different parent reads as real and rolls
    // up wrongly, which is worse than having none.
    const f = ctx.subcategoryFormula();
    expect(f).toContain('>0,""');
  });
});

describe('accountBalanceFormula', () => {
  const f = ctx.accountBalanceFormula();

  it('covers all three account kinds', () => {
    expect(f).toContain('"bank"');
    expect(f).toContain('"cash"');
    expect(f).toContain('"asset"');
  });

  it('derives a cash balance from its own transactions', () => {
    expect(f).toContain('SUMIF(transactions!');
  });

  it('sums amount_eur, not amount', () => {
    // Every report reads amount_eur from day one. Summing `amount` here
    // would silently mix currencies into a single figure.
    const eur = ctx.colOf(ctx.TX_COLUMNS, 'amount_eur');
    expect(f).toContain(`transactions!$${eur}$2:$${eur}`);
    expect(f).not.toContain('transactions!$G$2:$G');
  });
});

describe('seed data', () => {
  it('puts MCC rules above text rules, since MCC is language-independent', () => {
    const mcc = ctx.DEFAULT_RULES.filter((r) => r[1] === 'mcc');
    const text = ctx.DEFAULT_RULES.filter((r) => r[1] === 'description');

    expect(mcc.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(Math.max(...mcc.map((r) => r[0]))).toBeLessThan(Math.min(...text.map((r) => r[0])));
  });

  it('gives every rule a unique priority, so match order is deterministic', () => {
    const priorities = ctx.DEFAULT_RULES.map((r) => r[0]);
    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('only ever maps rules to categories that exist in the taxonomy', () => {
    const pairs = new Set(ctx.DEFAULT_CATEGORIES.map((c) => `${c[0]}|${c[1]}`));
    const orphans = ctx.DEFAULT_RULES
      .map((r) => `${r[5]}|${r[6]}`)
      .filter((p) => !pairs.has(p));

    expect(orphans).toEqual([]);
  });

  it('agrees with the taxonomy about which rules are transfers', () => {
    const kindOf = new Map(ctx.DEFAULT_CATEGORIES.map((c) => [`${c[0]}|${c[1]}`, c[2]]));
    const mismatched = ctx.DEFAULT_RULES.filter((r) => kindOf.get(`${r[5]}|${r[6]}`) !== r[7]);

    expect(mismatched).toEqual([]);
  });

  it('seeds a base currency and a stale threshold', () => {
    const keys = ctx.DEFAULT_CONFIG.map((r) => r[0]);
    expect(keys).toContain('base_currency');
    expect(keys).toContain('stale_threshold_days');
  });
});

describe('the menu', () => {
  it('shows only implemented items, so nothing in it throws', () => {
    const fresh = load();
    fresh.onOpen();
    const menu = fresh.__ui.find((c) => c.title === 'Spendsheet');

    const names = menu.items.map((i) => i.name);
    expect(names).toContain('Setup sheet');
    expect(names).toContain('Install credentials');   // phase 2
    expect(names).toContain('Connect a bank');        // phase 3
    // Phases 4-9 have not landed, so their entries must not be offered yet.
    expect(names).not.toContain('Sync now');
    expect(names).not.toContain('Detect recurring');
  });
});
