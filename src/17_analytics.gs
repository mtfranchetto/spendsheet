/**
 * 17_analytics.gs — reports you can slice, and the charts that read them.
 *
 * This is the file that turns a correct record of transactions into something
 * you open on purpose. It owns three things: the period arithmetic, the
 * `reports` tab, and every native chart in the book.
 *
 * ## Why dropdowns and one QUERY, rather than a query builder
 *
 * **Custom menus, sidebars and dialogs do not exist in the Google Sheets
 * mobile app.** A filtering UI built with `HtmlService` would be a feature
 * that silently is not there on the device it would be used from most. What
 * *is* there is data validation, so the filters are dropdowns and the report
 * is one `QUERY` recalculating the instant one changes. No run, nothing to
 * refresh, nothing to half-finish.
 *
 * ## Why the query string is assembled in a cell you can see
 *
 * `E6` on `reports` holds the query that `A14` runs. That is deliberate, and
 * it is the single most useful thing in this file.
 *
 * A `QUERY` built by string concatenation is precisely the formula this
 * project cannot unit-test: the harness never hands a formula to a
 * spreadsheet, and five bugs have shipped green through that gap — the locale
 * `#ERROR!`, a missing `!`, `1` not equalling `TRUE`, `INDEX` not vectorising
 * inside `ARRAYFORMULA`, and a too-wide `setValues`. Every one of them looked
 * fine in a test that could only read the string.
 *
 * A generated string you can read is the difference between "the report is
 * empty" and "the report is empty *because the where clause says
 * `where C = 'All'`*". It costs one cell.
 *
 * ## What is deliberately not here
 *
 * **Group by month.** Every other dimension is one column, which a chart can
 * use as its domain directly; a month is `year(D)` and `month(D)`, which is
 * two, and QUERY has no way to join them into a label. Rather than special-case
 * the group-by, the monthly view is its own block — it answers the same
 * question under the same filters, and it can carry the extra column it needs.
 *
 * A derived `month` column on `transactions` would remove that awkwardness and
 * is still the wrong trade: `monthlyTrendFormula`'s successor already groups
 * straight off `booking_date`, so the column would buy a nicer axis label and
 * a permanent schema change.
 */

/** Where everything on `reports` lives. Rows are fixed; columns keep blocks apart. */
var REPORT = {
  FILTER_ROW: 3,        // A:B — period, account, category, label, type, group by
  CUSTOM_ROW: 9,        // A:B — from, to
  WINDOW_ROW: 3,        // D:E — the resolved dates
  QUERY_ROW: 6,         // D:E — the assembled query strings

  RESULT_ROW: 14,       // A:B result, C the same total as money out
  MONTH_ROW: 14,        // G:I result, J label, K money out
  YOY_ROW: 14,          // M:N — three rows year on year, then three for the last 12 months
  RATE_ROW: 19,         // N — the last of those, and the one cell of the block that is not money

  RESULT_COL: 'A',
  MONTH_COL: 'G',
  YOY_COL: 'M',

  // Off to the right and hidden: the dropdown sources that have to be a range
  // rather than a list, because they change as you add an account or a label.
  LIST_COL: { account: 'AD', category: 'AF', label: 'AH' },

  CHART_COL: 16,        // P
  CHART_ROWS: [3, 22],

  /** How many rows the grouped result keeps. A chart of 400 merchants is a smear. */
  LIMIT: 30
};

/**
 * The periods offered, and how each one resolves.
 *
 * Expressed as Sheets expressions rather than computed in code, because the
 * answer has to be right tomorrow without a run — which is the same reason the
 * whole tab is formulas.
 */
var REPORT_PERIODS = [
  { label: 'This month', from: 'EOMONTH(TODAY(),-1)+1', to: 'TODAY()' },
  { label: 'Last month', from: 'EOMONTH(TODAY(),-2)+1', to: 'EOMONTH(TODAY(),-1)' },
  { label: 'This year', from: 'DATE(YEAR(TODAY()),1,1)', to: 'TODAY()' },
  { label: 'Last year', from: 'DATE(YEAR(TODAY())-1,1,1)', to: 'DATE(YEAR(TODAY())-1,12,31)' },
  { label: 'Last 12 months', from: 'EOMONTH(TODAY(),-12)+1', to: 'TODAY()' },
  { label: 'All time', from: 'DATE(2000,1,1)', to: 'TODAY()' },
  // The custom cells are read only here, so a date left in one of them does
  // nothing until you actually choose Custom.
  { label: 'Custom', from: 'IF($B$9="",DATE(2000,1,1),$B$9)', to: 'IF($B$10="",TODAY(),$B$10)' }
];

/** What the grouped block can group by, and which column each one is. */
var REPORT_GROUPS = [
  { label: 'Category', column: 'category' },
  { label: 'Subcategory', column: 'subcategory' },
  { label: 'Merchant', column: 'counterparty' },
  { label: 'Account', column: 'account_name' },
  { label: 'Type', column: 'type' }
];

var REPORT_TYPES = ['All', TX_TYPE.EXPENSE, TX_TYPE.INCOME, TX_TYPE.TRANSFER];

/** Every filter row: its label, its default, and where its values come from. */
var REPORT_FILTERS = [
  { label: 'Period', dflt: 'This month', list: function () {
    return REPORT_PERIODS.map(function (p) { return p.label; }); } },
  { label: 'Account', dflt: 'All', range: 'account' },
  { label: 'Category', dflt: 'All', range: 'category' },
  { label: 'Label', dflt: 'All', range: 'label' },
  { label: 'Type', dflt: 'All', list: function () { return REPORT_TYPES; } },
  { label: 'Group by', dflt: 'Category', list: function () {
    return REPORT_GROUPS.map(function (g) { return g.label; }); } }
];

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * Called from `setup()` through `functionExists_`, the same guarded forward
 * reference the sync uses.
 *
 * Charts are built **only on the run that creates the tab**, and that is the
 * whole of the idempotency story. An `EmbeddedChart` has no id — only options
 * — so there is no way to recognise one on a later run and update it in place.
 * Rebuilding every time would stack a fourth copy on every `setup()`; matching
 * on options would silently discard a chart you had dragged, resized or
 * changed the type of.
 *
 * So the contract is the one the hidden columns already use: a sensible
 * default on a new book, and your call for ever afterwards. `rebuildCharts()`
 * is the explicit, desktop-only way to say you want the defaults back, and it
 * says it will discard your layout before it does.
 */
function buildAnalytics_(ss, sep, report) {
  buildReportsTab_(ss, sep, report);

  var fresh = function (tab) { return report && report.created.indexOf(tab) !== -1; };
  if (fresh(TABS.REPORTS)) buildReportCharts_(ss);
}

/**
 * Menu → Rebuild charts. Desktop only, and honest about it.
 *
 * The phone can read a chart and cannot create one, so this is one of the two
 * things in the whole project that a mobile session genuinely cannot do. The
 * other is refilling the review queue.
 */
function rebuildCharts() {
  requireInteractive_();
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var existing = chartCount_(ss);
  var answer = ui.alert('Rebuild charts',
    'Replace the ' + existing + ' chart(s) on ' + TABS.REPORTS +
    ' with the standard ones.\n\n' +
    'Anything you have moved, resized or restyled is discarded. The data behind ' +
    'them is untouched — the charts read the blocks on those tabs and are rebuilt ' +
    'from the same ranges.\n\nContinue?', ui.ButtonSet.YES_NO);

  if (answer !== ui.Button.YES) {
    ss.toast('Nothing changed.', 'Cancelled', 5);
    return { rebuilt: 0 };
  }

  buildReportCharts_(ss);

  var now = chartCount_(ss);
  ss.toast(now + ' charts rebuilt.', 'Charts', 10);
  return { rebuilt: now, replaced: existing };
}

function chartCount_(ss) {
  var sheet = ss.getSheetByName(TABS.REPORTS);
  return sheet ? sheet.getCharts().length : 0;
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

function buildReportCharts_(ss) {
  var sheet = ss.getSheetByName(TABS.REPORTS);
  if (!sheet) return 0;

  clearCharts_(sheet);

  var groupLabel = REPORT.RESULT_COL + REPORT.RESULT_ROW + ':' +
    REPORT.RESULT_COL + (REPORT.RESULT_ROW + REPORT.LIMIT);
  var groupValue = nextColumn_(REPORT.RESULT_COL, 2) + REPORT.RESULT_ROW + ':' +
    nextColumn_(REPORT.RESULT_COL, 2) + (REPORT.RESULT_ROW + REPORT.LIMIT);

  insertChart_(sheet, {
    type: 'BAR',
    title: 'Money out, grouped',
    ranges: [groupLabel, groupValue],
    row: REPORT.CHART_ROWS[0],
    column: REPORT.CHART_COL,
    legend: 'none'
  });

  var monthLabel = nextColumn_(REPORT.MONTH_COL, 3);
  var monthValue = nextColumn_(REPORT.MONTH_COL, 4);

  insertChart_(sheet, {
    type: 'COLUMN',
    title: 'Money out, by month',
    ranges: [
      monthLabel + REPORT.MONTH_ROW + ':' + monthLabel + (REPORT.MONTH_ROW + 60),
      monthValue + REPORT.MONTH_ROW + ':' + monthValue + (REPORT.MONTH_ROW + 60)
    ],
    row: REPORT.CHART_ROWS[1],
    column: REPORT.CHART_COL,
    legend: 'none'
  });

  return 2;
}

function clearCharts_(sheet) {
  sheet.getCharts().forEach(function (chart) { sheet.removeChart(chart); });
}

/**
 * One chart, built the same way every time.
 *
 * `setNumHeaders` is what makes a two-series chart name its series from the
 * header row instead of calling them "Series 0" and "Series 1" — and the
 * single-series charts pass 0 because their first row is data, not a name.
 */
function insertChart_(sheet, spec) {
  var builder = sheet.newChart().setChartType(Charts.ChartType[spec.type]);

  spec.ranges.forEach(function (a1) { builder.addRange(sheet.getRange(a1)); });

  builder
    .setPosition(spec.row, spec.column, 0, 0)
    .setNumHeaders(spec.headers || 0)
    .setOption('title', spec.title)
    .setOption('width', 560)
    .setOption('height', 320)
    .setOption('legend', { position: spec.legend });

  sheet.insertChart(builder.build());
}

// ---------------------------------------------------------------------------
// The reports tab
// ---------------------------------------------------------------------------

/**
 * Rebuilt every run, except for the six cells that are your answers.
 *
 * Labels, formulas, validation and formats are canonical and are rewritten, so
 * an upgrade lands without a migration. The dropdown *selections* are written
 * only when blank — re-running `setup()` while you are in the middle of
 * looking at last October would otherwise put you back on This month.
 */
function buildReportsTab_(ss, sep, report) {
  var sheet = ss.getSheetByName(TABS.REPORTS);
  if (!sheet) return;

  sheet.getRange('A1').setValue('Reports').setFontSize(14).setFontWeight('bold');

  writeFilterRows_(sheet);
  writeDropdownSources_(sheet, sep, report);
  applyReportValidation_(sheet);
  writeReportFormulas_(sheet, sep);
  formatReports_(sheet);
}

function writeFilterRows_(sheet) {
  REPORT_FILTERS.forEach(function (filter, i) {
    var row = REPORT.FILTER_ROW + i;
    sheet.getRange('A' + row).setValue(filter.label).setFontWeight('bold');
    if (isBlankCell_(sheet.getRange('B' + row).getValue())) {
      sheet.getRange('B' + row).setValue(filter.dflt);
    }
  });

  sheet.getRange('A' + REPORT.CUSTOM_ROW).setValue('Custom from');
  sheet.getRange('A' + (REPORT.CUSTOM_ROW + 1)).setValue('Custom to');
}

/**
 * The lists a dropdown reads, off to the right and hidden.
 *
 * They have to be ranges rather than a fixed list because they change as you
 * add an account or a label, and they need "All" at the top, which is not in
 * any of the source tabs. An array literal — `{"All"; accounts!B2:B}` — would
 * have been one cell and is unusable: `localizeFormula` rewrites the comma to
 * the locale separator, which turns a row literal into a column one. Two cells
 * and a contiguous range is the version that works everywhere.
 */
function writeDropdownSources_(sheet, sep, report) {
  var sources = {
    account: filteredListFormula_(TABS.ACCOUNTS, colOf(ACCOUNT_COLUMNS, 'name'),
      sheetRange_(TABS.ACCOUNTS, ACCOUNT_COLUMNS, 'active') + '=TRUE'),
    category: filteredListFormula_(TABS.CATEGORIES, colOf(CATEGORY_COLUMNS, 'category'), null),
    label: filteredListFormula_(TABS.LABELS, colOf(LABEL_COLUMNS, 'label'), null)
  };

  // Hidden on the run that creates the tab and never again — the same contract
  // as `applyColumnVisibility_`. Re-hiding a column you went and unhid is
  // annoying precisely when you are in the middle of working out why a
  // dropdown is offering the wrong things.
  var isNew = report && report.created.indexOf(TABS.REPORTS) !== -1;

  Object.keys(REPORT.LIST_COL).forEach(function (key) {
    var column = REPORT.LIST_COL[key];
    sheet.getRange(column + '2').setValue('All');
    sheet.getRange(column + '3').setFormula(localizeFormula(sources[key], sep));
    if (isNew) sheet.hideColumns(columnIndexOf_(column));
  });
}

function filteredListFormula_(tab, column, extra) {
  var range = tab + '!$' + column + '$2:$' + column;
  return '=IFERROR(SORT(UNIQUE(FILTER(' + range + ',LEN(' + range + ')>0' +
    (extra ? ',' + extra : '') + '))),"")';
}

function applyReportValidation_(sheet) {
  REPORT_FILTERS.forEach(function (filter, i) {
    var cell = sheet.getRange('B' + (REPORT.FILTER_ROW + i));

    if (filter.list) {
      cell.setDataValidation(SpreadsheetApp.newDataValidation()
        .requireValueInList(filter.list(), true).setAllowInvalid(false).build());
      return;
    }

    var column = REPORT.LIST_COL[filter.range];
    cell.setDataValidation(SpreadsheetApp.newDataValidation()
      .requireValueInRange(sheet.getRange(column + '2:' + column), true)
      .setAllowInvalid(true).build());
  });
}

function writeReportFormulas_(sheet, sep) {
  var value = REPORT.RESULT_COL;
  var put = function (a1, formula) {
    sheet.getRange(a1).setFormula(localizeFormula(formula, sep));
  };

  sheet.getRange('D' + REPORT.WINDOW_ROW).setValue('From');
  sheet.getRange('D' + (REPORT.WINDOW_ROW + 1)).setValue('To');
  put('E' + REPORT.WINDOW_ROW, periodBoundFormula_('from'));
  put('E' + (REPORT.WINDOW_ROW + 1), periodBoundFormula_('to'));

  sheet.getRange('D' + REPORT.QUERY_ROW).setValue('Query');
  sheet.getRange('D' + (REPORT.QUERY_ROW + 1)).setValue('By month');
  put('E' + REPORT.QUERY_ROW, groupedQueryStringFormula());
  put('E' + (REPORT.QUERY_ROW + 1), monthlyQueryStringFormula());

  sheet.getRange('A' + (REPORT.RESULT_ROW - 1))
    .setValue('Top ' + REPORT.LIMIT).setFontWeight('bold');
  sheet.getRange(nextColumn_(value, 2) + (REPORT.RESULT_ROW - 1))
    .setValue('Money out').setFontWeight('bold');
  put('A' + REPORT.RESULT_ROW, runQueryFormula_(REPORT.QUERY_ROW));
  put(nextColumn_(value, 2) + REPORT.RESULT_ROW,
    negateFormula_(nextColumn_(value, 1), REPORT.RESULT_ROW));

  sheet.getRange(REPORT.MONTH_COL + (REPORT.MONTH_ROW - 1))
    .setValue('By month').setFontWeight('bold');
  sheet.getRange(nextColumn_(REPORT.MONTH_COL, 3) + (REPORT.MONTH_ROW - 1))
    .setValue('Month').setFontWeight('bold');
  sheet.getRange(nextColumn_(REPORT.MONTH_COL, 4) + (REPORT.MONTH_ROW - 1))
    .setValue('Money out').setFontWeight('bold');

  put(REPORT.MONTH_COL + REPORT.MONTH_ROW, runQueryFormula_(REPORT.QUERY_ROW + 1));
  put(nextColumn_(REPORT.MONTH_COL, 3) + REPORT.MONTH_ROW, monthKeyFormula_());
  put(nextColumn_(REPORT.MONTH_COL, 4) + REPORT.MONTH_ROW,
    negateFormula_(nextColumn_(REPORT.MONTH_COL, 2), REPORT.MONTH_ROW));

  writeYearOnYear_(sheet, put);
}

/**
 * Year on year, as its own three cells rather than a seventh dropdown.
 *
 * It answers a different question from the rest of the tab — "am I spending
 * more than I was" — and it answers it about the *year*, whatever the filters
 * above happen to be looking at. Wiring it to the dropdowns would make it move
 * whenever you drilled into something, which is the fastest way to stop
 * trusting a number.
 *
 * The three rows under it are the last 12 months — spending, income, and the
 * share of income kept — for the same reason and one more: the phone's Long
 * view computes those three from the ledger, and these cells are the second
 * implementation it is checked against. They are here rather than behind the
 * Period dropdown because "Last 12 months" there starts on the 1st of a
 * month, and the phone's window starts the day after today's date a year ago.
 */
function writeYearOnYear_(sheet, put) {
  var col = REPORT.YOY_COL;
  var value = nextColumn_(col, 1);
  var cell = function (offset) { return '$' + value + '$' + (REPORT.YOY_ROW + offset); };

  sheet.getRange(col + (REPORT.YOY_ROW - 1))
    .setValue('Year on year (all spending)').setFontWeight('bold');

  var rows = [
    ['This year to date', yearToDateSpendFormula_(0)],
    ['Last year, same point', yearToDateSpendFormula_(-1)],
    ['Difference', '=' + cell(0) + '-' + cell(1)],
    ['Last 12 months, spending', trailingYearFormula_('spending')],
    ['Last 12 months, income', trailingYearFormula_('income')],
    ['Last 12 months, savings rate', savingsRateFormula_(cell(3), cell(4))]
  ];

  rows.forEach(function (row, i) {
    sheet.getRange(col + (REPORT.YOY_ROW + i)).setValue(row[0]);
    put(value + (REPORT.YOY_ROW + i), row[1]);
  });
}


/**
 * Money out, or money in, over the twelve months ending today.
 *
 * From the day after today's date a year ago: `EDATE` takes the last day of
 * the month where last year has no such date, so 29 February starts its year
 * on 1 March — the rule `longview.ts` states for the phone.
 *
 * The upper bound is `< tomorrow` and not `<= today`. A booking date can carry
 * a time of day — a UTC midnight written into a Rome book is 02:00 — and
 * `<= TODAY()` compares against midnight, so it drops every such row booked
 * today. The phone floors a date to its day, and this is the same answer.
 */
function trailingYearFormula_(side) {
  var amount = txRange_('amount_base');
  var date = txRange_('booking_date');

  return '=' + (side === 'spending' ? '-' : '') + 'SUMIFS(' + amount + ',' +
    date + ',">="&EDATE(TODAY(),-12)+1,' +
    date + ',"<"&TODAY()+1,' +
    txRange_('in_reports') + ',TRUE,' +
    amount + ',"' + (side === 'spending' ? '<0' : '>0') + '")';
}

/**
 * What was kept, as a share of what came in — blank when nothing came in.
 *
 * Blank and not zero: no income is no rate, and `0%` would say every cent of
 * an income was spent.
 */
function savingsRateFormula_(spending, income) {
  return '=IF(' + income + '>0,(' + income + '-' + spending + ')/' + income + ',"")';
}

/**
 * Money out between 1 January and today, `offset` years back.
 *
 * The end of last year's window is `DATE(YEAR-1, MONTH(TODAY()), DAY(TODAY()))`
 * so the two figures cover the same stretch of the calendar. Comparing a
 * part-year against a whole one is the same mistake as comparing month-to-date
 * against a full month, one scale up.
 */
function yearToDateSpendFormula_(offset) {
  var year = offset === 0 ? 'YEAR(TODAY())' : 'YEAR(TODAY())' + offset;
  var amount = txRange_('amount_base');

  return '=-SUMIFS(' + amount + ',' +
    txRange_('booking_date') + ',">="&DATE(' + year + ',1,1),' +
    txRange_('booking_date') + ',"<="&DATE(' + year + ',MONTH(TODAY()),DAY(TODAY())),' +
    txRange_('in_reports') + ',TRUE,' +
    amount + ',"<0")';
}

/** One of the two resolved window edges, chosen by the Period dropdown. */
function periodBoundFormula_(edge) {
  var cases = REPORT_PERIODS.map(function (period) {
    return '"' + period.label + '",' + period[edge];
  }).join(',');

  return '=SWITCH($B$' + REPORT.FILTER_ROW + ',' + cases + ',' +
    REPORT_PERIODS[0][edge] + ')';
}

/**
 * The query the grouped block runs, assembled where you can read it.
 *
 * Every filter contributes nothing at all when it is set to All, so the
 * default query is short and the clauses that appear are exactly the ones you
 * chose. That is what makes the cell worth looking at: an empty report has a
 * visible cause.
 *
 * `contains` for the label, because `transactions.labels` holds
 * `kids, travel` as often as it holds one value. That carries the same caveat
 * the `labels` tab does — a label that is a substring of another matches both
 * — and the remedy is the same: keep label names distinct.
 */
function groupedQueryStringFormula() {
  var group = groupColumnExpression_();
  var amount = q_('amount_base');

  return '="select "&' + group + '&", sum(' + amount + ')' +
    ' where ' + q_('in_reports') + ' = true"' +
    reportFilterExpression_() +
    '&" group by "&' + group +
    '&" order by sum(' + amount + ') asc limit ' + REPORT.LIMIT + '"';
}

/**
 * The same filters, grouped by month instead.
 *
 * `month()` in QUERY is zero-based — January is 0 — so it is offset in the
 * select and left alone in the group by, which is the shape that works. Left
 * as an off-by-one it would be discovered as a mislabelled axis some months
 * later, by which time nobody connects it to this line.
 */
function monthlyQueryStringFormula() {
  var date = q_('booking_date');
  var amount = q_('amount_base');

  // `month(date)` and not `month(date)+1`, even though the month wanted
  // downstream is 1-12 and QUERY's is 0-11.
  //
  // Every non-aggregate expression in a select list has to appear *verbatim*
  // in the group by, and `month(date)+1` is not `month(date)`. The query is
  // rejected whole. The zero-based month is corrected in `monthKeyFormula_`,
  // where it is arithmetic on a cell rather than a grouping key.
  //
  // It shipped green and stayed broken through six smoke-test runs, because
  // `runQueryFormula_` wraps this in an IFERROR whose message asserts that
  // nothing matched — which is a different fact, and a false one.
  return '="select year(' + date + '), month(' + date + '), sum(' + amount + ')' +
    ' where ' + q_('in_reports') + ' = true"' +
    reportFilterExpression_() +
    '&" group by year(' + date + '), month(' + date + ')' +
    ' order by year(' + date + '), month(' + date + ')"';
}

/**
 * The `and …` clauses the dropdowns contribute, as one concatenation.
 *
 * Shared by both query cells so the two blocks can never disagree about what
 * is being looked at — which they would, eventually, if the clauses were
 * written twice.
 */
function reportFilterExpression_() {
  var row = function (i) { return '$B$' + (REPORT.FILTER_ROW + i); };

  var clauses = [
    [1, q_('account_name'), '='],
    [2, q_('category'), '='],
    [3, q_('labels'), 'contains'],
    [4, q_('type'), '=']
  ].map(function (spec) {
    var cell = row(spec[0]);
    return '&IF(' + cell + '="All",""," and ' + spec[1] + ' ' + spec[2] +
      ' \'"&' + cell + '&"\'")';
  }).join('');

  var date = q_('booking_date');
  return clauses +
    '&" and ' + date + ' >= date \'"&TEXT($E$' + REPORT.WINDOW_ROW + ',"yyyy-mm-dd")&"\'"' +
    '&" and ' + date + ' <= date \'"&TEXT($E$' + (REPORT.WINDOW_ROW + 1) +
    ',"yyyy-mm-dd")&"\'"';
}

/** Which column the Group by dropdown means. */
function groupColumnExpression_() {
  var cases = REPORT_GROUPS.map(function (entry) {
    return '"' + entry.label + '","' + q_(entry.column) + '"';
  }).join(',');

  return 'SWITCH($B$' + (REPORT.FILTER_ROW + 5) + ',' + cases + ',"' + q_('category') + '")';
}

/**
 * A query cell, run.
 *
 * `IFERROR` rather than letting the error through, because a half-typed custom
 * date makes QUERY throw and an error spilling across the block reads as the
 * report being broken rather than as the date being blank.
 *
 * The message must not claim which of the two happened. It used to say
 * "nothing matches those filters", which is one of them, and a malformed query
 * then presented as an honest empty result — for six smoke-test runs, on a
 * block that had never once worked. An IFERROR that names a cause it did not
 * check is worse than the error it hides.
 */
function runQueryFormula_(row) {
  return '=IFERROR(QUERY(' + txQueryRange_() + ',$E$' + row +
    ',0),"no rows — either nothing matches those filters, or the query in E' +
    row + ' is malformed. Paste E' + row + ' into a blank cell to see which.")';
}

/**
 * A column of signed totals, flipped so a chart of spending points upwards.
 *
 * `ISNUMBER` rather than `LEN`: the block's first cell holds a sentence when
 * nothing matched, and negating a string gives `#VALUE!` down the whole column
 * — an error where the honest answer is an empty chart.
 */
function negateFormula_(sourceColumn, row) {
  var range = '$' + sourceColumn + '$' + row + ':$' + sourceColumn;
  return '=ARRAYFORMULA(IF(ISNUMBER(' + range + '),-' + range + ',""))';
}

/**
 * `2026-07` from the year and month columns QUERY produced.
 *
 * `+1` here rather than in the select list: QUERY's `month()` is zero-based,
 * and the correction cannot live in the query because a select expression has
 * to match its group by verbatim. Here it is arithmetic on a cell, which
 * nothing else depends on.
 */
function monthKeyFormula_() {
  var year = '$' + REPORT.MONTH_COL + '$' + REPORT.MONTH_ROW + ':$' + REPORT.MONTH_COL;
  var month = '$' + nextColumn_(REPORT.MONTH_COL, 1) + '$' + REPORT.MONTH_ROW +
    ':$' + nextColumn_(REPORT.MONTH_COL, 1);

  return '=ARRAYFORMULA(IF(ISNUMBER(' + year + '),' +
    'TEXT(' + year + ',"0000")&"-"&TEXT(' + month + '+1,"00"),""))';
}

function formatReports_(sheet) {
  var money = currencyFormat_(readConfig_().base_currency || 'EUR');

  sheet.setColumnWidth(1, 160);
  sheet.setColumnWidth(4, 90);
  sheet.setColumnWidth(5, 420);

  [
    nextColumn_(REPORT.RESULT_COL, 1), nextColumn_(REPORT.RESULT_COL, 2),
    nextColumn_(REPORT.MONTH_COL, 2), nextColumn_(REPORT.MONTH_COL, 4),
    nextColumn_(REPORT.YOY_COL, 1)
  ].forEach(function (column) {
    sheet.getRange(column + REPORT.RESULT_ROW + ':' + column).setNumberFormat(money);
  });

  // After the loop, which formats the whole column it sits in as money: a
  // share of income printed that way reads as thirty-one cents.
  sheet.getRange(nextColumn_(REPORT.YOY_COL, 1) + REPORT.RATE_ROW).setNumberFormat('0%');

  sheet.getRange('B' + REPORT.CUSTOM_ROW + ':B' + (REPORT.CUSTOM_ROW + 1))
    .setNumberFormat('yyyy-mm-dd');
  sheet.getRange('E' + REPORT.WINDOW_ROW + ':E' + (REPORT.WINDOW_ROW + 1))
    .setNumberFormat('yyyy-mm-dd');

  // The one cell on this tab worth reading when something looks wrong, so it
  // is left as text rather than being wrapped into invisibility.
  sheet.getRange('E' + REPORT.QUERY_ROW + ':E' + (REPORT.QUERY_ROW + 1))
    .setNumberFormat('@');

  markReportInputs_(sheet);
}

/**
 * The eight cells on this tab that are yours, coloured so they read as inputs.
 *
 * Nothing else here is editable — every other cell is a formula or a label —
 * and until now nothing said so. A dropdown looks exactly like a result until
 * you happen to tap it, which is how a filtering UI becomes a tab people scroll
 * past. `DASH_COLOR.INPUT` is the same blue the `review` tab uses for the two
 * cells you act on there, so "blue means this one is mine" is one rule across
 * the book rather than a per-tab convention.
 *
 * A flat background rather than a conditional-format rule: which cells are
 * inputs is a fact about the layout, not about the data, so there is nothing
 * for a rule to test and nothing that can make it stop being true.
 */
function markReportInputs_(sheet) {
  var last = REPORT.FILTER_ROW + REPORT_FILTERS.length - 1;

  sheet.getRange('B' + REPORT.FILTER_ROW + ':B' + last)
    .setBackground(DASH_COLOR.INPUT);
  sheet.getRange('B' + REPORT.CUSTOM_ROW + ':B' + (REPORT.CUSTOM_ROW + 1))
    .setBackground(DASH_COLOR.INPUT);

  sheet.getRange('A1').setNote(
    'The blue cells are the ones you change. Everything else is a formula.\n\n' +
    'Custom from / Custom to are read only when Period is Custom, so a date ' +
    'left in one of them does nothing until you choose it.\n\n' +
    'E6 holds the query the block below actually runs — read it when a report ' +
    'comes back empty and you want to know whether it is the filter or the data.');
}
