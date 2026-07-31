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
 */
const REAL_HEADERS = ['account', 'category', 'currency', 'amount', 'ref_currency_amount',
  'type', 'payment_type', 'note', 'date', 'transfer', 'payee', 'labels'];

const REAL_CATEGORIES = [
  'Bar, cafe', 'Books, audio, subscriptions', 'Charges, Fees', 'Child Support', 'Cleaning',
  'Clothes & Footwear', 'Culture, sport events', 'Drug-store, chemist', 'Education, development',
  'Electronics, accessories', 'Energy, utilities', 'Food & Drinks', 'Fuel', 'Gifts', 'Gifts, joy',
  'Groceries', 'Health and beauty', 'Holiday, trips, hotels', 'Home, garden', 'Insurances',
  'Life & Entertainment', 'Missing', 'Mortgage', 'Parking', 'Pizza', 'Public transport',
  'Refunds (tax, purchase)', 'Restaurant, fast-food', 'Services', 'Software, apps, games',
  'TV, Streaming', 'Telephony, mobile phone', 'Transfer, withdraw', 'Unknown expense',
  'Vehicle', 'Wellness, beauty'
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
    // Missing / Unknown / Services carry nothing. Inventing a category for
    // them would hide rows that deserve a look.
    ['Missing', 'Unknown expense', 'Services'].forEach((source) => {
      const row = preset(ctx.DEFAULT_CATEGORY_MAP).filter((r) => r[1] === source)[0];
      expect(row.slice(2)).toEqual(['Other', 'Uncategorised']);
    });
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

describe('the staged formulas', () => {
  const formulas = ctx.stagedFormulas();

  it('covers every column code owns, and the category', () => {
    const columns = formulas.map((entry) => entry.column);
    ['uid', 'account_id', 'booking_date', 'amount', 'description', 'source', 'category_override']
      .forEach((column) => expect(columns).toContain(column));
  });

  it('builds formulas with balanced parentheses and quotes', () => {
    // Generated string concatenation is exactly where an unbalanced bracket
    // hides, and the symptom in Sheets is a parse error with no line number.
    formulas.concat([{ column: 'instructions', formula: ctx.stagedInstructionsFormula() }])
      .forEach(({ column, formula }) => {
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

  it('puts the pasteable block first, ending where code ownership ends', () => {
    expect(staged.headers().slice(0, c.TX_COLUMNS_CODE.length)).toEqual(c.TX_COLUMNS_CODE);
    expect(c.colOf(c.STAGED_COLUMNS, 'imported_at')).toBe(c.colOf(c.TX_COLUMNS, 'imported_at'));
  });

  it('says exactly where to paste, computed rather than counted by eye', () => {
    const instructions = staged.getRange(1, c.STAGED_COLUMNS.length + 2).getFormula();
    expect(instructions).toContain('transactions!A');
    expect(instructions).toContain('COUNTA');
    // amount_eur is an ARRAYFORMULA a pasted blank would destroy.
    expect(instructions).toContain('never paste over P');
  });

  it('seeds the category map so an import has something to map through', () => {
    expect(c.readColumn_(c.__spreadsheet.getSheetByName('_category_map'), 1).length)
      .toBe(c.DEFAULT_CATEGORY_MAP.length);
  });
});
