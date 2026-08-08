/**
 * The dashboard, the reports tab, and the charts on both.
 *
 * Almost everything here is a formula, and **the harness never hands a formula
 * to a spreadsheet.** It cannot tell a working idiom from one that merely looks
 * like it, which is how five bugs have already shipped green: the locale
 * `#ERROR!`, a missing `!`, `1` not equalling `TRUE`, `INDEX` not vectorising
 * inside `ARRAYFORMULA`, and a too-wide `setValues`.
 *
 * So these are the things a string test *can* prove, and each one is here
 * because the corresponding mistake has been made:
 *
 *   - every sheet reference carries its `!`
 *   - every formula survives translation into a decimal-comma locale
 *   - no array literal, which that translation would turn into a column
 *   - a QUERY's range starts at column A, since its letters are relative to it
 *   - a boolean is compared as a boolean, never as the string "TRUE"
 *
 * The rest — that Sheets accepts any of it — belongs to `runSmokeTests()`,
 * which reads the computed values back out of the live book.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

/**
 * Strip quoted text, then look for what should not be there.
 *
 * A QUERY's query string is one long literal full of commas that are *data*.
 * Checking the raw formula for commas would fail on every one of them.
 */
const outsideQuotes = (formula) => formula.replace(/"[^"]*"/g, '""');

const ALL_FORMULAS = () => [
  ['inReports', ctx.inReportsFormula()],
  ['labelCount', ctx.labelCountFormula()],
  ['labelTotal', ctx.labelTotalFormula()],
  ['periodFrom', ctx.periodBoundFormula_('from')],
  ['periodTo', ctx.periodBoundFormula_('to')],
  ['groupedQuery', ctx.groupedQueryStringFormula()],
  ['monthlyQuery', ctx.monthlyQueryStringFormula()],
  ['yearToDate', ctx.yearToDateSpendFormula_(0)],
  ['lastYearToDate', ctx.yearToDateSpendFormula_(-1)],
  ['monthKey', ctx.monthKeyFormula_()]
];

describe('every generated formula', () => {
  const all = ALL_FORMULAS();

  it('follows every sheet name with a "!"', () => {
    const tabs = Object.values(ctx.TABS).sort((a, b) => b.length - a.length);
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    all.forEach(([name, formula]) => {
      let rest = outsideQuotes(formula);
      const dangling = [];

      tabs.forEach((tab) => {
        rest = rest.replace(new RegExp(escape(tab) + '(?![\\w!])', 'g'), () => {
          dangling.push(tab);
          return '~';
        });
        rest = rest.split(tab + '!').join('~!');
      });

      expect(dangling, `${name} references a sheet without "!"`).toEqual([]);
    });
  });

  it('survives translation into a decimal-comma locale', () => {
    all.forEach(([name, formula]) => {
      const localized = ctx.localizeFormula(formula, ';');
      expect(outsideQuotes(localized), `${name} kept a comma`).not.toContain(',');
    });
  });

  it('leaves the commas inside a query string alone', () => {
    // They are data. Rewriting one turns a select list into a single column
    // name with a semicolon in it, which is the locale bug wearing a hat.
    [ctx.groupedQueryStringFormula(), ctx.monthlyQueryStringFormula()]
      .forEach((formula) => {
        expect(ctx.localizeFormula(formula, ';')).toContain('select ');
      });
  });

  it('builds balanced parentheses and quotes', () => {
    all.forEach(([name, formula]) => {
      const depth = [...formula].reduce((d, ch) => (ch === '(' ? d + 1 : ch === ')' ? d - 1 : d), 0);
      expect(depth, `${name} parentheses`).toBe(0);
      expect([...formula].filter((ch) => ch === '"').length % 2, `${name} quotes`).toBe(0);
    });
  });

  it('uses no array literal, which localisation would turn into a column', () => {
    // `{a,b}` is a row; localizeFormula rewrites the comma to `;`, which makes
    // it a column. Anything built that way is unusable in a decimal-comma
    // locale, so nothing here is built that way.
    all.forEach(([name, formula]) => {
      expect(formula, `${name} uses an array literal`).not.toMatch(/\{[^}]*,/);
    });
  });

  it('starts every QUERY range at column A', () => {
    // QUERY names columns by position *within the range given*, not by their
    // address on the sheet. A range starting anywhere else shifts every letter
    // in every query at once, silently.
    expect(ctx.txQueryRange_()).toContain('!$A$2:$');
  });
});

describe('in_reports', () => {
  const formula = () => ctx.inReportsFormula();

  it('answers with a boolean on every row, including the empty ones', () => {
    // QUERY infers a column's type from what is in it, and an ARRAYFORMULA
    // spills to the *sheet's* last row rather than the last record. Thirty
    // booleans among nine hundred empty strings is a text column, and
    // `= true` would then match nothing — on the newest books, which are
    // exactly the ones where a blank dashboard reads as "not set up yet".
    expect(formula()).toContain('=0,FALSE,');
    expect(formula()).not.toContain('=0,"",');
  });

  it('ends in a comparison, so it yields TRUE and not 1', () => {
    // Sheets does not coerce across types: `=1=TRUE` is FALSE here where it is
    // TRUE in Excel. An expression built by multiplying two tests yields 1, and
    // every column gated on it blanks.
    expect(formula()).toContain('<>"transfer"');
    expect(formula()).not.toMatch(/\)\*\(/);
  });

  it('compares excluded to TRUE rather than measuring its length', () => {
    // LEN(FALSE) is 5, so an *unticked* checkbox would exclude the row.
    const excluded = ctx.colOf(ctx.TX_COLUMNS, 'excluded');
    expect(formula()).toContain(`$${excluded}$2:$${excluded}=TRUE`);
  });

  it('was appended rather than slotted in, and has stayed put since', () => {
    // Inserting mid-schema renames headers without moving the data underneath.
    // It is no longer the last column — subcategory_override was appended
    // after it — and that is the point: appending is what leaves AC alone.
    expect(ctx.colOf(ctx.TX_COLUMNS, 'in_reports')).toBe('AC');
    expect(ctx.TX_COLUMNS.indexOf('in_reports'))
      .toBeGreaterThan(ctx.TX_COLUMNS.indexOf('confirmed'));
  });

  it('is what every money block filters on, instead of each inventing its own', () => {
    const column = ctx.colOf(ctx.TX_COLUMNS, 'in_reports');

    [ctx.groupedQueryStringFormula(),
      ctx.monthlyQueryStringFormula()].forEach((formula) => {
      expect(formula).toContain(`${column} = true`);
      // The condition it replaced. Six blocks each re-deciding what spending
      // is, and one of them honoured `excluded`.
      expect(formula).not.toContain("<> 'transfer'");
    });

    [ctx.yearToDateSpendFormula_(0),
      ctx.labelCountFormula(), ctx.labelTotalFormula()].forEach((formula) => {
      expect(formula).toContain(ctx.txRange_('in_reports') + ',TRUE');
    });
  });
});

describe('the assembled report query', () => {
  it('contributes no clause at all for a filter set to All', () => {
    // Which is what makes the visible cell worth looking at: an empty report
    // has a cause you can read.
    const query = ctx.groupedQueryStringFormula();
    expect(query).toContain('IF($B$4="All",""');
    expect(query).toContain('IF($B$7="All",""');
  });

  it('matches a label by substring, since the column holds a list', () => {
    expect(ctx.groupedQueryStringFormula())
      .toContain(`${ctx.colOf(ctx.TX_COLUMNS, 'labels')} contains`);
  });

  it('groups by exactly the columns the dropdown offers', () => {
    const group = ctx.groupColumnExpression_();
    ctx.REPORT_GROUPS.forEach((entry) => {
      expect(group).toContain(`"${entry.label}","${ctx.colOf(ctx.TX_COLUMNS, entry.column)}"`);
    });
  });

  it('offers no period the bound formulas cannot resolve', () => {
    const from = ctx.periodBoundFormula_('from');
    const to = ctx.periodBoundFormula_('to');
    ctx.REPORT_PERIODS.forEach((period) => {
      expect(from).toContain(`"${period.label}"`);
      expect(to).toContain(`"${period.label}"`);
    });
  });

  /**
   * This test used to require the opposite, and was wrong.
   *
   * It asserted `month(D)+1` in the select against `month(D)` in the group by,
   * and named that arrangement deliberate. Google rejects the query whole: a
   * non-aggregate select expression has to appear in the group by verbatim.
   * The block never once produced a row, and the test defended it.
   */
  it('selects the same month expression it groups by', () => {
    const date = ctx.colOf(ctx.TX_COLUMNS, 'booking_date');
    const monthly = ctx.monthlyQueryStringFormula();
    expect(monthly).toContain(`month(${date}), sum(`);
    expect(monthly).toContain(`group by year(${date}), month(${date})`);
    expect(monthly).not.toContain(`month(${date})+1`);
  });

  it('caps the grouped result, so a chart of four hundred merchants is not offered', () => {
    expect(ctx.groupedQueryStringFormula()).toContain(`limit ${ctx.REPORT.LIMIT}`);
  });

  it('asks both blocks the same question', () => {
    // Written twice, they would eventually disagree about what is being
    // looked at, and the disagreement would be invisible.
    const shared = ctx.reportFilterExpression_();
    expect(ctx.groupedQueryStringFormula()).toContain(shared);
    expect(ctx.monthlyQueryStringFormula()).toContain(shared);
  });
});

describe('the charts', () => {
  const c = load();
  c.setup();
  const reports = c.__spreadsheet.getSheetByName('reports');

  /*
    Two, and only on `reports`. There were three more on a `dashboard` tab,
    which the mobile app replaced — see `git log -- src/16_dashboard.gs`.
  */
  it('builds two, on the one tab that still plots anything', () => {
    expect(reports.getCharts()).toHaveLength(2);
  });

  it('points every one at a range that something writes to', () => {
    // A chart is configuration pointed at a range. Pointed at an empty one it
    // draws nothing, forever, and says nothing about why.
    reports.getCharts().forEach((chart) => {
      chart.ranges.forEach((a1) => {
        const [start] = a1.split(':');
        const cell = reports.getRange(start);
        expect(cell.getFormula() || cell.getValue(), `${chart.options.title} reads ${a1}`)
          .not.toBe('');
      });
    });
  });

  it('does not stack another copy on every setup()', () => {
    // An EmbeddedChart has no id, so there is no way to recognise one on a
    // later run — which is why they are built once and rebuilt only on request.
    c.setup();
    c.setup();
    expect(c.__spreadsheet.getSheetByName('reports').getCharts()).toHaveLength(2);
  });

  it('leaves a chart you removed alone, until you ask for the defaults back', () => {
    const moved = load();
    moved.setup();
    const sheet = moved.__spreadsheet.getSheetByName('reports');
    sheet.getCharts().forEach((chart) => sheet.removeChart(chart));

    moved.setup();
    expect(sheet.getCharts()).toHaveLength(0);

    moved.rebuildCharts();
    expect(sheet.getCharts()).toHaveLength(2);
  });

  it('changes nothing when you say no to the rebuild', () => {
    const said = load({ alertResponse: 'NO' });
    said.setup();
    const sheet = said.__spreadsheet.getSheetByName('reports');
    sheet.removeChart(sheet.getCharts()[0]);

    said.rebuildCharts();
    expect(sheet.getCharts()).toHaveLength(1);
  });
});

describe('what the sheet tells you to do', () => {
  it('offers each parent category once, not once per subcategory', () => {
    const c = load();
    const formula = c.categoryParentsFormula();

    expect(formula).toContain('UNIQUE');
    // FILTER, not a bare UNIQUE: the column is open-ended, so without it the
    // list ends in a blank entry for every empty row on the tab.
    expect(formula).toContain('FILTER');
    expect(formula).toContain('$A$2:$A');
  });

  it('points every category dropdown at that one column', () => {
    const c = load();
    c.setup();

    const column = c.colOf(c.CATEGORY_COLUMNS, 'parent_list');
    const list = c.categoryListRange_(c.__spreadsheet).getA1Notation();
    expect(list.startsWith(column + '2:' + column)).toBe(true);
  });

  it('says how to mark a transfer, on the column where you would mark one', () => {
    const c = load();
    c.setup();

    const tx = c.__spreadsheet.getSheetByName('transactions');
    const note = tx.getRange(c.colOf(c.TX_COLUMNS, 'category_override') + '1').getNote();
    expect(note).toContain('Transfer');

    const review = c.__spreadsheet.getSheetByName('review');
    expect(review.getRange(c.colOf(c.REVIEW_COLUMNS, 'category_override') + '1').getNote())
      .toContain('Transfer');
  });



});

describe('the smoke tests for this phase', () => {
  /*
    This used to check **tabs** and that is exactly how it missed.

    `categories` was in the anchor list, so the assertion passed — while three
    of that tab's four anchors were unwatched. A book where all four had
    stopped spilling reported one broken formula and an otherwise clean bill of
    health, and `child_list`, `child_key` and `child_parent` went on being
    blank: every subcategory dropdown in the book, and the pair
    `categoryFormula` crosses to turn a subcategory override into its parent.

    So the invariant is now per **cell**, and stated from the sheet rather than
    from either list: after a real `setup()`, any formula sitting in row 2 is
    one this project put there, and every one of them must be watched. That
    holds whoever adds the next formula and wherever they add it.
  */
  it('watches every row-2 formula setup wrote, not merely every tab', () => {
    const c = load();
    c.setup();

    const watched = new Set(c.formulaAnchors_().map(([tab, a1]) => tab + '!' + a1));

    // Three tabs where a row-2 formula is not a schema anchor:
    //
    //   `_import_staged` is scratch, rebuilt whole on every run, so nothing can
    //   sit under one of its formulas long enough to matter.
    //   `reports` is a layout rather than a schema and lists its own by address.
    //   `cash_entry` A2 is a lone `=TODAY()` on the row you type into — a
    //   convenience default, not an array, and overwriting it is the point.
    const SKIP = new Set(['_import_staged', 'reports', 'cash_entry']);

    const found = [];
    c.__spreadsheet.getSheets().forEach((sheet) => {
      const name = sheet.getName();
      if (SKIP.has(name)) return;

      const width = sheet.getLastColumn();
      if (width < 1) return;

      sheet.getRange(2, 1, 1, width).getFormulas()[0].forEach((formula, i) => {
        if (formula) found.push(name + '!' + c.columnLetter(i + 1) + '2');
      });
    });

    expect(found.length).toBeGreaterThan(10);
    found.forEach((cell) => expect(watched, cell + ' has no anchor').toContain(cell));
  });

  it('watches all four of the categories anchors, which is the one that bit', () => {
    const c = load();
    const anchors = c.formulaAnchors_()
      .filter(([tab]) => tab === 'categories')
      .map(([, a1]) => a1);

    ['parent_list', 'child_list', 'child_key', 'child_parent'].forEach((column) => {
      expect(anchors, column).toContain(c.colOf(c.CATEGORY_COLUMNS, column) + '2');
    });
  });

  it('reports an anchor whose formula was deleted, not just one that errored', () => {
    // A `setValues` one column too wide silently deletes an ARRAYFORMULA, and
    // the symptom is a cell holding nothing — which reads as "no data yet".
    const c = load();
    c.setup();
    expect(c.brokenFormulaCells_()).toEqual([]);

    const column = c.colOf(c.TX_COLUMNS, 'in_reports');
    c.__spreadsheet.getSheetByName('transactions').getRange(column + '2').setValue('');

    expect(c.brokenFormulaCells_()).toEqual([
      expect.stringContaining('transactions!' + column + '2')
    ]);
  });

  /**
   * `#ERROR!` and `#REF!` land in the same check and need opposite repairs —
   * one is a broken formula, the other a formula that is fine with something
   * sitting in the column under it. Reporting only the cell reference sent a
   * column-alignment failure to be fixed as a locale bug, twice.
   */
  it('says which error an anchor is showing, not just that it errored', () => {
    const c = load();
    c.setup();

    const column = c.colOf(c.TX_COLUMNS, 'category');
    const cell = c.__spreadsheet.getSheetByName('transactions').getRange(column + '2');
    c.__spreadsheet.formulaResults.set(cell.getFormula(), '#REF!');

    expect(c.brokenFormulaCells_()).toEqual([
      expect.stringContaining('transactions!' + column + '2 #REF!')
    ]);
  });

  it('refuses a text in_reports column, which is what would empty every report', () => {
    const c = load();
    c.setup();

    const sheet = c.__spreadsheet.getSheetByName('transactions');
    const formula = sheet.getRange(c.colOf(c.TX_COLUMNS, 'in_reports') + '2').getFormula();
    c.__spreadsheet.formulaResults.set(formula, 'TRUE');

    expect(() => c.describeInReports_()).toThrow(/not a boolean/);

    c.__spreadsheet.formulaResults.set(formula, false);
    expect(c.describeInReports_()).toContain('no transactions yet');
  });

  it('names the cell that stopped the column expanding', () => {
    // #REF! in the anchor of an ARRAYFORMULA means one thing — something is in
    // the way — and Sheets says which cell in a tooltip you cannot hover on a
    // phone. A column you added yourself at the position the schema later grew
    // into is the case this exists for.
    const c = load();
    c.setup();

    const sheet = c.__spreadsheet.getSheetByName('transactions');
    const column = c.colOf(c.TX_COLUMNS, 'in_reports');
    c.__spreadsheet.formulaResults.set(sheet.getRange(column + '2').getFormula(), '#REF!');

    expect(() => c.describeInReports_()).toThrow(/Nothing below it is blocking/);

    sheet.getRange(column + '9').setValue('my note');
    expect(() => c.describeInReports_()).toThrow(
      new RegExp(column + '9 holds the text "my note"'));
  });

  it('says whether the blocker is a boolean or the text that prints like one', () => {
    // `'' + false` and `'' + 'false'` are the same four characters, and they
    // mean opposite things: ours frozen into values, versus something typed.
    const c = load();
    c.setup();

    const sheet = c.__spreadsheet.getSheetByName('transactions');
    const column = c.colOf(c.TX_COLUMNS, 'in_reports');
    c.__spreadsheet.formulaResults.set(sheet.getRange(column + '2').getFormula(), '#REF!');

    sheet.getRange(column + '3').setValue(false);
    expect(() => c.describeInReports_()).toThrow(/holds the boolean false/);

    sheet.getRange(column + '3').setValue('false');
    expect(() => c.describeInReports_()).toThrow(/holds the text "false"/);
  });

  it('counts how far the blockage runs, so one stray paste reads differently', () => {
    const c = load();
    c.setup();

    const sheet = c.__spreadsheet.getSheetByName('transactions');
    const column = c.colOf(c.TX_COLUMNS, 'in_reports');
    c.__spreadsheet.formulaResults.set(sheet.getRange(column + '2').getFormula(), '#REF!');

    sheet.getRange(column + '5').setValue(false);
    sheet.getRange(column + '6').setValue(false);
    expect(() => c.describeInReports_()).toThrow(/2 of the \d+ cells below/);
  });

  it('names a chart with nothing behind it', () => {
    // A chart pointed at nothing draws nothing, forever, and says nothing
    // about why — which is indistinguishable from a quiet month.
    const c = load();
    c.setup();
    expect(c.chartsInBook_()).toHaveLength(2);

    const empty = c.emptyCharts_();
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.join(' ')).toContain('reports');
  });
});

describe('the reports tab', () => {
  const c = load();
  c.setup();
  const reports = c.__spreadsheet.getSheetByName('reports');

  it('shows the query it is about to run', () => {
    // The single most useful thing on the tab: an empty report has a visible
    // cause. This is the formula a unit test cannot execute, so it is the one
    // that gets a cell of its own.
    const query = reports.getRange('E' + c.REPORT.QUERY_ROW).getFormula();
    expect(query).toContain('select ');
    expect(reports.getRange('A' + c.REPORT.RESULT_ROW).getFormula())
      .toContain('$E$' + c.REPORT.QUERY_ROW);
  });

  it('gives every filter a dropdown, so it works on a phone', () => {
    // Custom menus, sidebars and dialogs do not exist in the Sheets mobile
    // app. Data validation does.
    const validations = reports.calls.filter((call) => call.kind === 'validation');
    expect(validations.length).toBeGreaterThanOrEqual(c.REPORT_FILTERS.length);
  });

  it('defaults to this month, and never overwrites what you picked', () => {
    expect(reports.getRange('B' + c.REPORT.FILTER_ROW).getValue()).toBe('This month');

    reports.getRange('B' + c.REPORT.FILTER_ROW).setValue('Last year');
    c.setup();
    expect(reports.getRange('B' + c.REPORT.FILTER_ROW).getValue()).toBe('Last year');
  });

  it('builds its dropdown lists from two cells rather than an array literal', () => {
    // `{"All"; accounts!B2:B}` would be one cell and unusable: localizeFormula
    // rewrites the comma, which turns a row literal into a column one.
    Object.values(c.REPORT.LIST_COL).forEach((column) => {
      expect(reports.getRange(column + '2').getValue()).toBe('All');
      expect(reports.getRange(column + '3').getFormula()).toContain('FILTER(');
    });
  });

  it('is rebuilt identically on a second setup()', () => {
    const before = reports.snapshot();
    c.setup();
    expect(c.__spreadsheet.getSheetByName('reports').snapshot()).toEqual(before);
  });
});

/**
 * `recent` — the view that exists because `transactions` is never sorted.
 *
 * A partial sort destroys row identity and every formula reference at once, so
 * the record of truth is append-only and the newest row is the bottom row of
 * four thousand. Sorting a copy is the only safe way to skim it.
 */
describe('a formula that could not expand', () => {
  it('names the blocking cell, not just the broken anchor', () => {
    const c = load();
    c.setup();

    const tx = c.__spreadsheet.getSheetByName('transactions');
    const column = c.colOf(c.TX_COLUMNS, 'category');
    const cell = tx.getRange(column + '2');
    c.__spreadsheet.formulaResults.set(cell.getFormula(), '#REF!');
    tx.getRange(column + '3').setValue('Groceries');

    const [reported] = c.brokenFormulaCells_();

    expect(reported).toContain('transactions!' + column + '2 #REF!');
    expect(reported).toContain(column + '3');
    expect(reported).toContain('Groceries');
  });
});

/**
 * A grouped QUERY has to group by everything it selects, verbatim.
 *
 * `select year(D), month(D)+1 ... group by year(D), month(D)` is rejected
 * whole: `month(D)+1` is not `month(D)`. It shipped green — the harness never
 * hands a query to a spreadsheet — and then survived six smoke-test runs,
 * because the IFERROR around it reported "nothing matches those filters",
 * which is a different fact and a false one.
 *
 * This is the rare formula bug a string test *can* prove, so it is proven here
 * rather than left to the live runtime.
 */
describe('every QUERY that groups', () => {
  const AGGREGATE = /^(sum|count|avg|min|max)\(/;

  [
    ['monthly', () => ctx.monthlyQueryStringFormula()],
    ['grouped', () => ctx.groupedQueryStringFormula()]
  ].forEach(([name, build]) => {
    it(`${name} groups by every non-aggregate it selects`, () => {
      const formula = build();
      const grouped = formula.match(/group by (.+?)(?: order by | limit |")/);
      if (!grouped) return; // not a grouping query; nothing to hold it to

      const selected = formula.match(/select (.+?) where /);
      expect(selected, `${name}: no select list found`).not.toBeNull();

      selected[1].split(',').map((s) => s.trim()).forEach((expression) => {
        if (AGGREGATE.test(expression)) return;
        // The grouped query interpolates its grouping column from a SWITCH, so
        // part of its select list is a formula rather than text. A string test
        // cannot follow that, and pretending otherwise would fail on the shape
        // of the interpolation rather than on anything being wrong.
        if (/["&$]/.test(expression)) return;
        expect(
          grouped[1],
          `${name} selects "${expression}" but does not group by it verbatim`
        ).toContain(expression);
      });
    });
  });

  it('corrects the zero-based month outside the query, where it is safe', () => {
    // QUERY's month() is 0-11. The +1 cannot live in the select list, so it
    // lives in the label formula — arithmetic on a cell, grouping nothing.
    expect(ctx.monthlyQueryStringFormula()).not.toContain(')+1');
    expect(ctx.monthKeyFormula_()).toContain('+1,"00"');
  });
});
