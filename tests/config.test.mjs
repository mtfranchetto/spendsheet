/**
 * Column helpers and the formula builders.
 *
 * The formulas are built from colOf() rather than hardcoded letters so that
 * inserting a column can't silently repoint a formula at the wrong data —
 * a class of bug that produces plausible numbers rather than an error.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load, sourceFiles } from './harness.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

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
    expect(ctx.colOf(ctx.TX_COLUMNS, 'amount_base')).toBe('P');
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
    expect(ctx.TX_COLUMNS).toHaveLength(30);
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

  it('takes the parent from the subcategory when only that is set', () => {
    // A subcategory names exactly one parent, so correcting a row is one
    // choice. Asking for both was asking you to type what the sheet knows.
    const f = ctx.categoryFormula();
    const sub = ctx.colOf(ctx.TX_COLUMNS, 'subcategory_override');
    const override = ctx.colOf(ctx.TX_COLUMNS, 'category_override');

    expect(f).toContain(`VLOOKUP($${sub}$2`);
    expect(f).toContain(ctx.childParentRange_());
    // category_override still wins: it is the only way to say "this parent,
    // and none of its children in particular".
    expect(f.indexOf(`$${override}$2`)).toBeLessThan(f.indexOf(`$${sub}$2`));
  });

  it('falls back to the cascade for a subcategory not on the tab yet', () => {
    // The dropdown allows a value off the list, so this is a normal state —
    // and blanking the category of every such row would empty the reports
    // over a spelling you were about to fix.
    const auto = ctx.colOf(ctx.TX_COLUMNS, 'category_auto');
    expect(ctx.categoryFormula()).toContain(`IFERROR(VLOOKUP`);
    expect(ctx.categoryFormula()).toContain(`),$${auto}$2`);
  });

  it('crosses the categories tab with VLOOKUP, which vectorises', () => {
    // INDEX returns one value inside an ARRAYFORMULA however tall its argument
    // is — the first row's answer repeated down the column, right on row 2 and
    // wrong everywhere else.
    expect(ctx.categoryFormula()).not.toContain('INDEX');
    expect(ctx.categoryColumnCopyFormula_('category')).toContain('ARRAYFORMULA');
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

  it('sums amount_base, not amount', () => {
    // Every report reads amount_base from day one. Summing `amount` here
    // would silently mix currencies into a single figure.
    const eur = ctx.colOf(ctx.TX_COLUMNS, 'amount_base');
    expect(f).toContain(`transactions!$${eur}$2:$${eur}`);
    expect(f).not.toContain('transactions!$G$2:$G');
  });

  it('derives an asset balance from its transactions too, not from the typed cell alone', () => {
    // What gives an asset a *history*. `balanceSeries_` walks transactions
    // backwards from today, so a value that only ever changed by being
    // overwritten was invisible to it: the curve was flat, and then the whole
    // line moved on the day the number was retyped.
    const manual = ctx.colOf(ctx.ACCOUNT_COLUMNS, 'balance_manual');
    const asset = f.slice(f.indexOf('"asset"'));

    expect(asset).toContain(`$${manual}$2:$${manual}`);
    expect(asset.slice(0, asset.indexOf('"cash"'))).toContain('SUMIF(transactions!');
  });

  it('guards both derived kinds against a blank starting cell', () => {
    // `N(x)` does not vectorise reliably inside ARRAYFORMULA, so a blank
    // opening cell would poison the addition with #VALUE! down the column.
    ['opening_balance', 'balance_manual'].forEach((name) => {
      const col = ctx.colOf(ctx.ACCOUNT_COLUMNS, name);
      expect(f, name).toContain(`IF($${col}$2:$${col}="",0,$${col}$2:$${col})`);
    });
  });
});

describe('seed data', () => {
  it('puts MCC rules above text rules, since MCC is language-independent', () => {
    // This numbering is the *only* thing arranging it. `readRules_` returns one
    // list ordered by priority and looks at nothing else, so an MCC rule
    // numbered into the text band would simply be tried after it — no error,
    // no warning, and a language-independent code losing to a substring.
    const mcc = ctx.DEFAULT_RULES.filter((r) => r[1] === 'mcc');
    const text = ctx.DEFAULT_RULES.filter((r) => r[1] === 'description');

    expect(mcc.length).toBeGreaterThan(0);
    expect(text.length).toBeGreaterThan(0);
    expect(Math.max(...mcc.map((r) => r[0]))).toBeLessThan(Math.min(...text.map((r) => r[0])));
  });

  it('leaves room below every rule for memory to be offered first', () => {
    // `memory_priority` ships at 5 and the cascade compares it against these
    // numbers, so a seed rule numbered below it would silently outrank your own
    // confirmed history on a book nobody had configured.
    const lowest = Math.min(...ctx.DEFAULT_RULES.map((r) => r[0]));
    expect(lowest).toBeGreaterThan(ctx.configNumber_({}, 'memory_priority'));
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

  /*
    Two seed names the viewer holds as literals rather than picking off a list
    the book sent — a copy of the seed with no handshake between them. Rename
    the seed row and the viewer goes on naming the old one with every test
    green: a revaluation refused as a category the book lacks, or a row labelled
    "Uncategorised" as though nothing had answered it. This is the handshake.
  */
  const viewerLiteral = (file, name) => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'app', file), 'utf8');
    const declared = source.match(new RegExp(`const ${name} = '([^']*)';`));
    expect(declared, `${file} no longer declares ${name}`).not.toBeNull();
    return declared[1];
  };

  it('seeds the valuation subcategory the viewer names, as a transfer rather than income', () => {
    // A €1,500 market gain moves net worth and is emphatically not income this
    // month. `in_reports` excludes transfers from every total.
    const seeded = ctx.DEFAULT_CATEGORIES.filter((row) => row[1] === viewerLiteral('Add.tsx', 'VALUATION_SUBCATEGORY'));
    expect(seeded).toHaveLength(1);
    expect(seeded[0][0]).toBe(viewerLiteral('Add.tsx', 'TRANSFER_CATEGORY'));
    expect(seeded[0][2]).toBe('transfer');
  });

  it('gives Other only the placeholder child the viewer hides', () => {
    const other = ctx.DEFAULT_CATEGORIES.filter((row) => row[0] === 'Other');
    expect(other.map((row) => row[1])).toEqual([viewerLiteral('Rows.tsx', 'PLACEHOLDER_SUBCATEGORY')]);
  });
});

describe('the menu', () => {
  /** Every declared entry, top level and submenus, as one flat list. */
  const declared = (ctx) => ctx.MENU_ITEMS
    .concat(...ctx.MENU_GROUPS.map((g) => g.items))
    .filter((i) => !i.separator);

  it('names only functions that exist, so nothing in it throws', () => {
    // The real invariant, now that every declared entry has landed. It used to
    // be checked by naming the phases that had not shipped, which stops proving
    // anything the moment the last one does — and would have gone on passing
    // for a menu that offered nothing at all.
    const fresh = load();
    fresh.onOpen();

    declared(fresh).forEach(({ name, fn }) => {
      expect(typeof fresh[fn], `${name} → ${fn}() is not defined`).toBe('function');
    });
  });

  it('shows every one of them somewhere', () => {
    const fresh = load();
    fresh.onOpen();

    const shown = fresh.__ui
      .reduce((all, m) => all.concat(m.items.filter((i) => !i.separator && i.fn)), [])
      .map((i) => i.name);

    declared(fresh).forEach(({ name }) => expect(shown, name).toContain(name));
  });

  /*
    The top level is what you do weekly; everything you do once is behind a
    submenu. It reached twenty entries, of which about six were the ones anyone
    opens in a normal week — and a menu that long is one you read rather than
    use.

    Checked by naming the two ends rather than by counting, because a count
    passes for any twenty items and says nothing about which twenty.
  */
  it('keeps setup, repair and diagnostics off the first screen', () => {
    const fresh = load();
    fresh.onOpen();

    const top = fresh.__ui.find((c) => c.title === 'Spendsheet').items.map((i) => i.name);

    expect(top).toContain('Sync now');
    expect(top).toContain('Open the app');
    expect(top).toContain('Confirm visible rows');

    ['Run smoke tests', 'Setup sheet', 'Install credentials', 'Accept row count',
      'Import staged rows', 'Rebuild charts'].forEach((name) => {
      expect(top, name).not.toContain(name);
    });
  });

  it('puts each of those in the submenu that says when you would want it', () => {
    const fresh = load();
    fresh.onOpen();
    const named = (title) =>
      fresh.__ui.find((c) => c.title === title).items.map((i) => i.name);

    expect(named('Diagnostics')).toContain('Run smoke tests');
    expect(named('Import')).toContain('Import staged rows');
    expect(named('Set up and maintain')).toContain('Setup sheet');
  });

  it('hangs all three off the menu, rather than building them and dropping them', () => {
    // `createMenu` records on creation, so a submenu shows up in `__ui` whether
    // or not anything attached it. Without this the test above would pass for a
    // build that composed three perfectly good submenus and never called
    // `addSubMenu` — which is a menu with six items in it and no way to reach
    // the other twenty.
    const fresh = load();
    fresh.onOpen();

    const top = fresh.__ui.find((c) => c.title === 'Spendsheet');
    expect(top.attached).toBe(true);
    expect(top.subMenus).toEqual(['Import', 'Set up and maintain', 'Diagnostics']);
  });

  it('has dropped the probe that wrote to the accounts tab', () => {
    // `diagnoseAccounts` was written for one incident — the code reporting
    // success while the sheet disagreed — and it answered it. What it left
    // behind was a menu item that writes a value into `accounts` and clears it
    // again, which is a thing to have while chasing that specific ghost and not
    // a thing to leave in a finance app's menu for ever.
    const fresh = load();
    expect(fresh.diagnoseAccounts).toBeUndefined();
    expect(declared(fresh).map((i) => i.fn)).not.toContain('diagnoseAccounts');
  });
});

/**
 * A global-scope project has no dead-code warning, and that is the whole of it.
 *
 * Apps Script concatenates `src/*.gs` into one scope, so a function nobody calls
 * is indistinguishable from one everybody calls — no import to go missing, no
 * linter to notice, no test that fails. Two accumulated: `diagnoseAccounts`,
 * a probe written for one incident that outlived it as a menu item writing to
 * `accounts`, and `ebDeleteSession`, which existed because the endpoint does.
 *
 * A name ending in `_` is exempt: those are private by convention and are
 * reached from anywhere in the concatenated scope, so "called once" says
 * nothing.
 */
describe('nothing public is left with no way to reach it', () => {
  const ENTRY_POINTS = ['onOpen', 'onEdit', 'doGet', 'doPost', 'setup'];

  it('names every public function in the menu or in a caller', () => {
    const ctx = load();
    const src = sourceFiles()
      .map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

    const reachable = new Set(ENTRY_POINTS.concat(
      ctx.MENU_ITEMS.concat(...ctx.MENU_GROUPS.map((g) => g.items))
        .filter((i) => !i.separator).map((i) => i.fn)));

    const orphans = [...src.matchAll(/^function ([A-Za-z0-9_]+)\(/gm)]
      .map((m) => m[1])
      .filter((name) => !name.endsWith('_'))
      .filter((name) => !reachable.has(name))
      // Defined once and named nowhere else in `src/` is the definition itself
      // and nothing more.
      .filter((name) => (src.match(new RegExp('\\b' + name + '\\b', 'g')) || []).length <= 1);

    expect(orphans).toEqual([]);
  });
});

/**
 * The forward reference, which is the one mechanism here built to fail quietly.
 *
 * File numbering is load order, so a lower file calling a higher one has to ask
 * first — `functionExists_('x') && x()`. That is deliberate and it works. What
 * it also does, by construction, is turn *deleting a file* into a live call
 * site that does nothing, passes every test, and reads at the call site as a
 * feature that still runs.
 *
 * It had already happened. `09_sync.gs` guarded a call to
 * `refreshCashflowQuietly_` for the whole of the time since `15_recurring.gs`
 * was removed, under three lines of comment asserting a post-sync invariant
 * that no longer held — so an agent asked to make the projection refresh after
 * a sync would read that, conclude it already did, and stop.
 *
 * Two tests already do exactly this for the two places names are held as
 * strings: `tests/triggers.test.mjs` for the trigger handlers and `the menu`
 * above for the menu items. Neither could see the inline guards, which are the
 * majority of them.
 */
describe('every forward reference points at something', () => {
  it('names only functions that exist, so no guard is permanently false', () => {
    const fresh = load();
    const src = sourceFiles().map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

    const guarded = [...src.matchAll(/functionExists_\(\s*'([A-Za-z0-9_]+)'\s*\)/g)]
      .map((m) => m[1]);

    // Not an empty-set trap: if the regex ever stops matching the call shape,
    // the assertion below passes over nothing and this is what notices.
    expect(guarded.length).toBeGreaterThan(5);

    const missing = [...new Set(guarded)].filter((name) => typeof fresh[name] !== 'function');
    expect(missing, `guarded call to a function that no longer exists`).toEqual([]);
  });
});

/**
 * A `_config` row is a promise on a tab the owner reads.
 *
 * The same two file deletions left `cashflow_horizon_days` and `trend_days`
 * seeded into every book, each with a description naming a feature that had
 * gone. A dead constant is invisible; a dead config row is offered to the
 * person using the sheet as something they can change.
 */
describe('every seeded config row is read by something', () => {
  it('has a reader in src/ for each key it seeds', () => {
    const ctx = load();
    const src = sourceFiles().map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

    // Two shapes count as a reader and both have to, because the codebase uses
    // both: `configNumber_(config, 'sync_window_days')` names the key as a
    // string, and `readConfig_().timezone` reaches it as a property. Matching
    // only the quoted form called three live keys dead. A bare word match
    // would be worse in the other direction — every one of these keys is also
    // discussed in a comment, so prose alone would count as use.
    //
    // The viewer reads the same `_config` off the book, so `web/src/` counts
    // too — all but `schema.ts`, whose `DEFAULT_CONFIG` is a copy of the seed
    // and would call every key read, and the tests.
    const WEB = join(SRC, '..', 'web', 'src');
    const viewer = readdirSync(WEB, { recursive: true })
      .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !f.endsWith('schema.ts'))
      .map((f) => readFileSync(join(WEB, f), 'utf8')).join('\n');
    const reads = (text, key) =>
      (text.match(new RegExp("'" + key + "'|\\." + key + "\\b", 'g')) || []).length;

    const unread = ctx.DEFAULT_CONFIG.map((row) => row[0])
      .filter((key) => reads(src, key) <= 1 && reads(viewer, key) === 0);

    expect(unread, 'seeded in _config and read by nothing').toEqual([]);
  });
});
