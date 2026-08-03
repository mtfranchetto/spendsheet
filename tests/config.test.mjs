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

describe('escapeHtml_', () => {
  it('neutralises every character that can start markup or leave an attribute', () => {
    expect(ctx.escapeHtml_('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(ctx.escapeHtml_('" onerror="alert(1)'))
      .toBe('&quot; onerror=&quot;alert(1)');
    expect(ctx.escapeHtml_("' onload='x")).toBe('&#39; onload=&#39;x');
  });

  it('escapes the ampersand first, so nothing is escaped twice', () => {
    // Any other order turns `<` into `&amp;lt;` — which renders as visible
    // gibberish, and is the shape of bug that gets "fixed" by deleting the
    // escaping that was working.
    expect(ctx.escapeHtml_('<')).toBe('&lt;');
    expect(ctx.escapeHtml_('&lt;')).toBe('&amp;lt;');
    expect(ctx.escapeHtml_('a & b < c')).toBe('a &amp; b &lt; c');
  });

  it('renders a blank for the values a missing field actually arrives as', () => {
    expect(ctx.escapeHtml_('')).toBe('');
    expect(ctx.escapeHtml_(null)).toBe('');
    expect(ctx.escapeHtml_(undefined)).toBe('');
  });

  it('leaves ordinary text exactly as it was', () => {
    expect(ctx.escapeHtml_('Banca Popolare di Sondrio')).toBe('Banca Popolare di Sondrio');
    expect(ctx.escapeHtml_(42)).toBe('42');
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
    expect(ctx.TX_COLUMNS).toHaveLength(29);
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
    expect(names).toContain('Sync now');              // phase 4
    expect(names).toContain('Import staged rows');     // phase 6
    expect(names).toContain('Re-categorise all');      // phase 7
    expect(names).toContain('Detect recurring');       // phase 9

    // The real invariant, now that every declared entry has landed: the menu
    // shows an item only when the function behind it exists. It used to be
    // checked by naming the phases that had not shipped, which stops proving
    // anything the moment the last one does — and would have gone on passing
    // for a menu that offered nothing at all.
    const shown = menu.items.filter((i) => !i.separator);
    shown.forEach(({ name, fn }) => {
      expect(typeof fresh[fn], `${name} → ${fn}() is not defined`).toBe('function');
    });
    expect(shown.length).toBe(fresh.MENU_ITEMS.filter((i) => !i.separator).length);
  });

  it('files the diagnostics away in a submenu', () => {
    // They are for the days something is wrong. Putting them on the first
    // screen makes the whole thing read as a system that expects to break.
    const fresh = load();
    fresh.onOpen();

    const top = fresh.__ui.find((c) => c.title === 'Spendsheet').items.map((i) => i.name);
    expect(top).not.toContain('Run smoke tests');
    expect(top).not.toContain('Diagnose accounts tab');

    const diagnostics = fresh.__ui.find((c) => c.title === 'Diagnostics');
    expect(diagnostics.items.map((i) => i.name)).toContain('Run smoke tests');
  });
});
