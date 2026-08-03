/**
 * 16_dashboard.gs — the tab you actually open.
 *
 * Entirely formulas, deliberately. A dashboard built by code would be a
 * snapshot that goes stale between runs and needs a menu item to refresh; one
 * built from formulas is correct the moment a row lands, and it is also what
 * keeps the never-sort rule intact — every view of `transactions` happens
 * *elsewhere*, through QUERY, rather than by rearranging the record of truth.
 *
 * That property matters more since the phone became a first-class surface.
 * **Custom menus, sidebars and dialogs do not exist in the Google Sheets
 * mobile app.** What does exist is formulas, native charts, checkboxes,
 * data validation, conditional formatting and `onEdit`. So a dashboard that
 * needed a run to be correct would simply be wrong on the device it is most
 * often looked at.
 *
 * `QUERY` is used in preference to array-criteria `SUMIFS` for anything
 * grouped, and that is a deliberate retreat from cleverness. This project has
 * now shipped five formula bugs that every test passed — the locale `#ERROR!`,
 * a missing `!`, `1` not equalling `TRUE`, `INDEX` not vectorising inside
 * ARRAYFORMULA, and a too-wide `setValues`. The harness never hands a formula
 * to a spreadsheet, so it cannot tell a working idiom from one that merely
 * looks like it. QUERY returns a spilled range and needs no vectorisation
 * assumption at all.
 *
 * `SUMIFS` is used where the *shape* of the answer is known in advance — the
 * twelve months of a year, the ninety days of a trend — because there it
 * vectorises over its criteria, which is the one array idiom this project has
 * already shipped and proved (see `labelCountFormula`).
 *
 * Blocks grow **downwards** and are separated **horizontally** for the same
 * reason as before: a QUERY that outgrows its neighbour's start row would
 * collide, and a collision shows as `#REF!` across the whole block rather than
 * as one wrong cell.
 *
 * Everything on this tab is a formula. The charts that read these blocks are
 * built in 17_analytics.gs, which loads after this file and takes its ranges
 * from `DASH` below — the seam is "16 is what you read, 17 is what you plot".
 */

/**
 * Where each block starts.
 *
 * The left column is the only thing with a fixed height; every block to the
 * right of it grows down, so they are kept apart by column rather than by row.
 * The charts are anchored below the left column, where nothing else ever is.
 */
var DASH = {
  HEALTH_ROW: 3,          // A:C, six rows
  MONTH_ROW: 12,          // A:C, six rows, header on 11
  BLOCK_ROW: 3,           // every right-hand block starts here, header on 2

  ACCOUNTS_COL: 'E',      // E:I  name, kind, balance, currency, updated
  CATEGORY_COL: 'K',      // K:L  category, signed total
  CATEGORY_VALUE_COL: 'M',//   M  the same total as money out, for the chart
  MONTHLY_COL: 'O',       // O:Q  month, this year, last year
  TREND_COL: 'S',         // S:T  date, net worth on that date
  LABEL_COL: 'V',         // V:X  label, rows, total

  CHART_ROWS: [20, 40, 60],
  CHART_COL: 1
};

function buildDashboard_(ss, sep) {
  var sheet = ss.getSheetByName(TABS.DASHBOARD);
  if (!sheet) return;

  clearGeneratedBlocks_(sheet);

  sheet.getRange('A1').setValue('Spendsheet');
  sheet.getRange('A1').setFontSize(14).setFontWeight('bold');

  writeHealthStrip_(sheet, sep);
  writeMonthStrip_(sheet, sep);
  writeBlocks_(sheet, sep);
  formatDashboard_(sheet);
}

/**
 * Health belongs where you already look.
 *
 * The alternative is a tab you have to remember to open, which means finding
 * out that the sync has been dead for a fortnight when you go looking for
 * something else. Six numbers, and five of them should be boring.
 *
 * The third column is for the sentence a number cannot carry on its own: how
 * old the backlog is, or which accounts a total left out. Blank whenever there
 * is nothing to say, which is most days.
 */
function writeHealthStrip_(sheet, sep) {
  var rows = [
    ['Last successful sync', lastSyncFormula(), ''],
    ['Consent expires in (days)', nearestConsentFormula(), ''],
    ['Rows in the last 7 days', recentRowsFormula(), ''],
    ['Needs review', needsReviewFormula(), ''],
    ['Unconfirmed', unconfirmedFormula(), oldestUnconfirmedFormula()],
    ['Projected to run out on', runsOutFormula(), '']
  ];

  writeStrip_(sheet, DASH.HEALTH_ROW, rows, sep);
}

/**
 * This month, against the same point last month.
 *
 * Month-to-date compared with month-to-date, never against a full month. A
 * comparison that flatters you on the 3rd and alarms you on the 30th is worse
 * than no comparison, because it is wrong in a direction that feels like
 * information.
 */
function writeMonthStrip_(sheet, sep) {
  var spentRow = DASH.MONTH_ROW + 1;
  var lastRow = DASH.MONTH_ROW + 4;

  var rows = [
    ['Net worth', netWorthFormula(), netWorthCaveatFormula()],
    ['Spent so far', spentThisMonthFormula(), ''],
    ['Earned so far', earnedThisMonthFormula(), ''],
    ['Net', netThisMonthFormula(), ''],
    ['Same point last month', spentLastMonthToDateFormula(), ''],
    ['Difference', '=$B$' + spentRow + '-$B$' + lastRow, '']
  ];

  sheet.getRange('A' + (DASH.MONTH_ROW - 1)).setValue('This month').setFontWeight('bold');
  writeStrip_(sheet, DASH.MONTH_ROW, rows, sep);
}

function writeStrip_(sheet, startRow, rows, sep) {
  rows.forEach(function (row, i) {
    var at = startRow + i;
    sheet.getRange('A' + at).setValue(row[0]);
    sheet.getRange('B' + at).setFormula(localizeFormula(row[1], sep));
    if (row[2]) sheet.getRange('C' + at).setFormula(localizeFormula(row[2], sep));
  });
}

/**
 * The blocks to the right, each one either something to read or something a
 * chart reads.
 *
 * `M` is the odd one out and worth explaining: it is the category block's
 * total again, negated. `amount_eur` is signed, so a spending total is
 * negative, and a bar chart of negative bars is legible but reads as a
 * mistake. QUERY cannot negate an aggregate — arithmetic on `sum()` is not in
 * the query language — so the sign is flipped in the one place that can do it,
 * next to the numbers it flips.
 */
function writeBlocks_(sheet, sep) {
  var blocks = [
    [DASH.ACCOUNTS_COL, 'Accounts', accountsBlockFormula()],
    [DASH.CATEGORY_COL, 'This month, by category', monthByCategoryFormula()],
    [DASH.CATEGORY_VALUE_COL, 'Spend', categorySpendFormula()],
    [DASH.MONTHLY_COL, 'Month', monthLabelsFormula()],
    [DASH.TREND_COL, 'Date', trendDatesFormula()],
    [DASH.LABEL_COL, 'Labels', labelBreakdownFormula()]
  ];

  blocks.forEach(function (block) {
    sheet.getRange(block[0] + (DASH.BLOCK_ROW - 1)).setValue(block[1]).setFontWeight('bold');
    sheet.getRange(block[0] + DASH.BLOCK_ROW).setFormula(localizeFormula(block[2], sep));
  });

  // The columns that sit beside a block rather than starting one. Every
  // header names *its own column* rather than the block, because two of them
  // become a chart's series names — and "Spending by month" as a legend entry
  // for the this-year bars would be a label that is not true of them.
  var monthly = [
    [nextColumn_(DASH.MONTHLY_COL, 1), 'This year', spendByMonthFormula(0)],
    [nextColumn_(DASH.MONTHLY_COL, 2), 'Last year', spendByMonthFormula(-1)],
    [nextColumn_(DASH.TREND_COL, 1), 'Net worth', trendValuesFormula()]
  ];

  monthly.forEach(function (block) {
    sheet.getRange(block[0] + (DASH.BLOCK_ROW - 1)).setValue(block[1]).setFontWeight('bold');
    sheet.getRange(block[0] + DASH.BLOCK_ROW).setFormula(localizeFormula(block[2], sep));
  });
}

/**
 * Blank the region this file owns, before rewriting it.
 *
 * Every other tab is built by overwriting the cells it uses, which is right
 * when the layout is the schema and the schema does not move. This one is a
 * *view*, and a view's layout does move: the blocks used to sit in A, D and H
 * at row 11, and the health strip used to start at row 2. Overwriting alone
 * would leave the previous arrangement sitting there as orphaned headers and
 * live `QUERY`s — two dashboards on one tab, both looking plausible, one of
 * them months out of date.
 *
 * **Columns A to X only**, which is the region the blocks occupy. Anything you
 * have put to the right of them is untouched, and that is the same boundary
 * every other "yours" region in this project uses: `transactions` from P,
 * `_import_staged` past the schema. Charts are not cell content and survive.
 */
function clearGeneratedBlocks_(sheet) {
  var width = columnIndexOf_(nextColumn_(DASH.LABEL_COL, 2));
  sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 1), width).clearContent();
}

/** The column `offset` places to the right of a letter. */
function nextColumn_(letter, offset) {
  return columnLetter(columnIndexOf_(letter) + offset);
}

function columnIndexOf_(letters) {
  var n = 0;
  for (var i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  }
  return n;
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
 * How old the backlog is, next to how big it is.
 *
 * A count on its own does not distinguish thirty rows from this week — which
 * is a normal Tuesday — from thirty rows going back to March, which means the
 * review queue stopped being cleared and nothing said so. The date is the part
 * that tells you which one you have.
 */
function oldestUnconfirmedFormula() {
  var uid = txRange_('uid');
  var date = txRange_('booking_date');
  var confirmed = txRange_('confirmed');

  return '=IF(COUNTA(' + uid + ')-COUNTIF(' + confirmed + ',TRUE)=0,"",' +
    'IFERROR("oldest "&TEXT(MIN(FILTER(' + date + ',LEN(' + uid + ')>0,' +
    confirmed + '<>TRUE)),"yyyy-mm-dd"),""))';
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
// This month
// ---------------------------------------------------------------------------

/**
 * Net worth — every active account you have said counts, in the base currency.
 *
 * Three conditions, and the third is the one that is easy to leave out. An
 * account's `balance` is in **that account's** currency: Fineco alone supplies
 * CHF, GBP and USD pockets, and adding those into a euro total produces a
 * number that is wrong by whatever the exchange rate is while looking exactly
 * like a right one. So the total is restricted to the base currency and
 * `netWorthCaveatFormula` says out loud how many accounts that left out.
 *
 * Refusing to add them is the same decision `amount_eur` already makes for
 * transactions: blank rather than unconverted.
 */
function netWorthFormula() {
  return '=SUMIFS(' + accountsRange_('balance') + ',' +
    accountsRange_('include_in_net_worth') + ',TRUE,' +
    accountsRange_('active') + ',TRUE,' +
    accountsRange_('currency') + ',' + configLookup_('base_currency', '"EUR"') + ')';
}

/**
 * What the total left out, or nothing at all when it left out nothing.
 *
 * A caveat printed every day is a caveat nobody reads, so this is blank in the
 * ordinary case. It appears only when there is an active account whose money
 * is genuinely not in that number — which is the day you would otherwise spend
 * wondering why the figure looks low.
 */
function netWorthCaveatFormula() {
  var missed = 'COUNTIFS(' + accountsRange_('account_id') + ',"<>",' +
    accountsRange_('active') + ',TRUE)-' +
    'COUNTIFS(' + accountsRange_('account_id') + ',"<>",' +
    accountsRange_('active') + ',TRUE,' +
    accountsRange_('include_in_net_worth') + ',TRUE,' +
    accountsRange_('currency') + ',' + configLookup_('base_currency', '"EUR"') + ')';

  return '=IF(' + missed + '=0,"",' + missed +
    '&" active account(s) not counted — either not in net worth, or not in "&' +
    configLookup_('base_currency', '"EUR"') + ')';
}

/** Money out so far this month, as a positive number. */
function spentThisMonthFormula() {
  return '=-' + monthToDateSum_(0, '"<0"');
}

/** Money in so far this month. */
function earnedThisMonthFormula() {
  return '=' + monthToDateSum_(0, '">0"');
}

/** Both together, which is the number that says whether the month is working. */
function netThisMonthFormula() {
  return '=' + monthToDateSum_(0, null);
}

/** The same stretch of last month, so the comparison is like for like. */
function spentLastMonthToDateFormula() {
  return '=-' + monthToDateSum_(-1, '"<0"');
}

/**
 * A month-to-date sum, `offset` months back.
 *
 * The end of the window is `EDATE(TODAY(), offset)` rather than "the same day
 * number", because EDATE clamps: a run on the 31st compares against the 30th
 * of a thirty-day month instead of silently reaching into the next one.
 *
 * `in_reports` carries the whole question of what counts. Nothing here filters
 * transfers or exclusions itself — that decision is made once, in the column,
 * and every block asks it the same way.
 */
function monthToDateSum_(offset, sign) {
  var start = offset === 0 ? 'EOMONTH(TODAY(),-1)+1' : 'EOMONTH(TODAY(),' + (offset - 1) + ')+1';
  var end = offset === 0 ? 'TODAY()' : 'EDATE(TODAY(),' + offset + ')';
  var amount = txRange_('amount_eur');

  return 'SUMIFS(' + amount + ',' +
    txRange_('booking_date') + ',">="&' + start + ',' +
    txRange_('booking_date') + ',"<="&' + end + ',' +
    txRange_('in_reports') + ',TRUE' +
    (sign ? ',' + amount + ',' + sign : '') + ')';
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

/**
 * Every active account, biggest balance first.
 *
 * `where <active> = true` rather than a criterion string, for the reason the
 * unconfirmed count is a subtraction: the column holds real booleans, and
 * comparing a boolean against text matches nothing while looking like a
 * filter that simply found no rows.
 */
function accountsBlockFormula() {
  var a = function (name) { return colOf(ACCOUNT_COLUMNS, name); };

  return '=IFERROR(QUERY(' + accountsQueryRange_() + ',' +
    '"select ' + a('name') + ', ' + a('kind') + ', ' + a('balance') + ', ' +
    a('currency') + ', ' + a('balance_updated_at') + ' ' +
    'where ' + a('active') + ' = true ' +
    'order by ' + a('balance') + ' desc ' +
    'label ' + a('name') + ' \'Account\', ' + a('kind') + ' \'Kind\', ' +
    a('balance') + ' \'Balance\', ' + a('currency') + ' \'Cur\', ' +
    a('balance_updated_at') + ' \'Updated\'",0),"no accounts yet")';
}

/**
 * This month's spending, worst first.
 *
 * `in_reports = true` is the whole filter. It replaced `type <> 'transfer'`,
 * which was the same idea implemented six times and honoured `excluded`
 * nowhere — a row you had deliberately ticked out still counted here.
 *
 * `< 0` keeps a refund from appearing as a category you earned money in. The
 * net figure in the left-hand strip is where a refund belongs.
 *
 * Sorted ascending because expenses are negative, so ascending *is* worst first.
 */
function monthByCategoryFormula() {
  return '=IFERROR(QUERY(' + txQueryRange_() + ',' +
    '"select ' + q_('category') + ', sum(' + q_('amount_eur') + ') ' +
    'where ' + q_('in_reports') + ' = true ' +
    'and ' + q_('amount_eur') + ' < 0 ' +
    'and ' + q_('booking_date') + ' >= date \'"&TEXT(EOMONTH(TODAY(),-1)+1,"yyyy-mm-dd")&"\' ' +
    'group by ' + q_('category') + ' ' +
    'order by sum(' + q_('amount_eur') + ') asc ' +
    'label ' + q_('category') + ' \'Category\', sum(' + q_('amount_eur') + ') \'Spend\'",0),' +
    '"nothing yet")';
}

/**
 * The category block's total as money out, which is what a chart should show.
 *
 * `ISNUMBER` rather than `LEN`, because the block's first cell holds the text
 * "nothing yet" when there is no spending at all, and negating a string gives
 * `#VALUE!` across the column — an error where the honest answer is an empty
 * chart.
 */
function categorySpendFormula() {
  var totals = '$' + nextColumn_(DASH.CATEGORY_COL, 1) + '$' + DASH.BLOCK_ROW +
    ':$' + nextColumn_(DASH.CATEGORY_COL, 1);
  return '=ARRAYFORMULA(IF(ISNUMBER(' + totals + '),-' + totals + ',""))';
}

/**
 * Twelve month names, for the two-series comparison beside them.
 *
 * `SEQUENCE` rather than a QUERY grouped by month, because the question here
 * is "is this normal for me", and that needs the same twelve buckets both
 * years — including the months this year that have not happened yet, which a
 * grouped query would simply omit and quietly misalign the two series by.
 */
function monthLabelsFormula() {
  return '=ARRAYFORMULA(TEXT(DATE(YEAR(TODAY()),SEQUENCE(12),1),"mmm"))';
}

/**
 * Spending per calendar month of one year, as twelve positive numbers.
 *
 * `DATE(year, month+1, 1)` for the end of each bucket, rather than `EDATE`:
 * DATE rolls a thirteenth month into the next January by itself, and it is the
 * function this project has already proved vectorises. The array idiom here is
 * SUMIFS over vectorised criteria, which is the same one `labelCountFormula`
 * has relied on since phase 6.
 *
 * Months in the future are blank rather than zero. A zero is a real answer —
 * "you spent nothing in November" — and plotting it makes this year's line
 * fall off a cliff every January.
 */
function spendByMonthFormula(yearOffset) {
  var year = yearOffset === 0 ? 'YEAR(TODAY())' : 'YEAR(TODAY())' + yearOffset;
  var first = 'DATE(' + year + ',SEQUENCE(12),1)';
  var next = 'DATE(' + year + ',SEQUENCE(12)+1,1)';
  var amount = txRange_('amount_eur');

  return '=ARRAYFORMULA(IF(' + first + '>EOMONTH(TODAY(),0),"",' +
    '-SUMIFS(' + amount + ',' +
    txRange_('booking_date') + ',">="&' + first + ',' +
    txRange_('booking_date') + ',"<"&' + next + ',' +
    txRange_('in_reports') + ',TRUE,' +
    amount + ',"<0")))';
}

/** The days the net worth trend covers, oldest first. */
function trendDatesFormula() {
  var days = trendDays_();
  return '=ARRAYFORMULA(SEQUENCE(' + days + ',1,TODAY()-' + (days - 1) + ',1))';
}

/**
 * Net worth on each of those days, derived from `transactions` rather than
 * from a history nobody kept.
 *
 *   balance_at(d) = balance_now − Σ amount_eur booked after d
 *
 * A `_balances` snapshot tab would have been a tab, a sync change and a
 * backfill job to produce something strictly worse: it would start
 * accumulating from the day it shipped, where this reaches back as far as the
 * transactions do. It would not have helped where derivation is weakest
 * either — an `asset` balance only moves when you type a new number into
 * `balance_manual`, so a daily snapshot of one flat-lines exactly as this
 * does.
 *
 * Three things it genuinely costs, worth knowing before the line looks wrong:
 *
 *   **It is anchored to today.** A transaction that is missing shifts the
 *   whole curve by that amount rather than showing a step. The shape and the
 *   current value stay right, which is what a trend is for.
 *
 *   **It does not filter `in_reports`.** A transfer between your own accounts
 *   moves a balance, so it belongs here even though it is not spending. This
 *   is the one place in the project that reads every row, and it is correct
 *   precisely because net worth is not a spending question.
 *
 *   **Non-EUR rows contribute nothing**, since `amount_eur` is blank for them,
 *   while their balance is in today's total. Those accounts flat-line. Same
 *   trade as the net worth figure itself, and `netWorthCaveatFormula` is what
 *   says so.
 */
function trendValuesFormula() {
  var days = trendDays_();
  var dates = '$' + DASH.TREND_COL + '$' + DASH.BLOCK_ROW + ':$' + DASH.TREND_COL +
    '$' + (DASH.BLOCK_ROW + days - 1);

  return '=ARRAYFORMULA(IF(LEN(' + dates + ')=0,"",' +
    netWorthFormula().slice(1) + '-' +
    'SUMIFS(' + txRange_('amount_eur') + ',' +
    txRange_('booking_date') + ',">"&' + dates + ')))';
}

/**
 * How far back the trend goes, read once at build time rather than by the
 * formula.
 *
 * Deliberately not a `configLookup_`: the chart's range is fixed when the
 * chart is created, so a formula that resized itself would leave the plot
 * reading a range that no longer matches. One number, one place, changed by
 * re-running setup — which is what changing `trend_days` already implies.
 */
function trendDays_() {
  var days = configNumber_(readConfig_(), 'trend_days');
  return days >= 7 ? Math.floor(days) : 90;
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
function accountsRange_(name) { return sheetRange_(TABS.ACCOUNTS, ACCOUNT_COLUMNS, name); }

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

/** The same rule, for `accounts`. */
function accountsQueryRange_() {
  return TABS.ACCOUNTS + '!$A$2:$' +
    colOf(ACCOUNT_COLUMNS, ACCOUNT_COLUMNS[ACCOUNT_COLUMNS.length - 1]);
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
  sheet.getRange('A' + DASH.MONTH_ROW + ':A' + (DASH.MONTH_ROW + 5)).setFontWeight('bold');

  sheet.getRange('B' + DASH.HEALTH_ROW).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('B' + (DASH.HEALTH_ROW + 5)).setNumberFormat('yyyy-mm-dd');
  sheet.getRange('B' + DASH.MONTH_ROW + ':B' + (DASH.MONTH_ROW + 5)).setNumberFormat(money);

  // The money column of each block, applied to a generous depth rather than to
  // the exact height, which is not knowable until the QUERY has run.
  [
    nextColumn_(DASH.ACCOUNTS_COL, 2),
    nextColumn_(DASH.CATEGORY_COL, 1),
    DASH.CATEGORY_VALUE_COL,
    nextColumn_(DASH.MONTHLY_COL, 1),
    nextColumn_(DASH.MONTHLY_COL, 2),
    nextColumn_(DASH.TREND_COL, 1),
    nextColumn_(DASH.LABEL_COL, 2)
  ].forEach(function (column) {
    sheet.getRange(column + DASH.BLOCK_ROW + ':' + column).setNumberFormat(money);
  });

  sheet.getRange(nextColumn_(DASH.ACCOUNTS_COL, 4) + DASH.BLOCK_ROW + ':' +
    nextColumn_(DASH.ACCOUNTS_COL, 4)).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange(DASH.TREND_COL + DASH.BLOCK_ROW + ':' + DASH.TREND_COL)
    .setNumberFormat('yyyy-mm-dd');

  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(3, 260);

  flagStaleBalances_(sheet);
}

/**
 * A balance nobody has refreshed, coloured rather than counted.
 *
 * The alternative is a column of timestamps you have to read and subtract from
 * today in your head, every time, to notice the one that stopped moving. A
 * consent that lapsed three weeks ago leaves a balance sitting there looking
 * exactly like a current one — that is the failure this catches, and it is a
 * glance rather than an exercise.
 *
 * Rebuilt from scratch each run rather than appended to, because
 * `setConditionalFormatRules` replaces the whole list: adding to what is
 * already there would stack a duplicate rule on every `setup()`.
 *
 * The condition is written **without a single comma**, and that is not style.
 * `localizeFormula` translates the formulas this project writes into cells, at
 * the one boundary they all pass through — and a conditional-format rule does
 * not go through that boundary. In a decimal-comma locale `=AND(a,b)` would be
 * a parse failure with no cell to show `#ERROR!` in: the rule would simply
 * never fire, and a stale balance would go on looking current. So the
 * condition is two tests multiplied and compared to zero, which needs no
 * separator and, by ending in a comparison, returns a real boolean rather than
 * a `1` — the other trap in the same sentence.
 */
function flagStaleBalances_(sheet) {
  var updated = nextColumn_(DASH.ACCOUNTS_COL, 4);
  var anchor = '$' + updated + DASH.BLOCK_ROW;
  var range = sheet.getRange(updated + DASH.BLOCK_ROW + ':' + updated + 200);

  var rule = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=((' + anchor + '<>"")*(' + anchor + '<TODAY()-3))>0')
    .setBackground('#fce8e6')
    .setRanges([range])
    .build();

  sheet.setConditionalFormatRules([rule]);
}
