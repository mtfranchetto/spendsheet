/**
 * The BudgetBakers import.
 *
 * No spreadsheet can be evaluated here, so these tests do the two things that
 * are possible without one: check the formulas are structurally sound and
 * survive localisation, and check the mapping against the header and category
 * list of a **real export**. The second is the one that matters — the previous
 * version of this preset was written from imagination and four of its nine
 * rows were wrong.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

/**
 * The header line and category list of an actual export, recorded rather than
 * guessed. No transaction data — this is the file's shape, not its contents.
 *
 * The categories are every distinct one across **five years** of export —
 * 4,364 rows, Oct 2022 to Jul 2026, 67 categories. Two earlier versions of
 * this list are why it is recorded from the whole history rather than a
 * sample: twenty rows gave 36 categories, one year gave 57, and each time the
 * gap was made of things that happen once or twice a year. `Fines` appears
 * once in four years. So does a fine.
 */
const REAL_HEADERS = ['account', 'category', 'currency', 'amount', 'ref_currency_amount',
  'type', 'payment_type', 'note', 'date', 'transfer', 'payee', 'labels'];

const REAL_CATEGORIES = [
  'Active sport, fitness', 'Advisory', 'Alcohol, tobacco', 'Bar, cafe',
  'Books, audio, subscriptions', 'Charges, Fees', 'Charity, gifts', 'Child Support', 'Cleaning',
  'Clothes & Footwear', 'Communication, PC', 'Culture, sport events', 'Drug-store, chemist',
  'Education, development', 'Electronics, accessories', 'Energy, utilities',
  'Financial expenses', 'Fines', 'Food & Drinks', 'Fuel', 'Gifts', 'Gifts, joy', 'Groceries',
  'Health and beauty', 'Health care, doctor', 'Hobbies', 'Holiday, trips, hotels',
  'Home, garden', 'Housing', 'Income', 'Insurances', 'Interests, dividends', 'Internet',
  'Jewels, accessories', 'Kids', 'Leisure time', 'Life & Entertainment', 'Life events',
  'Long distance', 'Lottery, gambling', 'Maintenance, repairs', 'Missing', 'Mortgage', 'Others',
  'Parking', 'Pizza', 'Property insurance', 'Public transport', 'Refunds (tax, purchase)',
  'Rental income', 'Restaurant, fast-food', 'Sale', 'Services', 'Shopping',
  'Software, apps, games', 'Stationery, tools', 'TV, Streaming', 'Taxes',
  'Telephony, mobile phone', 'Transfer, withdraw', 'Transportation', 'Unknown expense',
  'Vehicle', 'Vehicle insurance', 'Vehicle maintenance', 'Wage, invoices', 'Wellness, beauty'
];

/**
 * Categories the export uses for money **coming in**. Everything else in the
 * file is an expense, apart from `Transfer, withdraw`, which is both.
 */
const INCOME_CATEGORIES = [
  'Child Support', 'Gifts', 'Income', 'Interests, dividends',
  'Refunds (tax, purchase)', 'Rental income', 'Sale', 'Wage, invoices'
];

const preset = (rows) => rows.filter((row) => row[0] === 'budgetbakers');

describe('the column preset', () => {
  it('names only headers that exist in a real export', () => {
    const unknown = preset(ctx.DEFAULT_IMPORT_MAP)
      .map((row) => row[1])
      .filter((header) => !REAL_HEADERS.includes(header));

    expect(unknown).toEqual([]);
  });

  it('targets only columns that exist in transactions', () => {
    const unknown = preset(ctx.DEFAULT_IMPORT_MAP)
      .map((row) => row[2])
      .filter((column) => !ctx.TX_COLUMNS.includes(column));

    expect(unknown).toEqual([]);
  });

  it('maps the four fields a transaction cannot do without', () => {
    const targets = preset(ctx.DEFAULT_IMPORT_MAP).map((row) => row[2]);
    ['booking_date', 'amount', 'account_name', 'description'].forEach((column) => {
      expect(targets).toContain(column);
    });
  });

  it('maps the type column, because the sign is not in the amount', () => {
    // Every exported amount is positive; direction lives in Expense/Income.
    // Without this row every expense would import as income.
    expect(preset(ctx.DEFAULT_IMPORT_MAP).map((row) => row[2])).toContain('type');
  });

  it('does not map transfer to transfer_group', () => {
    // The export flags that a row *is* a transfer without saying which other
    // row it pairs with. A group id built from it would be a guess dressed as
    // data — in a real export the two legs of one move were three days apart.
    const targets = preset(ctx.DEFAULT_IMPORT_MAP).map((row) => row[2]);
    expect(targets).not.toContain('transfer_group');
  });
});

describe('the category map', () => {
  it('covers every category in a real export', () => {
    const mapped = preset(ctx.DEFAULT_CATEGORY_MAP).map((row) => row[1]);
    const missing = REAL_CATEGORIES.filter((category) => !mapped.includes(category));

    expect(missing).toEqual([]);
  });

  it('only ever maps to a category that exists in the taxonomy', () => {
    // An override naming a category the dropdown does not have would be
    // invisible in every report that groups by it.
    const pairs = ctx.DEFAULT_CATEGORIES.map((row) => `${row[0]}|${row[1]}`);
    const unknown = preset(ctx.DEFAULT_CATEGORY_MAP)
      .map((row) => `${row[2]}|${row[3]}`)
      .filter((pair) => !pairs.includes(pair));

    expect(unknown).toEqual([]);
  });

  it('sends transfers to a category whose kind keeps them out of spending', () => {
    const transfer = preset(ctx.DEFAULT_CATEGORY_MAP)
      .filter((row) => /transfer|withdraw/i.test(row[1]))[0];
    const kind = ctx.DEFAULT_CATEGORIES
      .filter((row) => row[0] === transfer[2] && row[1] === transfer[3])[0][2];

    expect(kind).toBe('transfer');
  });

  it('leaves the uninformative categories uninformative', () => {
    // Missing / Unknown / Services / Others carry nothing. Inventing a
    // category for them would hide rows that deserve a look.
    ['Missing', 'Unknown expense', 'Services', 'Others'].forEach((source) => {
      const row = preset(ctx.DEFAULT_CATEGORY_MAP).filter((r) => r[1] === source)[0];
      expect(row.slice(2)).toEqual(['Other', 'Uncategorised']);
    });
  });

  it('files money coming in as income, not as spending', () => {
    // The one this caught: `Gifts` is a gift *received* and `Gifts, joy` is
    // the expense. Both used to land in Shopping/Gifts, so a year of presents
    // received counted as a year of presents bought — €9,400 on the wrong
    // side of the report, and nothing about the sheet would have looked odd.
    const kindOf = new Map(ctx.DEFAULT_CATEGORIES.map((c) => [`${c[0]}|${c[1]}`, c[2]]));
    const misfiled = preset(ctx.DEFAULT_CATEGORY_MAP)
      .filter((row) => INCOME_CATEGORIES.includes(row[1]))
      .filter((row) => kindOf.get(`${row[2]}|${row[3]}`) !== 'income')
      .map((row) => row[1]);

    expect(misfiled).toEqual([]);
  });

  it('has a home for a salary', () => {
    // Absent from the preset built off a 20-row sample, because a salary
    // arrives monthly and a sample of twenty rows is a fortnight.
    const row = preset(ctx.DEFAULT_CATEGORY_MAP).filter((r) => r[1] === 'Wage, invoices')[0];
    expect(row.slice(2)).toEqual(['Income', 'Salary']);
  });

  it('does not file a parent-level category under one of its children', () => {
    // `Food & Drinks` is BudgetBakers' parent of Groceries, Bar and
    // Restaurant. Mapping it to Groceries is not a rounding error — it moves
    // every uncategorised coffee into the weekly shop, and the weekly shop is
    // exactly the figure people check against their own memory.
    const map = new Map(preset(ctx.DEFAULT_CATEGORY_MAP).map((r) => [r[1], r.slice(2)]));

    expect(map.get('Food & Drinks')).toEqual(['Food & Drink', 'Other food & drink']);
    expect(map.get('Housing')).toEqual(['Housing', 'Other housing']);
    expect(map.get('Shopping')).toEqual(['Shopping', 'Other shopping']);
  });

  it('reads Long distance as flights, which is not what the name suggests', () => {
    // It sits under Transportation in their taxonomy, so it looks like
    // intercity rail. Every row of it across four years is EasyJet, Ryanair
    // or British Airways. The only reason that is known is that the rows were
    // looked at instead of the label, and Transport/Public transport would
    // have been a defensible, wrong answer nobody would have questioned.
    const map = new Map(preset(ctx.DEFAULT_CATEGORY_MAP).map((r) => [r[1], r.slice(2)]));
    expect(map.get('Long distance')).toEqual(['Life & Entertainment', 'Flights']);
  });

  it('keeps insurance out of Health', () => {
    // Property and vehicle cover are the bulk of it, and neither says
    // anything about health spending.
    const map = new Map(preset(ctx.DEFAULT_CATEGORY_MAP).map((r) => [r[1], r.slice(2)]));

    expect(map.get('Property insurance')).toEqual(['Insurance', 'Home insurance']);
    expect(map.get('Vehicle insurance')).toEqual(['Insurance', 'Vehicle']);
  });

  it('has no duplicate source categories', () => {
    const sources = preset(ctx.DEFAULT_CATEGORY_MAP).map((row) => row[1]);
    expect(new Set(sources).size).toBe(sources.length);
  });
});

/** A formula with its string literals removed — what Sheets reads as syntax. */
function outsideStrings(formula) {
  let out = '';
  let inString = false;
  for (const ch of formula) {
    if (ch === '"') inString = !inString;
    else if (!inString) out += ch;
  }
  return out;
}

/** Just the string literals, which localisation must leave untouched. */
function stringLiterals(formula) {
  return formula.match(/"[^"]*"/g) || [];
}

/** The comma-separated arguments of `NAME(...)`, ignoring nested calls and strings. */
function topLevelArgs(call) {
  const body = call.slice(call.indexOf('(') + 1, call.lastIndexOf(')'));
  const args = [];
  let depth = 0, cur = '', inString = false;

  for (const ch of body) {
    if (ch === '"') inString = !inString;
    if (!inString) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
    }
    cur += ch;
  }
  args.push(cur);
  return args;
}


/**
 * Every `INDEX(...)` whose *row* argument is a `MATCH(...)` on a per-row key.
 *
 * That shape does not vectorise. Inside an ARRAYFORMULA, INDEX handed an
 * array of row numbers keeps the first and discards the rest, so one row's
 * answer silently becomes the whole column's — and when that row happens to
 * miss, the column is simply empty.
 *
 * Two lookalikes are deliberately not flagged. `INDEX(range,0,MATCH(...))`
 * picks a whole column, and a MATCH on a quoted literal — how the column
 * preset resolves a header name — has a scalar key, evaluates once, and is
 * exactly what INDEX is for.
 */
function indexRowFromMatch(formula) {
  const hits = [];
  for (let i = 0; i < formula.length; i++) {
    if (!formula.startsWith('INDEX(', i)) continue;

    let depth = 0, j = i + 'INDEX'.length, inString = false;
    for (; j < formula.length; j++) {
      const ch = formula[j];
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }

    const args = topLevelArgs(formula.slice(i, j + 1));
    const row = args.length >= 2 ? args[1].trim() : '';
    if (!row.startsWith('MATCH(')) continue;

    const key = topLevelArgs(row)[0].trim();
    if (!key.startsWith('"')) hits.push(row.slice(0, 60));
  }
  return hits;
}

/** 1-based position of a column letter: A is 1, Z is 26, AA is 27. */
function letterIndex(letters) {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

/**
 * Every `QUERY(tab!$X$2:$Y,"…")` in a formula: the range's first and last
 * column, the query string, and the column letters it names.
 *
 * Only a literal query over a sheet range is read. A query string assembled
 * from cells, as `reports` does, cannot be checked without evaluating it.
 * Quoted values inside the query (`'enablebanking'`) are dropped before the
 * letters are collected, and keywords are lowercase in this codebase, so an
 * uppercase word of one or two letters is a column.
 */
function queryCalls(formula) {
  const calls = [];
  const pattern = /QUERY\([^,()"]*!\$([A-Z]+)\$\d+:\$([A-Z]+),"([^"]*)"/g;
  for (const [, first, last, query] of formula.matchAll(pattern)) {
    const bare = query.replace(/'[^']*'/g, "''");
    const letters = bare.match(/\b[A-Z]{1,2}\b/g) || [];
    calls.push({ first, last, query, letters });
  }
  return calls;
}

/**
 * Whether an expression evaluates to a boolean rather than a number.
 *
 * True when a comparison operator sits at the outermost level — outside every
 * bracket and every string literal — or when the whole thing is a literal.
 */
function yieldsBoolean(expr) {
  let depth = 0, inString = false;
  for (const ch of expr) {
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && '=<>'.includes(ch)) return true;
  }
  return /^(TRUE|FALSE)$/.test(expr.trim());
}

/**
 * Tab names in a formula that aren't followed by `!`.
 *
 * Longest names first, so `_import_raw` is consumed before a shorter name
 * could match inside it. Anything already followed by `!` or by another word
 * character is fine — the second is what stops `_import_map` being reported
 * because `_import_raw` was searched for first and missed.
 */
function danglingSheetRefs(formula) {
  const tabs = Object.values(ctx.TABS).sort((a, b) => b.length - a.length);
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = [];

  // Quoted text first, for the same reason localizeFormula is quote-aware: a
  // tab name inside a string literal is data. `MATCH("labels", …)` looks up a
  // *column* header called labels and has nothing to do with the tab of that
  // name — without this the check reports a reference that does not exist,
  // which is the one thing a guard against invisible bugs must never do.
  let rest = formula.replace(/"[^"]*"/g, '""');

  tabs.forEach((tab) => {
    rest = rest.replace(new RegExp(escape(tab) + '(?![\\w!])', 'g'), () => {
      found.push(tab);
      return '\u0000';
    });
    rest = rest.split(tab + '!').join('\u0000!');
  });
  return found;
}

describe('the staged formulas', () => {
  const formulas = ctx.stagedFormulas();

  it('covers every column code owns, and the category', () => {
    const columns = formulas.map((entry) => entry.column);
    ['uid', 'account_id', 'booking_date', 'amount', 'description', 'source', 'category_override']
      .forEach((column) => expect(columns).toContain(column));
  });


  it('looks up per-row values with something that vectorises', () => {
    // The bug this pins emptied account_id across every row while the names
    // it matched on sat in the next column looking perfectly correct. It
    // shipped green: nothing in a string test notices that INDEX quietly
    // keeps only the first of the row numbers handed to it.
    formulas.forEach(({ column, formula }) => {
      expect(indexRowFromMatch(formula), `${column} uses INDEX(...,MATCH(...))`).toEqual([]);
    });
  });

  it('reads the account id from a column left of the one it matches on', () => {
    // VLOOKUP cannot: account_id is column A and name is column B. An array
    // literal could, but localizeFormula rewrites its comma and turns two
    // columns into two rows.
    const accountId = formulas.filter((e) => e.column === 'account_id')[0].formula;
    expect(accountId).toContain('XLOOKUP(');
    expect(accountId).not.toContain('{');
  });

  it('makes include a boolean, because every other column compares it to TRUE', () => {
    // Sheets does not coerce a number to a boolean in a comparison: `1 = TRUE`
    // is FALSE there, where in Excel it is TRUE. Left as the bare product of
    // its two conditions, `include` returns 1, all twelve `= TRUE` tests miss,
    // and the tab renders blank with `include` showing 1 and `why` giving the
    // excluded-row reason — contradicting each other, which is the tell.
    const include = formulas.filter((e) => e.column === 'include')[0].formula;
    const body = include.replace(/^=ARRAYFORMULA\(/, '').replace(/\)$/, '');
    const value = topLevelArgs(body)[2];

    expect(yieldsBoolean(value), `include yields a number: ${value.slice(-40)}`).toBe(true);
  });

  it('names only columns inside the range each QUERY reads', () => {
    // A QUERY over a sheet range names columns by their sheet letters, so
    // every letter in its query string has to fall inside that range. A
    // letter counted from the start of the range lands outside it, the query
    // errors, and an IFERROR around it can hide that as an empty answer.
    formulas.forEach(({ column, formula }) => {
      queryCalls(formula).forEach(({ first, last, letters }) => {
        letters.forEach((letter) => {
          expect(letterIndex(letter), `${column}: QUERY over ${first}:${last} names ${letter}`)
            .toBeGreaterThanOrEqual(letterIndex(first));
          expect(letterIndex(letter), `${column}: QUERY over ${first}:${last} names ${letter}`)
            .toBeLessThanOrEqual(letterIndex(last));
        });
      });
    });
  });

  it('asks the cutoff for account, date and source by their sheet letters', () => {
    const include = formulas.filter((e) => e.column === 'include')[0].formula;
    const calls = queryCalls(include);
    const q = (name) => ctx.colOf(ctx.TX_COLUMNS, name);

    expect(calls.length).toBeGreaterThan(0);
    calls.forEach(({ first, query }) => {
      expect(first).toBe(q('account_id'));
      expect(query).toBe(
        `select ${q('account_id')}, min(${q('booking_date')}) where ${q('source')} = ` +
        `'${ctx.TX_SOURCE_API}' group by ${q('account_id')} label min(${q('booking_date')}) ''`);
    });
  });

  it('has every consumer of include test it the same way', () => {
    // One producer, twelve consumers. They have to agree about the type, and
    // the only reason they can drift is that nothing here evaluates anything.
    const consumers = formulas.filter((e) => e.column !== 'include' && e.column !== 'why');
    const q = ctx.colOf(ctx.STAGED_COLUMNS, 'include');

    consumers.forEach(({ column, formula }) => {
      expect(formula, `${column} does not gate on include`).toContain(`$${q}2:$${q}=TRUE`);
    });
  });

  it('follows every sheet name with a "!"', () => {
    // `_import_raw` + `$A$2:$A` reads fine at the call site and produces
    // `_import_raw$A$2:$A`, which Sheets cannot parse. It shipped that way and
    // every test passed — parentheses balanced, quotes balanced, localisation
    // clean — because none of them could tell a valid reference from an
    // invalid one. This is the cheapest check that can, and the symptom it
    // prevents is a whole row of "Formula parse error" with nothing to say
    // which of a dozen columns is at fault.
    formulas.forEach(({ column, formula }) => {
      expect(danglingSheetRefs(formula), `${column} references a sheet without "!"`).toEqual([]);
    });
  });

  it('builds formulas with balanced parentheses and quotes', () => {
    // Generated string concatenation is exactly where an unbalanced bracket
    // hides, and the symptom in Sheets is a parse error with no line number.
    formulas.forEach(({ column, formula }) => {
      const depth = [...formula].reduce((d, ch) =>
        ch === '(' ? d + 1 : ch === ')' ? d - 1 : d, 0);
      expect(depth, `${column} parentheses`).toBe(0);
      expect([...formula].filter((ch) => ch === '"').length % 2, `${column} quotes`).toBe(0);
    });
  });

  it('survives translation into a decimal-comma locale', () => {
    // Every argument separator must become `;`, and every comma *inside* a
    // string literal must not: `SUBSTITUTE(x,".","")` and the QUERY string
    // both carry commas that are data. Translating those would turn a working
    // formula into a parse error, and the category "Bar, cafe" into two
    // arguments.
    formulas.forEach(({ column, formula }) => {
      const italian = ctx.localizeFormula(formula, ';');

      expect(outsideStrings(italian), `${column}: separator commas left`).not.toContain(',');
      expect(outsideStrings(italian), `${column}: nothing translated`).toContain(';');
      expect(stringLiterals(italian), `${column}: literals altered`)
        .toEqual(stringLiterals(formula));
    });
  });

  it('takes the magnitude before applying the sign', () => {
    // The same load-bearing ABS as the API path: an export that ever emits a
    // negative amount and Expense would otherwise double-negate into income.
    const amount = formulas.filter((entry) => entry.column === 'amount')[0].formula;
    expect(amount).toContain('ABS(');
    expect(amount).toContain('"Expense"');
  });

  it('never parses a decimal string with VALUE', () => {
    // VALUE() reads the decimal separator from the spreadsheet's locale, so
    // VALUE("116.87") is not 116.87 everywhere. The parts either side of the
    // dot are integers, which every locale agrees on.
    const amount = formulas.filter((entry) => entry.column === 'amount')[0].formula;
    expect(amount).toContain('POWER(10,LEN(');
    expect(amount).toContain('FIND(".",');
  });

  it('strips the minus before splitting on the dot, and puts it back', () => {
    // Splitting "-116.87" on the dot gives "-116" and "87", which add to
    // -115.13 — off by 1.74 and in the direction of less debt. Nothing about
    // that number looks wrong on a screen of other numbers. BudgetBakers only
    // ever emits positives so it cannot fire there; a bank export that signs
    // its amounts is the first place it would.
    const amount = formulas.filter((entry) => entry.column === 'amount')[0].formula;

    expect(amount).toContain('SUBSTITUTE(SUBSTITUTE(');
    expect(amount).toContain('"-",""');
    expect(amount).toContain('LEFT(TRIM(TO_TEXT(');
  });

  it('falls back to the amount\'s own sign when the preset has no type column', () => {
    // What makes a second preset possible. Plenty of exports carry no
    // direction column and sign the amount instead; mapping `type` for those
    // would mean pointing it at a column that means something else.
    const amount = formulas.filter((entry) => entry.column === 'amount')[0].formula;
    expect(amount).toContain('IFERROR(IF(');
  });

  it('builds dates from their parts rather than parsing a string', () => {
    const date = formulas.filter((entry) => entry.column === 'booking_date')[0].formula;
    expect(date).toContain('DATE(VALUE(LEFT(');
    expect(date).not.toContain('DATEVALUE');
  });

  it('gives imported rows a readable key rather than a hash', () => {
    // Cross-source dedup cannot work — an imported row and the same
    // transaction from the bank share no stable field — so a hash buys
    // nothing that a key you can read does not.
    const uid = formulas.filter((entry) => entry.column === 'uid')[0].formula;
    expect(uid).toContain('"csv:"');
    expect(uid).toContain('ROW(');
  });

  it('blanks the data of an excluded row, not just its flag', () => {
    // So the whole block can be copied without first remembering to filter.
    const description = formulas.filter((entry) => entry.column === 'description')[0].formula;
    expect(description).toContain(`$${ctx.colOf(ctx.STAGED_COLUMNS, 'include')}2:`);
    expect(description).toContain('=TRUE,');
  });
});

describe('the staged tab', () => {
  const c = load();
  c.setup();
  const staged = c.__spreadsheet.getSheetByName('_import_staged');

  it('holds only columns an export can fill, in transactions order', () => {
    // It no longer mirrors A–O — `importStagedRows` writes by name, so the
    // alignment that justified five always-empty columns bought nothing. What
    // has to hold is that every column is one `transactions` knows, and that
    // they stay in its order, because reading the two side by side is how a
    // mapping gets checked.
    const headers = staged.headers().filter((h) => h !== 'include' && h !== 'why');
    expect(headers).toEqual(c.TX_COLUMNS.filter((name) => headers.includes(name)));
  });

  it('stages no column that no export carries', () => {
    // The five that went. Each is a bank field an export has never had, and
    // `value_date` was being filled with a copy of `booking_date` purely to
    // keep the block contiguous.
    ['value_date', 'transaction_date', 'entry_reference', 'bank_transaction_code', 'mcc']
      .forEach((name) => {
        expect(c.STAGED_COLUMNS, `${name} is staged but nothing fills it`).not.toContain(name);
      });
  });

  it('offers no by-hand paste route alongside the menu item', () => {
    // The cell that used to spell out both paste targets. It described the one
    // procedure with four silent ways to corrupt an append-only tab, and it
    // could not skip rows already imported the way the menu item does.
    expect(c.stagedInstructionsFormula).toBeUndefined();
    for (let col = 1; col <= c.STAGED_COLUMNS.length + 4; col++) {
      expect(staged.getRange(1, col).getFormula()).toBe('');
    }
  });

  it('seeds the category map so an import has something to map through', () => {
    expect(c.readColumn_(c.__spreadsheet.getSheetByName('_category_map'), 1).length)
      .toBe(c.DEFAULT_CATEGORY_MAP.length);
  });
});

/**
 * Committing the staged rows.
 *
 * The formulas above decide *what* imports; this decides what lands in
 * `transactions`. The two failure modes worth pinning are the ones the manual
 * paste could not defend against: a block wide enough to cross the
 * `amount_base` ARRAYFORMULA, and a second run duplicating the first.
 */
describe('importing the staged rows', () => {
  /** A staged tab with `n` importable rows, bypassing the formulas. */
  function staged(c, rows) {
    const sheet = c.__spreadsheet.getSheetByName('_import_staged');
    const width = c.STAGED_COLUMNS.length;
    const values = rows.map((row) =>
      c.STAGED_COLUMNS.map((name) => (name in row ? row[name] : '')));
    sheet.getRange(2, 1, values.length, width).setValues(values);
    return sheet;
  }

  function row(i, over = {}) {
    return {
      uid: `csv:budgetbakers:b1#${i}`,
      account_id: 'revolut',
      account_name: 'Revolut',
      booking_date: new Date(2024, 0, i),
      amount: -10 - i,
      currency: 'EUR',
      description: `Row ${i}`,
      source: 'csv:budgetbakers',
      category_override: 'Food & Drink',
      include: true,
      ...over
    };
  }

  it('appends the rows and files the category in the column that owns it', () => {
    const c = load();
    c.setup();
    staged(c, [row(2), row(3)]);

    const result = c.importStagedRows();
    const tx = c.__spreadsheet.getSheetByName('transactions');

    expect(result.imported).toBe(2);
    expect(tx.getRange('A2').getValue()).toBe('csv:budgetbakers:b1#2');
    expect(tx.getRange(2, c.colIndex_(c.TX_COLUMNS, 'category_override')).getValue())
      .toBe('Food & Drink');
  });

  it('never writes across amount_base, which is a formula it would destroy', () => {
    const c = load();
    c.setup();
    const before = c.__spreadsheet.getSheetByName('transactions')
      .getRange(2, c.colIndex_(c.TX_COLUMNS, 'amount_base')).getFormula();
    expect(before).toContain('ARRAYFORMULA');

    staged(c, [row(2)]);
    c.importStagedRows();

    expect(c.__spreadsheet.getSheetByName('transactions')
      .getRange(2, c.colIndex_(c.TX_COLUMNS, 'amount_base')).getFormula()).toBe(before);
  });

  it('imports nothing on a second run, which a double paste could not manage', () => {
    const c = load();
    c.setup();
    staged(c, [row(2), row(3)]);

    expect(c.importStagedRows().imported).toBe(2);
    const again = c.importStagedRows();

    expect(again.imported).toBeUndefined();
    expect(again.error).toMatch(/already in transactions/);
    expect(c.lastRecordRow_(c.__spreadsheet.getSheetByName('transactions'), 1)).toBe(3);
  });

  it('leaves excluded rows where they are', () => {
    const c = load();
    c.setup();
    staged(c, [row(2), row(3, { include: false, why: 'already covered by the API' })]);

    expect(c.importStagedRows().imported).toBe(1);
  });

  it('imports nothing at all when the answer is no', () => {
    const c = load({ alertResponse: 'NO' });
    c.setup();
    staged(c, [row(2), row(3)]);

    c.importStagedRows();
    expect(c.lastRecordRow_(c.__spreadsheet.getSheetByName('transactions'), 1)).toBe(1);
  });

  it('warns about rows whose account name matched nothing', () => {
    // They would import unattached, and nothing downstream would say so.
    const c = load();
    c.setup();
    staged(c, [row(2, { account_id: '', account_name: 'Sara' })]);

    const plan = c.planStagedImport_();
    expect(plan.missingAccount).toBe(1);
    expect(c.describeStagedPlan_(plan)).toMatch(/no account_id/);
  });

  it('says which batch to change when every row looks imported', () => {
    // The uid carries import_batch, so reusing it makes a second file look
    // like the first one all over again.
    const c = load();
    c.setup();
    staged(c, [row(2)]);
    c.importStagedRows();

    expect(c.planStagedImport_().error).toMatch(/import_batch/);
  });
});
