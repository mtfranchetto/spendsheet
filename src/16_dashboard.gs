/**
 * 16_dashboard.gs — the tab you actually open.
 *
 * Entirely formulas, deliberately. A dashboard built by code would be a
 * snapshot that goes stale between runs and needs a menu item to refresh; one
 * built from formulas is correct the moment a row lands, and it is also what
 * keeps the never-sort rule intact — every view of `transactions` happens
 * *elsewhere*, through QUERY, rather than by rearranging the record of truth.
 *
 * `QUERY` is used in preference to array-criteria `SUMIFS` throughout, and that
 * is a deliberate retreat from cleverness. This project has now shipped five
 * formula bugs that every test passed — the locale `#ERROR!`, a missing `!`,
 * `1` not equalling `TRUE`, `INDEX` not vectorising inside ARRAYFORMULA, and a
 * too-wide `setValues`. The harness never hands a formula to a spreadsheet, so
 * it cannot tell a working idiom from one that merely looks like it. QUERY
 * returns a spilled range and needs no vectorisation assumption at all.
 *
 * Blocks grow **downwards** and are separated **horizontally** for the same
 * reason: a QUERY that outgrows its neighbour's start row would collide, and a
 * collision shows as `#REF!` across the whole block rather than as one wrong
 * cell.
 */

/** Where each block starts. Rows are fixed; only the columns keep them apart. */
var DASH = {
  HEALTH_ROW: 2,
  BLOCK_ROW: 11,
  MONTH_COL: 'A',
  TREND_COL: 'D',
  LABEL_COL: 'H'
};

function buildDashboard_(ss, sep) {
  var sheet = ss.getSheetByName(TABS.DASHBOARD);
  if (!sheet) return;

  sheet.getRange('A1').setValue('Spendsheet');
  sheet.getRange('A1').setFontSize(14).setFontWeight('bold');

  writeHealthStrip_(sheet, sep);
  writeBlocks_(sheet, sep);
  formatDashboard_(sheet);
}

/**
 * Health belongs where you already look.
 *
 * The alternative is a tab you have to remember to open, which means finding
 * out that the sync has been dead for a fortnight when you go looking for
 * something else. Six numbers, and five of them should be boring.
 */
function writeHealthStrip_(sheet, sep) {
  var rows = [
    ['Last successful sync', lastSyncFormula()],
    ['Consent expires in (days)', nearestConsentFormula()],
    ['Rows in the last 7 days', recentRowsFormula()],
    ['Needs review', needsReviewFormula()],
    ['Unconfirmed', unconfirmedFormula()],
    ['Projected to run out on', runsOutFormula()]
  ];

  rows.forEach(function (row, i) {
    var at = DASH.HEALTH_ROW + i;
    sheet.getRange('A' + at).setValue(row[0]);
    sheet.getRange('B' + at).setFormula(localizeFormula(row[1], sep));
  });
}

function writeBlocks_(sheet, sep) {
  var blocks = [
    [DASH.MONTH_COL, 'This month, by category', monthByCategoryFormula()],
    [DASH.TREND_COL, 'Last 6 months', monthlyTrendFormula()],
    [DASH.LABEL_COL, 'Labels', labelBreakdownFormula()]
  ];

  blocks.forEach(function (block) {
    sheet.getRange(block[0] + (DASH.BLOCK_ROW - 1)).setValue(block[1]).setFontWeight('bold');
    sheet.getRange(block[0] + DASH.BLOCK_ROW).setFormula(localizeFormula(block[2], sep));
  });
}

// ---------------------------------------------------------------------------
// The health strip
// ---------------------------------------------------------------------------

/**
 * The last run that did not fail.
 *
 * `FAIL` is excluded rather than requiring `OK`, so a `PARTIAL` — one bank down,
 * the others fine — still counts as the sync having happened. Reporting "last
 * sync: never" because illimity's consent lapsed would be worse than useless.
 */
function lastSyncFormula() {
  var started = runsRange_('started_at');
  var result = runsRange_('result');
  return '=IFERROR(MAX(FILTER(' + started + ',' + result + '<>"' + RUN_RESULT.FAIL + '")),"never")';
}

/** The nearest consent to expiry, which is the one that will bite first. */
function nearestConsentFormula() {
  var days = statusRange_('days_left');
  var id = statusRange_('connection_id');
  return '=IFERROR(MIN(FILTER(' + days + ',LEN(' + id + ')>0)),"—")';
}

/**
 * Rows that landed in the last week, which is the detector for failure 4:
 * a run that reports success and fetched nothing.
 */
function recentRowsFormula() {
  return '=COUNTIFS(' + txRange_('imported_at') + ',">="&TODAY()-7)';
}

/** Tier 6 of the cascade, as a number. It should trend to zero on its own. */
function needsReviewFormula() {
  return '=COUNTIF(' + txRange_('category_source') + ',"' + CATEGORY_SOURCE.UNCLASSIFIED + '")';
}

/**
 * How much of the sheet is still guesswork.
 *
 * Counted by subtraction rather than by `COUNTIF(range,"<>TRUE")`, because the
 * column holds real booleans and Sheets does not compare across types: `=1=TRUE`
 * is FALSE here where it is TRUE in Excel. A criterion string tested against a
 * boolean is exactly the shape that has already cost this project a silent
 * miss, so the boolean is counted directly and taken away from the total.
 */
function unconfirmedFormula() {
  return '=COUNTA(' + txRange_('uid') + ')-COUNTIF(' + txRange_('confirmed') + ',TRUE)';
}

/**
 * The one number worth reading out of ninety rows of projection.
 *
 * "—" when the projection never goes negative, which is the answer you want
 * most days and reads better than a blank.
 */
function runsOutFormula() {
  var date = cashflowRange_('date');
  var closing = cashflowRange_('closing');
  return '=IFERROR(MIN(FILTER(' + date + ',' + closing + '<0)),"—")';
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

/**
 * This month's spending, worst first.
 *
 * `W<>'transfer'` is the filter that keeps this honest: a move between your own
 * accounts is not spending, and counting it inflates a category total while the
 * net stays right — which is exactly how a reconciliation goes wrong in a way
 * nobody can see.
 *
 * Sorted ascending because expenses are negative, so ascending *is* worst first.
 */
function monthByCategoryFormula() {
  return '=IFERROR(QUERY(' + txQueryRange_() + ',' +
    '"select ' + q_('category') + ', sum(' + q_('amount_eur') + ') ' +
    'where ' + q_('type') + ' <> \'' + TX_TYPE.TRANSFER + '\' ' +
    'and ' + q_('booking_date') + ' >= date \'"&TEXT(EOMONTH(TODAY(),-1)+1,"yyyy-mm-dd")&"\' ' +
    'group by ' + q_('category') + ' ' +
    'order by sum(' + q_('amount_eur') + ') asc ' +
    'label ' + q_('category') + ' \'Category\', sum(' + q_('amount_eur') + ') \'Spend\'",0),' +
    '"nothing yet")';
}

/**
 * Six months of net, by month.
 *
 * `month()` in QUERY is zero-based — January is 0 — so it is offset here rather
 * than left to be discovered as an off-by-one in a chart label six months from
 * now.
 */
function monthlyTrendFormula() {
  var date = q_('booking_date');
  var amount = q_('amount_eur');
  return '=IFERROR(QUERY(' + txQueryRange_() + ',' +
    '"select year(' + date + '), month(' + date + ')+1, sum(' + amount + ') ' +
    'where ' + q_('type') + ' <> \'' + TX_TYPE.TRANSFER + '\' ' +
    'and ' + date + ' >= date \'"&TEXT(EOMONTH(TODAY(),-6)+1,"yyyy-mm-dd")&"\' ' +
    'group by year(' + date + '), month(' + date + ') ' +
    'order by year(' + date + '), month(' + date + ') ' +
    'label year(' + date + ') \'Year\', month(' + date + ')+1 \'Month\', ' +
    'sum(' + amount + ') \'Net\'",0),"nothing yet")';
}

/**
 * Spend per label, read off the `labels` tab rather than recomputed.
 *
 * That tab already carries the counting formulas, and two places computing the
 * same total is how they end up disagreeing. Labels with nothing against them
 * are dropped — a label you have defined but not used yet is not news, and it
 * is also what a typo looks like, which the `labels` tab itself is the right
 * place to notice.
 */
function labelBreakdownFormula() {
  var first = colOf(LABEL_COLUMNS, 'label');
  var last = colOf(LABEL_COLUMNS, 'total_eur');
  var count = colOf(LABEL_COLUMNS, 'transactions');

  return '=IFERROR(QUERY(' + TABS.LABELS + '!$' + first + '$2:$' + last + ',' +
    '"select ' + first + ', ' + count + ', ' + last + ' ' +
    'where ' + first + ' <> \'\' and ' + count + ' > 0 ' +
    'order by ' + last + ' asc ' +
    'label ' + first + ' \'Label\', ' + count + ' \'Rows\', ' + last + ' \'Total\'",0),' +
    '"no labels used yet")';
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/**
 * Every reference is built whole, `!` included.
 *
 * `TABS.TRANSACTIONS + '$A$2:$A'` reads correctly at the call site and produces
 * `transactions$A$2:$A`, which does not parse. That has shipped once already,
 * green, because a string test cannot tell a valid reference from an invalid
 * one — so the `!` lives in one helper rather than at a dozen call sites.
 */
function sheetRange_(tab, headers, name) {
  var column = colOf(headers, name);
  return tab + '!$' + column + '$2:$' + column;
}

function txRange_(name) { return sheetRange_(TABS.TRANSACTIONS, TX_COLUMNS, name); }
function runsRange_(name) { return sheetRange_(TABS.RUNS, RUN_COLUMNS, name); }
function statusRange_(name) { return sheetRange_(TABS.STATUS, STATUS_COLUMNS, name); }
function cashflowRange_(name) { return sheetRange_(TABS.CASHFLOW, CASHFLOW_COLUMNS, name); }

/**
 * The whole `transactions` block, for QUERY.
 *
 * QUERY names columns by their position **within the range given**, not by
 * their address on the sheet — so this has to start at column A or every letter
 * in every query above shifts silently.
 */
function txQueryRange_() {
  return TABS.TRANSACTIONS + '!$A$2:$' + colOf(TX_COLUMNS, TX_COLUMNS[TX_COLUMNS.length - 1]);
}

/** A column letter for use inside a QUERY string. */
function q_(name) {
  return colOf(TX_COLUMNS, name);
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function formatDashboard_(sheet) {
  var config = readConfig_();
  var money = currencyFormat_(config.base_currency || 'EUR');

  sheet.getRange('A' + DASH.HEALTH_ROW + ':A' + (DASH.HEALTH_ROW + 5)).setFontWeight('bold');
  sheet.getRange('B' + DASH.HEALTH_ROW).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('B' + (DASH.HEALTH_ROW + 5)).setNumberFormat('yyyy-mm-dd');

  // The spend column of each money block. Applied to a generous depth rather
  // than to the exact height, which is not knowable until the QUERY has run.
  sheet.getRange('B' + DASH.BLOCK_ROW + ':B').setNumberFormat(money);
  sheet.getRange('F' + DASH.BLOCK_ROW + ':F').setNumberFormat(money);
  sheet.getRange('J' + DASH.BLOCK_ROW + ':J').setNumberFormat(money);

  sheet.setColumnWidth(1, 200);
}
