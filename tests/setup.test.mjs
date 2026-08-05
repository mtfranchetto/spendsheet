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
  'transactions', 'pending', 'accounts', 'rules', 'categories',
  'cash_entry', 'dashboard', 'labels', 'recent', 'reports', 'review',
  '_anomalies', '_status', '_runs', '_config', '_import_map', '_category_map',
  '_memory', '_import_raw', '_import_staged', '_removed', '_tests'
];

describe('setup()', () => {
  it('builds exactly the 22 documented tabs', () => {
    const ctx = load();
    ctx.setup();

    const names = ctx.__spreadsheet.getSheets().map((s) => s.getName());
    expect(names.sort()).toEqual([...EXPECTED_TABS].sort());
    expect(names).toHaveLength(22);
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
    expect(headers[15]).toBe('amount_base'); // P
    expect(headers).toHaveLength(30);
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

    expect(protections.length).toBe(4);
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

describe('upgrading an existing sheet', () => {
  it('adds settings that did not exist in the version you set up with', () => {
    // Seeding is all-or-nothing, which is right for `rules` — a row you
    // deleted was a decision. It is wrong for `_config`, where a key from a
    // later version is not a row you deleted but a setting you have never
    // seen, and its absence leaves a feature unconfigurable.
    const c = load();
    c.setup();

    const config = c.__spreadsheet.getSheetByName('_config');
    const olderVersion = c.readColumn_(config, 1).slice(0, 5);
    c.clearDataRows_(config, 1, c.CONFIG_COLUMNS.length);
    c.appendRows_(config, 1, olderVersion.map((key) => [key, 'mine', '']));

    const report = c.setup();

    expect(c.readColumn_(config, 1)).toEqual(
      c.DEFAULT_CONFIG.map((row) => row[0]));
    expect(report.added).toContain('_config: import_batch');
  });

  it('never overwrites a value you changed', () => {
    const c = load();
    c.setup();

    const config = c.__spreadsheet.getSheetByName('_config');
    const row = c.readColumn_(config, 1).indexOf('sync_hour') + 2;
    config.getRange(row, 2).setValue(23);

    c.setup();

    expect(config.getRange(row, 2).getValue()).toBe(23);
    expect(c.setup().added).toEqual([]);
  });

  it('adds category mappings that did not exist in the version you set up with', () => {
    // The same gap as _config and a worse one to land on: a category map
    // missing twenty-five of its rows imports a year of history with blank
    // categories, and the import is the operation you least want to do twice.
    const c = load();
    c.setup();

    const map = c.__spreadsheet.getSheetByName('_category_map');
    const older = c.DEFAULT_CATEGORY_MAP.slice(0, 10);
    c.clearDataRows_(map, 1, c.CATEGORY_MAP_COLUMNS.length);
    c.appendRows_(map, 1, older);

    const report = c.setup();

    expect(c.readColumn_(map, 2)).toHaveLength(c.DEFAULT_CATEGORY_MAP.length);
    expect(report.added.filter((a) => a.startsWith('_category_map')))
      .toHaveLength(c.DEFAULT_CATEGORY_MAP.length - older.length);
  });

  it('matches a mapping on its source category, not on where you sent it', () => {
    // The whole point of that tab is disagreeing with the default. An upgrade
    // that read your edit as a missing row and appended the shipped one would
    // leave two rows for one category — and INDEX/MATCH takes the first, so
    // your correction would keep working right up until it didn't.
    const c = load();
    c.setup();

    const map = c.__spreadsheet.getSheetByName('_category_map');
    const row = c.readColumn_(map, 2).indexOf('Kids') + 2;
    map.getRange(row, 3).setValue('Shopping');
    map.getRange(row, 4).setValue('Gifts');

    const report = c.setup();

    expect(map.getRange(row, 3).getValue()).toBe('Shopping');
    expect(report.added).toEqual([]);
  });

  it('leaves rules alone, because a rule you deleted was a decision', () => {
    const c = load();
    c.setup();

    const rules = c.__spreadsheet.getSheetByName('rules');
    c.clearDataRows_(rules, 1, c.RULE_COLUMNS.length);
    c.appendRows_(rules, 1, c.DEFAULT_RULES.slice(0, 3));

    c.setup();

    expect(c.readColumn_(rules, 1)).toHaveLength(3);
  });
});


/**
 * Money formats.
 *
 * The interesting assertion is the negative one: a column whose currency
 * varies per row must not name a currency, because a CHF figure rendered
 * with a euro sign is a wrong number that looks right.
 */
describe('currency formatting', () => {
  const formatsFor = (c, tab) =>
    c.__spreadsheet.getSheetByName(tab).calls.filter((call) => call.kind === 'numberFormat');

  it('names the currency on amount_base, which is base currency by construction', () => {
    const c = load();
    c.setup();

    const eur = c.colIndex_(c.TX_COLUMNS, 'amount_base');
    const applied = formatsFor(c, 'transactions')
      .filter((call) => call.a1.startsWith(`2,${eur},`));

    expect(applied.length).toBeGreaterThan(0);
    expect(applied[applied.length - 1].pattern).toContain('€');
  });

  it('leaves amount unqualified, because the bank chose its currency', () => {
    // Fineco alone supplies CHF, GBP and USD rows on the same tab.
    const c = load();
    c.setup();

    const amount = c.colIndex_(c.TX_COLUMNS, 'amount');
    const applied = formatsFor(c, 'transactions')
      .filter((call) => call.a1.startsWith(`2,${amount},`));

    expect(applied.length).toBeGreaterThan(0);
    applied.forEach((call) => expect(call.pattern).not.toContain('€'));
  });

  it('shows an account balance in that account own currency', () => {
    const c = load();
    c.setup();

    const accounts = c.__spreadsheet.getSheetByName('accounts');
    accounts.getRange('A2').setValue('acc-chf');
    accounts.getRange('F2').setValue('CHF');
    accounts.getRange('A3').setValue('acc-eur');
    accounts.getRange('F3').setValue('EUR');
    c.setup();

    const balance = c.colIndex_(c.ACCOUNT_COLUMNS, 'balance');
    const at = (row) => accounts.calls
      .filter((call) => call.kind === 'numberFormat' && call.a1 === `${row},${balance},1,1`)
      .pop();

    expect(at(2).pattern).toContain('CHF');
    expect(at(3).pattern).toContain('€');
  });

  it('follows base_currency rather than hardcoding the euro', () => {
    const c = load();
    c.setup();
    c.__spreadsheet.getSheetByName('_config').getRange('B2').setValue('x');

    expect(c.currencyFormat_('GBP')).toContain('£');
    expect(c.currencyFormat_('SEK')).toContain('SEK');
  });
});


/**
 * A seeded row the sheet answers differently.
 *
 * The upgrade path only ever added what was absent, so a default I later
 * *corrected* never reached a sheet that already held the old value. That is
 * how `Child Support` stayed mapped to `Other / Uncategorised` long after the
 * code said `Income / Child support`, filing money received as money spent.
 */
describe('seed rows that disagree with the defaults', () => {
  const mapRow = (c) => {
    const map = c.__spreadsheet.getSheetByName('_category_map');
    const rows = c.readRecords_(map, c.CATEGORY_MAP_COLUMNS);
    return rows.filter((r) => r.source_category === 'Child Support')[0];
  };

  it('reports one without changing it', () => {
    const c = load();
    c.setup();

    const row = mapRow(c);
    const map = c.__spreadsheet.getSheetByName('_category_map');
    map.getRange(row._row, 3).setValue('Other');
    map.getRange(row._row, 4).setValue('Uncategorised');

    const report = c.setup();
    const found = report.diverged.filter((d) => d.key.indexOf('Child Support') !== -1)[0];

    expect(found).toBeTruthy();
    expect(found.yours).toBe('Other / Uncategorised');
    expect(found.standard).toBe('Income / Child support');

    // Yours is in force: an edit you made is not a bug to be repaired.
    expect(mapRow(c).category).toBe('Other');
  });

  it('says nothing when the sheet matches the defaults', () => {
    const c = load();
    c.setup();
    expect(c.setup().diverged).toEqual([]);
  });

  it('writes the full list to _anomalies, since a toast does not survive', () => {
    const c = load();
    c.setup();

    const map = c.__spreadsheet.getSheetByName('_category_map');
    map.getRange(mapRow(c)._row, 3).setValue('Shopping');
    c.setup();

    expect(c.readColumn_(c.__spreadsheet.getSheetByName('_anomalies'), 4)
      .filter((d) => String(d).indexOf('differ from the defaults') !== -1)).toHaveLength(1);
  });
});


/**
 * Accepting the defaults.
 *
 * setup() reports a divergence and changes nothing, which is right and is a
 * dead end on its own: after the taxonomy shrank to twelve categories,
 * eleven mappings still pointed at parents that no longer existed and the
 * only remedy on offer was retyping them.
 */
describe('applySeedDefaults', () => {
  const mapSheet = (c) => c.__spreadsheet.getSheetByName('_category_map');
  const rowFor = (c, source) =>
    c.readRecords_(mapSheet(c), c.CATEGORY_MAP_COLUMNS)
      .filter((r) => r.source_category === source)[0];

  /** A sheet holding the pre-merge mapping, as a real one does. */
  function stale(c) {
    const row = rowFor(c, 'Kids');
    mapSheet(c).getRange(row._row, 3).setValue('Family');
    mapSheet(c).getRange(row._row, 4).setValue('Kids');
    return row;
  }

  it('replaces a row that disagrees, once you say yes', () => {
    const c = load();
    c.setup();
    stale(c);

    expect(c.applySeedDefaults().updated).toBeGreaterThan(0);
    expect(rowFor(c, 'Kids').category).toBe('Shopping');
    expect(rowFor(c, 'Kids').subcategory).toBe('Kids');
  });

  it('changes nothing when you say no', () => {
    const c = load({ alertResponse: 'NO' });
    c.setup();
    stale(c);

    expect(c.applySeedDefaults().updated).toBe(0);
    expect(rowFor(c, 'Kids').category).toBe('Family');
  });

  it('leaves a mapping you invented alone', () => {
    // Its key is not in the defaults, so there is nothing to compare it to.
    const c = load();
    c.setup();
    c.appendRows_(mapSheet(c), 1, [['budgetbakers', 'My own category', 'Shopping', 'Books']]);

    c.applySeedDefaults();
    expect(rowFor(c, 'My own category').category).toBe('Shopping');
  });

  it('names a mapping pointing at a category that no longer exists', () => {
    // Silent otherwise: the override is written and every report grouping by
    // category simply never shows it.
    const c = load();
    c.setup();
    c.appendRows_(mapSheet(c), 1, [['budgetbakers', 'Ghost', 'Retired', 'Gone']]);

    const orphans = c.applySeedDefaults().orphans;
    expect(orphans.filter((o) => o.source === 'Ghost')[0].target).toBe('Retired / Gone');
  });

  it('never adds or removes a row, only rewrites answers', () => {
    const c = load();
    c.setup();
    const before = c.lastRecordRow_(mapSheet(c), 1);
    stale(c);

    c.applySeedDefaults();
    expect(c.lastRecordRow_(mapSheet(c), 1)).toBe(before);
  });
});

/**
 * Dropdowns on every column with a closed vocabulary.
 *
 * Typing into one of these is how you get a `starts-with` no rule engine has
 * heard of, or an `Expense` that does not match `expense` — failures that look
 * like "the rule just doesn't fire" and have no error anywhere.
 */
describe('what you can pick instead of type', () => {
  const c = load();
  c.setup();
  const sheet = (name) => c.__spreadsheet.getSheetByName(name);

  /** The validation rule recorded for a whole column, if there is one. */
  const ruleFor = (tab, headers, name) => {
    const letter = c.colOf(headers, name);
    const target = sheet(tab).getRange(letter + '2:' + letter).a1();
    const recorded = sheet(tab).calls
      .filter((call) => call.kind === 'validation' && call.a1 === target);
    return recorded.length ? recorded[recorded.length - 1].rule : null;
  };

  it('gives every fixed-vocabulary column a list', () => {
    const expected = [
      ['rules', c.RULE_COLUMNS, 'field', c.RULE_FIELDS],
      ['rules', c.RULE_COLUMNS, 'match_type', c.RULE_MATCH_TYPES],
      ['rules', c.RULE_COLUMNS, 'type', c.TX_TYPES],
      ['categories', c.CATEGORY_COLUMNS, 'kind', c.TX_TYPES],
      ['accounts', c.ACCOUNT_COLUMNS, 'kind', c.ACCOUNT_KINDS],
      ['_import_map', c.IMPORT_MAP_COLUMNS, 'target_column', c.TX_COLUMNS]
    ];

    expected.forEach(([tab, headers, name, values]) => {
      const rule = ruleFor(tab, headers, name);
      expect(rule, `${tab}.${name}`).not.toBeNull();
      expect(rule.values, `${tab}.${name}`).toEqual(values);
    });
  });

  /**
   * The audit: every column you type a constrained value into has a rule.
   *
   * Listed rather than derived, because "is this vocabulary closed" is a
   * judgement about the column's meaning and not something a schema knows.
   * The point is that adding a column of that kind means adding a line here,
   * and forgetting one shows up as a failure rather than as a tab you type
   * into and get wrong quietly.
   */
  it('leaves no column with a fixed vocabulary without one', () => {
    const covered = [
      ['transactions', c.TX_COLUMNS, 'category_override'],
      ['transactions', c.TX_COLUMNS, 'subcategory_override'],
      ['transactions', c.TX_COLUMNS, 'confirmed'],
      ['transactions', c.TX_COLUMNS, 'excluded'],
      ['accounts', c.ACCOUNT_COLUMNS, 'kind'],
      ['accounts', c.ACCOUNT_COLUMNS, 'active'],
      ['accounts', c.ACCOUNT_COLUMNS, 'include_in_net_worth'],
      ['cash_entry', c.CASH_ENTRY_COLUMNS, 'account'],
      ['cash_entry', c.CASH_ENTRY_COLUMNS, 'category'],
      ['cash_entry', c.CASH_ENTRY_COLUMNS, 'subcategory'],
      ['cash_entry', c.CASH_ENTRY_COLUMNS, 'labels'],
      ['rules', c.RULE_COLUMNS, 'field'],
      ['rules', c.RULE_COLUMNS, 'match_type'],
      ['rules', c.RULE_COLUMNS, 'type'],
      ['rules', c.RULE_COLUMNS, 'category'],
      ['rules', c.RULE_COLUMNS, 'subcategory'],
      ['rules', c.RULE_COLUMNS, 'enabled'],
      ['categories', c.CATEGORY_COLUMNS, 'category'],
      ['categories', c.CATEGORY_COLUMNS, 'kind'],
      ['_import_map', c.IMPORT_MAP_COLUMNS, 'preset'],
      ['_import_map', c.IMPORT_MAP_COLUMNS, 'target_column'],
      ['_category_map', c.CATEGORY_MAP_COLUMNS, 'preset'],
      ['_category_map', c.CATEGORY_MAP_COLUMNS, 'category'],
      ['_category_map', c.CATEGORY_MAP_COLUMNS, 'subcategory'],
      ['review', c.REVIEW_COLUMNS, 'confirmed'],
      ['review', c.REVIEW_COLUMNS, 'category_override'],
      ['review', c.REVIEW_COLUMNS, 'subcategory_override']
    ];

    const missing = covered
      .filter(([tab, headers, name]) => !ruleFor(tab, headers, name))
      .map(([tab, , name]) => `${tab}.${name}`);

    expect(missing).toEqual([]);
  });

  it('offers accounts by name, since an id is a provider UUID', () => {
    // The list used to be `account_id`, which on a phone means choosing
    // between forty characters of hex and forty other characters of hex.
    const rule = ruleFor('cash_entry', c.CASH_ENTRY_COLUMNS, 'account');

    expect(rule.type).toBe('range');
    expect(rule.values.getColumn()).toBe(c.colIndex_(c.ACCOUNT_COLUMNS, 'name'));
    expect(rule.values.getColumn()).not.toBe(c.colIndex_(c.ACCOUNT_COLUMNS, 'account_id'));
  });

  it('resolves either a name or an id back to the account', () => {
    // The column has held ids since it existed, so a book written before the
    // dropdown changed is full of them and still has to drain.
    const accounts = { byId: { 'uuid-1': 'Wallet' }, byName: { Wallet: 'uuid-1' } };

    expect(c.resolveCashAccount_('Wallet', accounts)).toEqual({ id: 'uuid-1', name: 'Wallet' });
    expect(c.resolveCashAccount_('uuid-1', accounts)).toEqual({ id: 'uuid-1', name: 'Wallet' });
    // Unknown stays as itself rather than becoming an empty cell.
    expect(c.resolveCashAccount_('Jar', accounts)).toEqual({ id: 'Jar', name: 'Jar' });
  });

  it('offers the presets a seed already uses, and allows a new one', () => {
    // Not to close the vocabulary — a preset for a bank nobody has imported
    // from is the point of the column — but to stop `BudgetBakers` and
    // `budgetbakers` becoming two presets, one applying to nothing.
    const rule = ruleFor('_category_map', c.CATEGORY_MAP_COLUMNS, 'preset');
    expect(rule.values).toContain('budgetbakers');
    expect(rule.allowInvalid).toBe(true);
  });

  it('refuses a value off the list where nothing would read it', () => {
    // A warning triangle on a value the code will never look at is not a
    // warning, it is a lie about what the sheet accepts.
    [['rules', c.RULE_COLUMNS, 'field'],
      ['rules', c.RULE_COLUMNS, 'match_type'],
      ['rules', c.RULE_COLUMNS, 'type'],
      ['categories', c.CATEGORY_COLUMNS, 'kind']].forEach(([tab, headers, name]) => {
      expect(ruleFor(tab, headers, name).allowInvalid, `${tab}.${name}`).toBe(false);
    });
  });

  it('allows one off the list where the list is live data', () => {
    // You may well type a category a moment before adding it to the tab, and
    // refusing that would make the taxonomy impossible to grow.
    [['rules', c.RULE_COLUMNS, 'category'],
      ['_category_map', c.CATEGORY_MAP_COLUMNS, 'category'],
      ['_category_map', c.CATEGORY_MAP_COLUMNS, 'subcategory']].forEach(
      ([tab, headers, name]) => {
        const rule = ruleFor(tab, headers, name);
        expect(rule, `${tab}.${name}`).not.toBeNull();
        expect(rule.allowInvalid, `${tab}.${name}`).toBe(true);
      });
  });

  it('points the subcategory dropdowns at a derived, sorted column', () => {
    // Sheets has no dependent dropdown without code, so this is every
    // subcategory rather than the chosen parent's — still the difference
    // between picking and remembering whether you wrote Groceries or Grocery.
    const cats = sheet('categories');
    const column = c.colOf(c.CATEGORY_COLUMNS, 'child_list');

    expect(cats.getRange(column + '2').getFormula()).toContain('SORT(');
    expect(cats.getRange(column + '2').getFormula()).toContain('UNIQUE(');
  });

  it('leaves labels alone, where a list rule would flag every real row', () => {
    // `kids, travel` is as common as one value, and a warning on every
    // multi-label row trains you to ignore warnings.
    expect(ruleFor('transactions', c.TX_COLUMNS, 'labels')).toBeNull();
  });
});
