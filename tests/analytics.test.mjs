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
  ['lastSync', ctx.lastSyncFormula()],
  ['nearestConsent', ctx.nearestConsentFormula()],
  ['recentRows', ctx.recentRowsFormula()],
  ['needsReview', ctx.needsReviewFormula()],
  ['unconfirmed', ctx.unconfirmedFormula()],
  ['oldestUnconfirmed', ctx.oldestUnconfirmedFormula()],
  ['netWorth', ctx.netWorthFormula()],
  ['netWorthCaveat', ctx.netWorthCaveatFormula()],
  ['spentThisMonth', ctx.spentThisMonthFormula()],
  ['earnedThisMonth', ctx.earnedThisMonthFormula()],
  ['netThisMonth', ctx.netThisMonthFormula()],
  ['spentLastMonthToDate', ctx.spentLastMonthToDateFormula()],
  ['accountsBlock', ctx.accountsBlockFormula()],
  ['monthByCategory', ctx.monthByCategoryFormula()],
  ['categorySpend', ctx.categorySpendFormula()],
  ['monthLabels', ctx.monthLabelsFormula()],
  ['spendByMonthThisYear', ctx.spendByMonthFormula(0)],
  ['spendByMonthLastYear', ctx.spendByMonthFormula(-1)],
  ['trendDates', ctx.trendDatesFormula()],
  ['trendValues', ctx.trendValuesFormula()],
  ['labelBreakdown', ctx.labelBreakdownFormula()],
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
    [ctx.monthByCategoryFormula(), ctx.labelBreakdownFormula(), ctx.accountsBlockFormula()]
      .forEach((formula) => {
        expect(ctx.localizeFormula(formula, ';')).toContain('label ');
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
    expect(ctx.accountsQueryRange_()).toContain('!$A$2:$');
    expect(ctx.monthByCategoryFormula()).toContain(ctx.txQueryRange_());
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

    [ctx.monthByCategoryFormula(), ctx.groupedQueryStringFormula(),
      ctx.monthlyQueryStringFormula()].forEach((formula) => {
      expect(formula).toContain(`${column} = true`);
      // The condition it replaced. Six blocks each re-deciding what spending
      // is, and one of them honoured `excluded`.
      expect(formula).not.toContain("<> 'transfer'");
    });

    [ctx.spentThisMonthFormula(), ctx.earnedThisMonthFormula(),
      ctx.spendByMonthFormula(0), ctx.yearToDateSpendFormula_(0),
      ctx.labelCountFormula(), ctx.labelTotalFormula()].forEach((formula) => {
      expect(formula).toContain(ctx.txRange_('in_reports') + ',TRUE');
    });
  });
});

describe('the net worth figure', () => {
  it('refuses to add a currency it cannot convert', () => {
    // An account's balance is in *that account's* currency, and Fineco alone
    // supplies CHF, GBP and USD pockets. Summing those into a euro total is a
    // wrong number that reads as a right one.
    expect(ctx.netWorthFormula()).toContain(ctx.accountsRange_('currency'));
    expect(ctx.netWorthFormula()).toContain('base_currency');
  });

  it('honours include_in_net_worth and active as booleans', () => {
    expect(ctx.netWorthFormula()).toContain(ctx.accountsRange_('include_in_net_worth') + ',TRUE');
    expect(ctx.netWorthFormula()).toContain(ctx.accountsRange_('active') + ',TRUE');
  });

  it('says nothing at all when it left nothing out', () => {
    // A caveat printed every day is a caveat nobody reads.
    expect(ctx.netWorthCaveatFormula()).toContain('=0,""');
  });
});

describe('the month-to-date comparison', () => {
  it('compares the same stretch of both months', () => {
    // A comparison that flatters you on the 3rd and alarms you on the 30th is
    // worse than none, because it is wrong in a way that feels like data.
    expect(ctx.spentThisMonthFormula()).toContain('"<="&TODAY()');
    expect(ctx.spentLastMonthToDateFormula()).toContain('"<="&EDATE(TODAY(),-1)');
  });

  it('takes the sign from the amount rather than from a stored direction', () => {
    expect(ctx.spentThisMonthFormula()).toContain('"<0"');
    expect(ctx.earnedThisMonthFormula()).toContain('">0"');
    expect(ctx.netThisMonthFormula()).not.toContain('"<0"');
  });

  it('reads amount_base, never amount', () => {
    [ctx.spentThisMonthFormula(), ctx.earnedThisMonthFormula(),
      ctx.spendByMonthFormula(0), ctx.trendValuesFormula(),
      ctx.yearToDateSpendFormula_(0)].forEach((formula) => {
      expect(formula).toContain(ctx.txRange_('amount_base'));
    });
  });
});

describe('the net worth trend', () => {
  it('derives every day from today backwards, rather than from a stored history', () => {
    expect(ctx.trendValuesFormula()).toContain(ctx.netWorthFormula().slice(1));
    expect(ctx.trendValuesFormula()).toContain('">"&');
  });

  it('counts transfers, because a transfer moves a balance', () => {
    // The one place in the project that reads every row, and it is correct
    // precisely because net worth is not a spending question.
    expect(ctx.trendValuesFormula()).not.toContain(ctx.txRange_('in_reports'));
  });

  it('covers as many days as the chart is built for', () => {
    const days = ctx.trendDays_();
    expect(ctx.trendDatesFormula()).toContain(`SEQUENCE(${days},1,TODAY()-${days - 1},1)`);
    expect(ctx.trendValuesFormula()).toContain(`$${ctx.DASH.TREND_COL}$${ctx.DASH.FEED_ROW + days - 1}`);
  });

  it('falls back to 90 days rather than to nothing when the setting is blank', () => {
    // Number('') is 0 and isFinite(0) is true, so the obvious guard passes and
    // a cleared cell reads as a value someone deliberately typed.
    const c = load();
    c.setup();
    const config = c.__spreadsheet.getSheetByName('_config');
    const row = c.findRowByValue_(config, 1, 'trend_days');
    config.getRange(row, 2).setValue('');

    expect(c.trendDays_()).toBe(90);
  });
});

describe('the two-series monthly block', () => {
  it('keeps both years on the same twelve buckets', () => {
    // A grouped query would omit the months that have not happened yet and
    // silently misalign the two series.
    expect(ctx.monthLabelsFormula()).toContain('SEQUENCE(12)');
    expect(ctx.spendByMonthFormula(0)).toContain('SEQUENCE(12)');
    expect(ctx.spendByMonthFormula(-1)).toContain('YEAR(TODAY())-1');
  });

  it('rolls a thirteenth month over with DATE rather than EDATE', () => {
    // DATE is the function this project has already proved vectorises inside
    // ARRAYFORMULA. INDEX is the one that did not, and it shipped green.
    expect(ctx.spendByMonthFormula(0)).toContain('DATE(YEAR(TODAY()),SEQUENCE(12)+1,1)');
    expect(ctx.spendByMonthFormula(0)).not.toContain('EDATE');
  });

  it('blanks a month in the future instead of plotting a zero', () => {
    expect(ctx.spendByMonthFormula(0)).toContain('>EOMONTH(TODAY(),0),""');
  });
});

describe('the sign a chart is given', () => {
  it('flips the total rather than plotting bars that point downwards', () => {
    // QUERY cannot negate an aggregate — arithmetic on sum() is not in the
    // query language — so the sign is flipped next to the numbers it flips.
    expect(ctx.categorySpendFormula()).toContain('ISNUMBER');
    expect(ctx.categorySpendFormula()).toMatch(/,-\$/);
  });

  it('tests for a number rather than for length', () => {
    // The block's first cell holds a sentence when nothing matched, and
    // negating a string gives #VALUE! down the whole column.
    [ctx.categorySpendFormula(), ctx.negateFormula_('B', 14), ctx.monthKeyFormula_()]
      .forEach((formula) => {
        expect(formula).toContain('ISNUMBER(');
        expect(formula).not.toContain('LEN(');
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

describe('the dashboard tab', () => {
  const c = load();
  c.setup();
  const dash = c.__spreadsheet.getSheetByName('dashboard');

  it('puts health where you already look', () => {
    expect(dash.getRange('A' + c.DASH.HEALTH_ROW).getValue()).toBe('Last successful sync');
    expect(dash.getRange('B' + c.DASH.HEALTH_ROW).getFormula()).toContain('_runs!');
  });

  it('bounds every stacked block, so one growing cannot reach the next', () => {
    // The vertical stack replaced column separation, and this is the property
    // that made that safe: a QUERY with no `limit` grows until it lands #REF!
    // across the block below it. The slot each one sits in has to be at least
    // as tall as what the query can return.
    const blocks = [
      [c.DASH.REVIEW_ROW, c.DASH.REVIEW_ROWS, c.DASH.ACCOUNTS_ROW],
      [c.DASH.ACCOUNTS_ROW, c.DASH.ACCOUNTS_LIMIT, c.DASH.LABELS_ROW],
      [c.DASH.LABELS_ROW, c.DASH.LABELS_LIMIT, Infinity]
    ];

    blocks.forEach(([row, limit, next]) => {
      const formula = dash.getRange('A' + row).getFormula();
      expect(formula, `block at row ${row}`).not.toBe('');
      expect(formula, `block at row ${row}`).toMatch(new RegExp(`limit ${limit}\\b`));
      // +1 for the QUERY's own header row, +1 for the next block's title.
      expect(row + limit + 2, `block at row ${row} fits above ${next}`)
        .toBeLessThanOrEqual(next);
    });
  });

  it('keeps the readable blocks inside the width of a phone', () => {
    // The whole reason the layout turned vertical. Anything past E is either
    // hidden feed or nothing at all.
    expect(c.columnIndexOf_(c.DASH.SYNC_COL)).toBeLessThanOrEqual(6);
    expect(c.columnIndexOf_(c.DASH.FEED_COL)).toBe(7);
  });

  it('hides every feed column, on every run', () => {
    // Not "once, and respect your choice afterwards" — the feed is ninety rows
    // of dates whose only reader is a chart.
    const first = c.columnIndexOf_(c.DASH.FEED_COL);
    const last = c.columnIndexOf_(c.nextColumn_(c.DASH.TREND_COL, 1));

    for (let i = first; i <= last; i++) {
      expect(dash.isColumnHiddenByUser(i), `column ${i}`).toBe(true);
    }
  });

  it('anchors the charts below the only column with a fixed height', () => {
    // Everything that can grow — accounts, categories, labels — grows
    // downwards to the right of it.
    const lastText = c.DASH.MONTH_ROW + 5;
    c.DASH.CHART_ROWS.forEach((row) => expect(row).toBeGreaterThan(lastText));
  });

  it('writes every format rule without a comma in it', () => {
    // localizeFormula translates the formulas written into *cells*. A
    // conditional-format rule does not pass through that boundary, so
    // `=AND(a,b)` would be a parse failure with nowhere to show #ERROR! — the
    // rule would simply never fire and the thing it watches would go on
    // looking fine. Checked across every tab that has rules, not just this
    // one, because the trap is the boundary rather than the tab.
    const review = c.__spreadsheet.getSheetByName('review');

    [dash, review].forEach((sheet) => {
      const rules = sheet.getConditionalFormatRules();
      expect(rules.length).toBeGreaterThan(0);
      rules.forEach((rule) => {
        expect(rule.formula, rule.formula).not.toContain(',');
      });
    });
  });

  it('compares the severity flag to a number rather than testing it', () => {
    // All the thinking lives in the hidden flag column precisely so the rule
    // can be an equality: `AND`, `IF` and `VLOOKUP` all need a comma, and
    // `consent_warning_days` lives in _config where only a VLOOKUP reaches.
    const rules = dash.getConditionalFormatRules();
    const flags = rules.map((r) => r.formula).filter((f) => f.includes(c.DASH.FLAG_COL));

    // All but the next-step line, which is prose and has no severity to
    // compute — it either has something to say or it is empty.
    expect(flags.length).toBe(rules.length - 1);
    flags.forEach((formula) => {
      expect(formula).toMatch(new RegExp(`^=\\$${c.DASH.FLAG_COL}\\d+=[12]$`));
    });
  });

  it('colours an account red when its consent has gone, not when it is quiet', () => {
    // A stale balance is a weekend and a quiet current account as often as it
    // is a failure. Colouring those red is how red stops meaning anything.
    const severity = dash.getRange(c.DASH.FLAG_COL + c.DASH.ACCOUNTS_ROW).getFormula();

    expect(severity).toContain('consent_warning_days');
    expect(severity).toContain('stale_balance_days');

    // The expired branch is 2; the stale-balance branch is 1.
    const expired = severity.indexOf('2,');
    const stale = severity.indexOf('stale_balance_days');
    expect(expired).toBeGreaterThan(-1);
    expect(expired).toBeLessThan(stale);
  });

  it('says in words what the colour only says is wrong', () => {
    // A red row you have to go and investigate is a red row you scroll past.
    const sync = dash.getRange(c.DASH.SYNC_COL + c.DASH.ACCOUNTS_ROW).getFormula();

    expect(sync).toContain('reconnect');
    // A cash tin is not failing to sync; it has nothing to sync.
    expect(sync).toContain('"—"');
    expect(sync).toContain(c.ACCOUNT_KIND.BANK);
  });

  it('sweeps away a block from a layout that has since moved', () => {
    // The blocks used to sit in A, D and H at row 11. Overwriting alone would
    // leave the old arrangement there as orphaned headers and live QUERYs —
    // two dashboards on one tab, both plausible, one months out of date.
    const old = load();
    old.setup();
    const sheet = old.__spreadsheet.getSheetByName('dashboard');
    sheet.getRange('D11').setFormula('=QUERY(transactions!$A$2:$AC,"select U",0)');
    sheet.getRange('D10').setValue('Last 6 months');

    old.setup();
    expect(sheet.getRange('D11').getFormula()).toBe('');
    expect(sheet.getRange('D10').getValue()).toBe('');
  });

  it('leaves anything you put to the right of the blocks alone', () => {
    const mine = load();
    mine.setup();
    const sheet = mine.__spreadsheet.getSheetByName('dashboard');

    // Derived from the layout, not written down: a block added to the right
    // moves this boundary, and a hard-coded column would keep passing while
    // testing a cell that is now generated.
    const cell = mine.nextColumn_(mine.DASH.TREND_COL, 4) + '4';
    sheet.getRange(cell).setValue('my own note');

    mine.setup();
    expect(sheet.getRange(cell).getValue()).toBe('my own note');
  });

  it('is rebuilt identically on a second setup()', () => {
    const before = dash.snapshot();
    c.setup();
    expect(c.__spreadsheet.getSheetByName('dashboard').snapshot()).toEqual(before);
  });
});

describe('the charts', () => {
  const c = load();
  c.setup();
  const dash = c.__spreadsheet.getSheetByName('dashboard');
  const reports = c.__spreadsheet.getSheetByName('reports');

  it('builds three on the dashboard and two on reports', () => {
    expect(dash.getCharts()).toHaveLength(3);
    expect(reports.getCharts()).toHaveLength(2);
  });

  it('points every one at a range that something writes to', () => {
    // A chart is configuration pointed at a range. Pointed at an empty one it
    // draws nothing, forever, and says nothing about why.
    [...dash.getCharts(), ...reports.getCharts()].forEach((chart) => {
      chart.ranges.forEach((a1) => {
        const sheet = dash.getCharts().includes(chart) ? dash : reports;
        const [start] = a1.split(':');
        const cell = sheet.getRange(start);
        expect(cell.getFormula() || cell.getValue(), `${chart.options.title} reads ${a1}`)
          .not.toBe('');
      });
    });
  });

  it('names its series from a header row, or takes none at all', () => {
    // A header row it was not given is a header row it takes from the data.
    [...dash.getCharts(), ...reports.getCharts()].forEach((chart) => {
      if (!chart.numHeaders) return;
      const [start] = chart.ranges[0].split(':');
      expect(Number(start.replace(/\D/g, ''))).toBe(c.DASH.FEED_ROW - 1);
    });
  });

  it('does not stack another copy on every setup()', () => {
    // An EmbeddedChart has no id, so there is no way to recognise one on a
    // later run — which is why they are built once and rebuilt only on request.
    c.setup();
    c.setup();
    expect(c.__spreadsheet.getSheetByName('dashboard').getCharts()).toHaveLength(3);
  });

  it('leaves a chart you moved alone, until you ask for the defaults back', () => {
    const moved = load();
    moved.setup();
    const sheet = moved.__spreadsheet.getSheetByName('dashboard');
    sheet.getCharts().forEach((chart) => sheet.removeChart(chart));

    moved.setup();
    expect(sheet.getCharts()).toHaveLength(0);

    moved.rebuildCharts();
    expect(sheet.getCharts()).toHaveLength(3);
  });

  it('changes nothing when you say no to the rebuild', () => {
    const said = load({ alertResponse: 'NO' });
    said.setup();
    const sheet = said.__spreadsheet.getSheetByName('dashboard');
    sheet.removeChart(sheet.getCharts()[0]);

    said.rebuildCharts();
    expect(sheet.getCharts()).toHaveLength(2);
  });
});

/**
 * The live checks, tested for what they *detect* rather than for passing.
 *
 * They cannot pass in here — the harness evaluates no formulas, which is the
 * whole reason they exist. What can be proved is that each one fires on the
 * damage it was written for.
 */
/**
 * The two dropdowns and the one block that answer "what do I do here".
 *
 * All three exist because reading the sheet did not tell you: the category
 * list offered seventy entries most of which were duplicates, nothing said
 * that a transfer is marked by choosing a category, and the backlog lived on
 * a tab you had to remember to open.
 */
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

  it('reads the review queue rather than asking transactions again', () => {
    // `confirmed` is blank on almost every row, and QUERY types a column by
    // majority — the exact trap that produced `in_reports`. The review tab is
    // built row by row in code, so it has no blank majority to misread.
    const c = load();
    const formula = c.reviewQueueFormula();

    expect(formula).toContain('review!');
    expect(formula).not.toContain('transactions!');
    expect(formula).toContain('limit ' + c.DASH.REVIEW_ROWS);
    expect(c.DASH.REVIEW_ROWS).toBeGreaterThanOrEqual(10);
  });

  it('selects query letters relative to the range, not to the review schema', () => {
    // The range starts at booking_date, so amount_base is D there and E on the
    // tab. Getting this wrong shows the wrong column with no error at all.
    const c = load();
    const formula = c.reviewQueueFormula();

    expect(formula).toContain('$B$2:$G');
    expect(formula).toContain('select A, C, D, E');
  });

  it('clears far enough right to cover the block it just added', () => {
    const c = load();
    c.setup();
    const sheet = c.__spreadsheet.getSheetByName('dashboard');

    // A stale block left behind by an older layout is two dashboards on one
    // tab, both plausible. The last generated column must be cleared.
    const last = c.nextColumn_(c.DASH.TREND_COL, 1);
    sheet.getRange(last + '9').setValue('stale');
    c.setup();
    expect(sheet.getRange(last + '9').getValue()).not.toBe('stale');
  });
});

describe('the smoke tests for this phase', () => {
  it('lists an anchor on every tab it wrote a formula to', () => {
    const c = load();
    c.setup();
    const tabs = new Set(c.formulaAnchors_().map(([tab]) => tab));

    ['transactions', 'accounts', '_status', 'labels', 'dashboard', 'reports']
      .forEach((tab) => expect([...tabs]).toContain(tab));
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
    expect(c.chartsInBook_()).toHaveLength(5);

    const empty = c.emptyCharts_();
    expect(empty.length).toBeGreaterThan(0);
    expect(empty.join(' ')).toContain('Net worth');
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
describe('the recent tab', () => {
  const c = load();
  c.setup();
  const recent = c.__spreadsheet.getSheetByName('recent');

  it('sorts newest first, which is the whole point', () => {
    [c.recentBookedFormula(), c.recentPendingFormula()].forEach((formula) => {
      expect(formula).toMatch(/order by \w+ desc/);
    });
  });

  it('tests for null rather than comparing a mostly-empty column to text', () => {
    // Several tabs carry an open-ended ARRAYFORMULA, so a range reaches the
    // sheet's last row rather than the last record and QUERY types a column by
    // majority. `<> ''` is the trap that produced in_reports; `is not null`
    // needs no agreement about the column's type.
    [c.recentBookedFormula(), c.recentPendingFormula()].forEach((formula) => {
      expect(formula).toContain('is not null');
      expect(formula).not.toContain("<> ''");
    });
  });

  it('bounds both blocks so the booked one cannot land on the pending one', () => {
    expect(c.recentPendingFormula()).toContain(`limit ${c.RECENT.PENDING_LIMIT}`);
    expect(c.recentBookedFormula()).toContain(`limit ${c.RECENT.BOOKED_LIMIT}`);
    expect(c.RECENT.PENDING_ROW + c.RECENT.PENDING_LIMIT + 2)
      .toBeLessThanOrEqual(c.RECENT.BOOKED_ROW);
  });

  it('reads amount_base from transactions and the raw amount from pending', () => {
    // `pending` carries only the columns code writes — no amount_base exists
    // there — so the currency is named beside it rather than implied.
    expect(c.recentBookedFormula()).toContain(c.colOf(c.TX_COLUMNS, 'amount_base'));
    expect(c.recentPendingFormula()).toContain("'Cur'");
  });

  it('builds every reference whole, with its !', () => {
    // `TABS.PENDING + '$A$2'` reads correctly at the call site and produces
    // something that does not parse. That has shipped once already.
    expect(c.pendingQueryRange_()).toBe(
      'pending!$A$2:$' + c.colOf(c.PENDING_COLUMNS, 'imported_at'));
  });

  it('writes both blocks and sweeps a layout that has since moved', () => {
    expect(recent.getRange('A' + c.RECENT.PENDING_ROW).getFormula()).toContain('pending!');
    expect(recent.getRange('A' + c.RECENT.BOOKED_ROW).getFormula()).toContain('transactions!');

    recent.getRange('A' + (c.RECENT.BOOKED_ROW + 1)).setValue('stale');
    c.setup();
    expect(recent.getRange('A' + (c.RECENT.BOOKED_ROW + 1)).getValue()).not.toBe('stale');
  });
});

describe('filtering the recent tab', () => {
  const c = load();
  c.setup();
  const recent = c.__spreadsheet.getSheetByName('recent');

  it('filters inside the query, not after it', () => {
    // Filtering the result would cap you at the newest 200 rows overall and
    // then show whichever matched — a block that quietly lies about being the
    // most recent. The clause has to go in before `limit` does its work.
    const formula = c.recentBookedFormula();
    expect(formula.indexOf('year(')).toBeLessThan(formula.indexOf('limit'));
  });

  it('adds no clause at all when both filters say All', () => {
    // Same rule the reports tab follows: the default query is short, and the
    // clauses you can see are exactly the ones you chose.
    expect(c.recentBookedFormula()).toContain('IF($B$3="All","",');
  });

  it('converts the month name to the zero-based number QUERY wants', () => {
    // QUERY's month() is zero-based. Getting this wrong is right eleven
    // twelfths of the time, which is the worst kind of wrong.
    expect(c.recentBookedFormula()).toContain('-2)');
    expect(c.RECENT_MONTHS[0]).toBe('All');
    expect(c.RECENT_MONTHS[1]).toBe('January');
  });

  it('reads the years out of the data rather than hard-coding a span', () => {
    // Hard-coded years offer you ones you have nothing in, and stop working.
    expect(c.recentYearsFormula()).toContain('UNIQUE(');
    expect(c.recentYearsFormula()).toContain(c.txRange_('booking_date'));
    // Newest first: a dropdown you scroll to reach the common answer has
    // failed at its one job.
    expect(c.recentYearsFormula()).toContain(',1,FALSE)');
  });

  it('hides both lists and leaves the two cells that are yours blue', () => {
    expect(recent.isColumnHiddenByUser(c.columnIndexOf_(c.RECENT.YEAR_COL))).toBe(true);
    expect(recent.isColumnHiddenByUser(c.columnIndexOf_(c.RECENT.MONTH_COL))).toBe(true);

    const backgrounds = recent.calls.filter((call) => call.kind === 'background');
    expect(backgrounds.some((call) => call.b === c.DASH_COLOR.INPUT)).toBe(true);
  });

  it('keeps your selection across a setup() run', () => {
    recent.getRange('B' + c.RECENT.FILTER_ROW).setValue('2025');
    c.setup();
    expect(recent.getRange('B' + c.RECENT.FILTER_ROW).getValue()).toBe('2025');
  });

  it('leaves the pending block unfiltered', () => {
    // Pending is a handful of rows from the last few days by definition, so a
    // year filter over it either changes nothing or empties it.
    expect(c.recentPendingFormula()).not.toContain('year(');
  });
});

/**
 * A `#REF!` anchor names what is blocking it.
 *
 * `spillReason_` was wired to `in_reports` alone, which is the column the
 * incident happened to. Every ARRAYFORMULA anchor in the book fails the same
 * way, and on a real book two of them did — reporting only "something is in
 * the column under it", which is a search rather than a repair.
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
