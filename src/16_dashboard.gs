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
 * Blocks grow **downwards** and are stacked **vertically**, each one bounded by
 * an explicit `limit` so it cannot reach the block below. This file used to
 * argue the opposite — separate them by column, because a QUERY that outgrows
 * its neighbour's start row collides and a collision shows as `#REF!` across a
 * whole block. `DASH` below carries the full argument and why it turned over:
 * separation was a real fix for a real problem, on a tab nobody reads on a
 * phone.
 *
 * Everything on this tab is a formula. The charts that read these blocks are
 * built in 17_analytics.gs, which loads after this file and takes its ranges
 * from `DASH` below — the seam is "16 is what you read, 17 is what you plot".
 *
 * Colour is the third thing here and it is load-bearing rather than decorative:
 * `DASH_COLOR` is a three-word vocabulary, and `flagDashboardStates_` explains
 * why every rule that uses it is an equality against a hidden number.
 */

/**
 * Where each block starts.
 *
 * **Everything you read is in A:E and stacked vertically.** That reverses the
 * arrangement this file used to argue for, and the argument is worth keeping
 * because the reversal turns on one fact it did not have.
 *
 * The old layout put each block in its own column band — A, E, K, O, S, V, Z —
 * because blocks grow downwards and a QUERY that outgrew its neighbour's start
 * row would collide, which shows as `#REF!` across a whole block rather than as
 * one wrong cell. That reasoning is still correct. What it missed is that the
 * tab is read on a phone, where the scroll axis is vertical and a dashboard
 * twenty-nine columns wide is a dashboard you cannot see. Avoiding a collision
 * by spreading sideways solved a real problem by creating a worse one.
 *
 * So the collision is prevented at the source instead: **every block that can
 * grow carries an explicit `limit`**, and its slot below is sized to that limit
 * with room to spare. A bounded block cannot reach its neighbour. That is a
 * stronger guarantee than separation was — separation only moved the collision
 * somewhere you would not notice it.
 *
 * The feed columns are the second half of the answer. Three of the old blocks
 * existed only to be plotted: the category totals, the twelve-month pair, and
 * the ninety-day net worth series. Reading them as rows was never the point,
 * and ninety rows of dates is most of what "the dashboard is endless numbers"
 * meant. They stay on the tab, because a chart reads a range and the range has
 * to be somewhere — but they sit in G:S and `hideFeedColumns_` hides them. What
 * you see of them is the chart.
 */
var DASH = {
  NEXT_STEP_CELL: 'A2',   //      the one sentence a new book needs
  HEALTH_ROW: 3,          // A:C
  HEALTH_ROWS: 5,
  MONTH_ROW: 11,          // A:C  six rows, header on 10
  MONTH_ROWS: 6,
  REVIEW_ROW: 19,         // A:D  ten rows, header on 18
  REVIEW_ROWS: 10,        // how many of the queue to surface here

  CHART_ROWS: [31, 51, 71],
  CHART_COL: 1,

  ACCOUNTS_ROW: 92,       // A:E  header on 91; the QUERY's own header on 92
  ACCOUNTS_LIMIT: 15,
  SYNC_COL: 'F',          //   F  what is wrong with this account, if anything
  LABELS_ROW: 111,        // A:C  header on 110; the QUERY's own header on 111
  LABELS_LIMIT: 15,

  // Hidden. Most of these exist to be the domain or the series of a chart;
  // the first two exist to be numbers a conditional-format rule can compare
  // against. None of them is worth a row of your screen.
  FEED_ROW: 3,
  FEED_COL: 'G',          // where the hidden region starts
  FLAG_COL: 'G',          //   G  how bad this row is: 2, 1, 0, or blank
  CONSENT_COL: 'H',       //   H  days left on this account's consent
  CATEGORY_COL: 'J',      // J:K  category, signed total
  CATEGORY_VALUE_COL: 'L',//   L  the same total as money out, for the chart
  MONTHLY_COL: 'N',       // N:P  month, this year, last year
  TREND_COL: 'R'          // R:S  date, net worth on that date
};

/**
 * The palette, in one place because it is a language rather than decoration.
 *
 * Three states and no more: something is **wrong** and you should act, something
 * **wants attention** but is not yet a problem, and something is **yours to
 * type into**. A fourth colour would mean nothing on sight, and a dashboard
 * whose colours you have to interpret is a dashboard whose colours you ignore.
 *
 * Nothing is coloured for being good. Green-when-fine spends the reader's
 * attention every day to say what silence already says, and it is what makes a
 * red one stop registering.
 */
var DASH_COLOR = {
  BAD: '#fce8e6',         // act now: consent expired, sync stopped
  WARN: '#fef7e0',        // act soon: consent lapsing, a backlog forming
  INPUT: '#e8f0fe'        // this cell is yours — type here, pick here
};

function buildDashboard_(ss, sep) {
  var sheet = ss.getSheetByName(TABS.DASHBOARD);
  if (!sheet) return;

  clearGeneratedBlocks_(sheet);

  sheet.getRange('A1').setValue('Spendsheet');
  sheet.getRange('A1').setFontSize(14).setFontWeight('bold');
  sheet.getRange(DASH.NEXT_STEP_CELL)
    .setFormula(localizeFormula(nextStepFormula(), sep)).setFontWeight('bold');

  writeHealthStrip_(sheet, sep);
  writeMonthStrip_(sheet, sep);
  writeBlocks_(sheet, sep);
  formatDashboard_(sheet);
  hideFeedColumns_(sheet);
}

/**
 * The one sentence a book needs, which for a new one is "start here".
 *
 * A fresh copy of this project opens on twenty-four tabs and a dashboard
 * reading `never`, and nothing anywhere says what to do about it. That is the
 * single biggest thing between this repo and someone else being able to use
 * it: every other piece of onboarding is written down in `docs/`, and the
 * person who most needs it is the one who has not opened `docs/` yet.
 *
 * So it is a formula on the tab that opens first, and it answers in the order
 * the answers stop mattering:
 *
 *   1. no accounts at all — you have not connected a bank
 *   2. accounts but no transactions — you have, and not synced
 *   3. a consent has expired — the sync is running and fetching nothing
 *   4. the sync has never run — the triggers are not installed
 *   5. rows are waiting to be categorised
 *
 * **Blank when there is nothing to do**, which is the ordinary day and the same
 * rule `netWorthCaveatFormula` follows: a line printed every day is a line
 * nobody reads, and its whole value is being unusual.
 *
 * It reads the health strip's own cells rather than recomputing what they say.
 * Two formulas answering "when did the sync last succeed" is how they end up
 * disagreeing, and this one would be the one you believed.
 */
function nextStepFormula() {
  var health = function (offset) { return '$B$' + (DASH.HEALTH_ROW + offset); };
  var names = accountsRange_('name');
  var uids = txRange_('uid');

  return '=IF(COUNTA(' + names + ')=0,' +
    '"Start here → Spendsheet → Connect a bank",' +
    'IF(COUNTA(' + uids + ')=0,' +
    '"Connected. Now run Spendsheet → Sync now",' +
    'IF(AND(ISNUMBER(' + health(1) + '),' + health(1) + '<=0),' +
    '"A bank consent has expired — Spendsheet → Connect a bank to reconnect",' +
    'IF(NOT(ISNUMBER(' + health(0) + ')),' +
    '"Nothing has synced yet — Spendsheet → Install triggers",' +
    'IF(' + health(3) + '>0,' +
    health(3) + '&" transactions need a category — open the review tab",' +
    '"")))))';
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
  var at = function (offset) { return '$B$' + (DASH.HEALTH_ROW + offset); };
  var warn = configLookup_('consent_warning_days', '7');

  // The fourth element is the severity this row should be coloured at, and it
  // is a formula in a hidden cell rather than a condition inside the
  // conditional-format rule. That is not indirection for its own sake: a
  // conditional-format rule cannot contain a comma (see `flagDashboardStates_`),
  // which rules out `AND`, `IF` and `VLOOKUP` — and `consent_warning_days`
  // lives in `_config`, which only a VLOOKUP can reach. Computing the severity
  // in a cell puts the threshold in one place and leaves the rule an equality.
  var rows = [
    ['Last successful sync', lastSyncFormula(), '',
      '=IF(NOT(ISNUMBER(' + at(0) + ')),2,IF(' + at(0) + '<TODAY()-2,2,IF(' + at(0) + '<TODAY()-1,1,0)))'],
    ['Consent expires in (days)', nearestConsentFormula(), '',
      '=IF(NOT(ISNUMBER(' + at(1) + ')),"",IF(' + at(1) + '<=0,2,IF(' + at(1) + '<=' + warn + ',1,0)))'],
    // Zero rows in a week is the detector for a run that reports success and
    // fetched nothing — the failure that looks healthiest from the outside.
    ['Rows in the last 7 days', recentRowsFormula(), '',
      '=IF(' + at(2) + '=0,1,0)'],
    ['Needs review', needsReviewFormula(), '',
      '=IF(' + at(3) + '>0,1,0)'],
    // Coloured on the *age* of the backlog rather than its size. Thirty
    // unconfirmed rows from this week is a normal Tuesday; thirty going back
    // to March means the queue stopped being cleared and nothing said so.
    ['Unconfirmed', unconfirmedFormula(), oldestUnconfirmedFormula(),
      '=IF(NOT(ISNUMBER($C$' + (DASH.HEALTH_ROW + 4) + ')),0,' +
      'IF($C$' + (DASH.HEALTH_ROW + 4) + '<TODAY()-60,1,0))']
    // There used to be a sixth row here, "Projected to run out on", read off a
    // ninety-day cashflow projection built from detected recurring payments.
    // Both went: the projection was the most machinery in the project per
    // question answered, and the question it answered is one the reports tab
    // gets at directly. `git log -- src/15_recurring.gs` has it.,
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
    if (row[3]) {
      sheet.getRange(DASH.FLAG_COL + at).setFormula(localizeFormula(row[3], sep));
    }
  });
}

/**
 * The blocks, in the order you scroll past them.
 *
 * Top to bottom is what needs doing, then what the money did, then what you
 * have and where it went — review first because it is the only block on the
 * tab that is a prompt rather than a fact, and a prompt below three charts is
 * a prompt you stop seeing.
 *
 * Each one is bounded, and its slot is sized to that bound with room over. See
 * the note on `DASH`: the bound is what makes the vertical stack safe, and it
 * has to be in the formula rather than in a comment, because a QUERY that
 * returns more rows than its slot has does not stop at the edge.
 */
function writeBlocks_(sheet, sep) {
  var stacked = [
    [DASH.REVIEW_ROW, 'Needs review', reviewQueueFormula(),
      ['Description', 'Amount', 'Guess']],
    [DASH.ACCOUNTS_ROW, 'Accounts', accountsBlockFormula(), []],
    [DASH.LABELS_ROW, 'Labels', labelBreakdownFormula(), []]
  ];

  stacked.forEach(function (block) {
    sheet.getRange('A' + (block[0] - 1)).setValue(block[1]).setFontWeight('bold');
    sheet.getRange('A' + block[0]).setFormula(localizeFormula(block[2], sep));

    // The review QUERY has no `label` clause, so it emits no header row of its
    // own and its four columns arrive unnamed. These name the columns it
    // spills into — a value, never a formula, because writing a formula into a
    // cell the spill needs is how you get `#REF!` across the whole block.
    block[3].forEach(function (name, i) {
      sheet.getRange(nextColumn_('A', i + 1) + (block[0] - 1))
        .setValue(name).setFontWeight('bold');
    });
  });

  // The hidden feed. Every header names *its own column* rather than the block
  // it belongs to, because two of them become a chart's series names — and
  // "Spending by month" as a legend entry for the this-year bars would be a
  // label that is not true of them.
  //
  // `CATEGORY_VALUE_COL` is the odd one and worth explaining: it is the
  // category block's total again, negated. `amount_base` is signed, so a
  // spending total is negative, and a bar chart of negative bars is legible but
  // reads as a mistake. QUERY cannot negate an aggregate — arithmetic on
  // `sum()` is not in the query language — so the sign is flipped in the one
  // place that can do it, next to the numbers it flips.
  // Beside the accounts block rather than in the feed loop below, because it
  // has to line up row for row with what the accounts QUERY spilled — the feed
  // all starts at FEED_ROW and this starts where the accounts do.
  sheet.getRange(DASH.SYNC_COL + (DASH.ACCOUNTS_ROW - 1)).setValue('Sync').setFontWeight('bold');
  sheet.getRange(DASH.SYNC_COL + DASH.ACCOUNTS_ROW)
    .setFormula(localizeFormula(accountSyncFormula(), sep));
  sheet.getRange(DASH.CONSENT_COL + DASH.ACCOUNTS_ROW)
    .setFormula(localizeFormula(consentDaysFormula(), sep));
  sheet.getRange(DASH.FLAG_COL + DASH.ACCOUNTS_ROW)
    .setFormula(localizeFormula(accountSeverityFormula(), sep));

  var feed = [
    [DASH.CATEGORY_COL, 'Category', monthByCategoryFormula()],
    [DASH.CATEGORY_VALUE_COL, 'Spend', categorySpendFormula()],
    [DASH.MONTHLY_COL, 'Month', monthLabelsFormula()],
    [nextColumn_(DASH.MONTHLY_COL, 1), 'This year', spendByMonthFormula(0)],
    [nextColumn_(DASH.MONTHLY_COL, 2), 'Last year', spendByMonthFormula(-1)],
    [DASH.TREND_COL, 'Date', trendDatesFormula()],
    [nextColumn_(DASH.TREND_COL, 1), 'Net worth', trendValuesFormula()]
  ];

  feed.forEach(function (block) {
    sheet.getRange(block[0] + (DASH.FEED_ROW - 1)).setValue(block[1]).setFontWeight('bold');
    sheet.getRange(block[0] + DASH.FEED_ROW).setFormula(localizeFormula(block[2], sep));
  });
}

/**
 * Hide the chart feed, every run.
 *
 * Not "hide it once and respect your choice afterwards", which is the contract
 * every other hidden column in this project uses. Those are columns you might
 * legitimately want to see — this is a ninety-row list of dates whose only
 * reader is a chart, and a dashboard is the one tab where what you see *is*
 * the feature. If you unhide it, the next `setup()` puts it back.
 */
function hideFeedColumns_(sheet) {
  var first = columnIndexOf_(DASH.FEED_COL);
  var last = columnIndexOf_(nextColumn_(DASH.TREND_COL, 1));
  sheet.hideColumns(first, last - first + 1);
}

/**
 * Days left on the consent covering each account in the block above.
 *
 * Hidden, and it exists so that `flagAccountHealth_` has a **number** to
 * compare against. A conditional-format rule cannot contain a comma — see
 * `flagStaleBalances_` for why — which rules out testing the text in the Sync
 * column with anything like `LEFT(F92,7)="expires"`. A numeric column costs one
 * hidden formula and makes every rule an arithmetic comparison.
 *
 * Two lookups rather than one because the join is two hops: the block shows an
 * account *name*, `accounts` maps that to a `connection_id`, and `_status` is
 * what knows when the consent dies. Both are `VLOOKUP`, which vectorises over
 * its search key inside `ARRAYFORMULA` — deliberately not `INDEX`, which does
 * not, and which shipped green in this project once already.
 *
 * Blank rather than zero for an account with no consent behind it. A cash tin
 * has no consent to expire and a `0` there would be a red row saying so every
 * day; `isBlankCell_`'s rule in formula form — an empty answer is not a zero
 * answer, and the two must not render the same.
 */
function consentDaysFormula() {
  var names = '$A$' + DASH.ACCOUNTS_ROW + ':$A$' +
    (DASH.ACCOUNTS_ROW + DASH.ACCOUNTS_LIMIT);

  var nameIndex = colIndex_(ACCOUNT_COLUMNS, 'name');
  var accountsRange = TABS.ACCOUNTS + '!$' + colOf(ACCOUNT_COLUMNS, 'name') + '$2:$' +
    colOf(ACCOUNT_COLUMNS, 'connection_id');
  var connection = 'VLOOKUP(' + names + ',' + accountsRange + ',' +
    (colIndex_(ACCOUNT_COLUMNS, 'connection_id') - nameIndex + 1) + ',FALSE)';

  // `_status` starts at connection_id, so the index is the column's own.
  var statusRange = TABS.STATUS + '!$' + colOf(STATUS_COLUMNS, 'connection_id') + '$2:$' +
    colOf(STATUS_COLUMNS, 'days_left');
  var days = 'VLOOKUP(' + connection + ',' + statusRange + ',' +
    colIndex_(STATUS_COLUMNS, 'days_left') + ',FALSE)';

  return '=ARRAYFORMULA(IF(LEN(' + names + ')=0,"",IFERROR(' + days + ',"")))';
}

/**
 * What is wrong with this account, in words, next to the account.
 *
 * The colour tells you *that* something is wrong at a glance; this tells you
 * *what* without a second tab. Both matter: a red row you have to go and
 * investigate is a red row you learn to scroll past.
 *
 * A non-bank account reads `—` rather than `no consent`. A cash tin and a flat
 * are not failing to sync, they have nothing to sync, and marking them as
 * problems every day is how the whole column stops being read.
 */
function accountSyncFormula() {
  var names = '$A$' + DASH.ACCOUNTS_ROW + ':$A$' +
    (DASH.ACCOUNTS_ROW + DASH.ACCOUNTS_LIMIT);
  var kinds = '$B$' + DASH.ACCOUNTS_ROW + ':$B$' +
    (DASH.ACCOUNTS_ROW + DASH.ACCOUNTS_LIMIT);
  var days = '$' + DASH.CONSENT_COL + '$' + DASH.ACCOUNTS_ROW + ':$' +
    DASH.CONSENT_COL + '$' + (DASH.ACCOUNTS_ROW + DASH.ACCOUNTS_LIMIT);

  return '=ARRAYFORMULA(IF(LEN(' + names + ')=0,"",' +
    'IF(' + kinds + '<>"' + ACCOUNT_KIND.BANK + '","—",' +
    'IF(NOT(ISNUMBER(' + days + ')),"reconnect — no consent",' +
    'IF(' + days + '<=0,"reconnect — consent expired",' +
    'IF(' + days + '<=' + configLookup_('consent_warning_days', '7') +
    ',"expires in "&' + days + '&" days",' +
    '"ok"))))))';
}

/**
 * How bad each account's state is, as a number a format rule can compare to.
 *
 * Three things can be wrong with an account and they are deliberately folded
 * into **one** severity rather than into three rules: the consent has expired,
 * the consent is about to, or the balance has not moved in days. A row is
 * coloured once, for the worst thing true of it, and the Sync column beside it
 * says which. Three overlapping rules would paint the same row three times and
 * leave you reading colours instead of words.
 *
 * A stale balance is a **warning**, not a failure. A weekend, a bank holiday
 * and a quiet current account all produce one, and colouring those red is how
 * red stops meaning anything.
 */
function accountSeverityFormula() {
  var span = function (letter) {
    return '$' + letter + '$' + DASH.ACCOUNTS_ROW + ':$' + letter + '$' +
      (DASH.ACCOUNTS_ROW + DASH.ACCOUNTS_LIMIT);
  };

  var names = span('A');
  var kinds = span('B');
  var updated = span(accountsUpdatedColumn_());
  var days = span(DASH.CONSENT_COL);
  var stale = configLookup_('stale_balance_days', '3');

  return '=ARRAYFORMULA(IF(LEN(' + names + ')=0,"",' +
    'IF(' + kinds + '<>"' + ACCOUNT_KIND.BANK + '","",' +
    'IF(NOT(ISNUMBER(' + days + ')),2,' +
    'IF(' + days + '<=0,2,' +
    'IF(' + days + '<=' + configLookup_('consent_warning_days', '7') + ',1,' +
    'IF(ISNUMBER(' + updated + ')*(' + updated + '<TODAY()-' + stale + ')=1,1,' +
    '0)))))))';
}

/**
 * The top of the review queue, on the tab you actually open.
 *
 * Reads the `review` tab rather than `transactions`, which is the whole trick.
 * The obvious version — QUERY `transactions` for unconfirmed rows — walks
 * straight into the trap that produced `in_reports`: `confirmed` is blank on
 * almost every row, QUERY types a column by majority, and `where AB = false`
 * against a column Sheets decided was text is either an error or a silent
 * nothing. `review` is built by code, one row per record, so it has no blank
 * majority and no type to infer.
 *
 * It also means the two can never disagree. This is the same queue, showing
 * its first ten — not a second opinion about what needs reviewing.
 *
 * Read-only, deliberately. Ticking here would need the uid beside each row,
 * and a QUERY's rows *move* when the data under them changes: confirm the
 * third and everything below shifts up by one, so the tick you were about to
 * make lands on a different transaction. That argument is in `17_review.gs`
 * and it is why the queue is a snapshot. Act on the `review` tab.
 */
function reviewQueueFormula() {
  var first = colOf(REVIEW_COLUMNS, 'booking_date');
  var last = colOf(REVIEW_COLUMNS, 'why');

  // Query letters are relative to the range, which starts at booking_date.
  var relative = function (name) {
    return columnLetter(colIndex_(REVIEW_COLUMNS, name) - colIndex_(REVIEW_COLUMNS, 'booking_date') + 1);
  };

  return '=IFERROR(QUERY(' + TABS.REVIEW + '!$' + first + '$2:$' + last + ',' +
    '"select ' + relative('booking_date') + ', ' + relative('description') + ', ' +
    relative('amount_base') + ', ' + relative('guess') +
    ' limit ' + DASH.REVIEW_ROWS + '",0),"")';
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
 * The width is **derived from the rightmost block**, not written down, so
 * adding a block cannot leave a strip of the old layout behind — which is the
 * bug this function exists to prevent, and the one way of writing it that
 * cannot commit the bug itself. Anything you have put beyond that is
 * untouched, the same boundary every other "yours" region in this project
 * uses. Charts are not cell content and survive.
 */
function clearGeneratedBlocks_(sheet) {
  var width = columnIndexOf_(nextColumn_(DASH.TREND_COL, 1));
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
 * Refusing to add them is the same decision `amount_base` already makes for
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
  var amount = txRange_('amount_base');

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
 *
 * The `limit` is what lets this sit above another block rather than beside it.
 * Fifteen active accounts is already more than four banks produce, and the
 * sixteenth going missing from a dashboard is a smaller failure than the whole
 * labels block below turning into `#REF!` — which is the alternative, and the
 * one you would not be able to read the cause of.
 */
function accountsBlockFormula() {
  var a = function (name) { return colOf(ACCOUNT_COLUMNS, name); };

  return '=IFERROR(QUERY(' + accountsQueryRange_() + ',' +
    '"select ' + a('name') + ', ' + a('kind') + ', ' + a('balance') + ', ' +
    a('currency') + ', ' + a('balance_updated_at') + ' ' +
    'where ' + a('active') + ' = true ' +
    'order by ' + a('balance') + ' desc ' +
    'limit ' + DASH.ACCOUNTS_LIMIT + ' ' +
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
    '"select ' + q_('category') + ', sum(' + q_('amount_base') + ') ' +
    'where ' + q_('in_reports') + ' = true ' +
    'and ' + q_('amount_base') + ' < 0 ' +
    'and ' + q_('booking_date') + ' >= date \'"&TEXT(EOMONTH(TODAY(),-1)+1,"yyyy-mm-dd")&"\' ' +
    'group by ' + q_('category') + ' ' +
    'order by sum(' + q_('amount_base') + ') asc ' +
    'label ' + q_('category') + ' \'Category\', sum(' + q_('amount_base') + ') \'Spend\'",0),' +
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
  var totals = '$' + nextColumn_(DASH.CATEGORY_COL, 1) + '$' + DASH.FEED_ROW +
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
  var amount = txRange_('amount_base');

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
 *   balance_at(d) = balance_now − Σ amount_base booked after d
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
 *   **Non-EUR rows contribute nothing**, since `amount_base` is blank for them,
 *   while their balance is in today's total. Those accounts flat-line. Same
 *   trade as the net worth figure itself, and `netWorthCaveatFormula` is what
 *   says so.
 */
function trendValuesFormula() {
  var days = trendDays_();
  var dates = '$' + DASH.TREND_COL + '$' + DASH.FEED_ROW + ':$' + DASH.TREND_COL +
    '$' + (DASH.FEED_ROW + days - 1);

  return '=ARRAYFORMULA(IF(LEN(' + dates + ')=0,"",' +
    netWorthFormula().slice(1) + '-' +
    'SUMIFS(' + txRange_('amount_base') + ',' +
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
    'limit ' + DASH.LABELS_LIMIT + ' ' +
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

  sheet.getRange('A' + DASH.HEALTH_ROW + ':A' + (DASH.HEALTH_ROW + DASH.HEALTH_ROWS - 1))
    .setFontWeight('bold');
  sheet.getRange('A' + DASH.MONTH_ROW + ':A' + (DASH.MONTH_ROW + DASH.MONTH_ROWS - 1))
    .setFontWeight('bold');

  sheet.getRange('B' + DASH.HEALTH_ROW).setNumberFormat('yyyy-mm-dd hh:mm');
  sheet.getRange('C' + (DASH.HEALTH_ROW + 4)).setNumberFormat('yyyy-mm-dd');
  sheet.getRange('B' + DASH.MONTH_ROW + ':B' + (DASH.MONTH_ROW + DASH.MONTH_ROWS - 1))
    .setNumberFormat(money);

  // Stacking the blocks put every money column in C — the review amount, the
  // account balance, the label total — so one range formats all three. It also
  // covers the empty rows between them, which costs nothing and means adding a
  // block does not mean remembering to add a format.
  sheet.getRange('C' + DASH.REVIEW_ROW + ':C' + (DASH.LABELS_ROW + DASH.LABELS_LIMIT))
    .setNumberFormat(money);

  sheet.getRange('A' + DASH.REVIEW_ROW + ':A' + (DASH.REVIEW_ROW + DASH.REVIEW_ROWS))
    .setNumberFormat('yyyy-mm-dd');
  sheet.getRange(accountsUpdatedColumn_() + DASH.ACCOUNTS_ROW + ':' +
    accountsUpdatedColumn_() + (DASH.ACCOUNTS_ROW + DASH.ACCOUNTS_LIMIT))
    .setNumberFormat('yyyy-mm-dd hh:mm');

  // The feed, formatted for the chart's benefit rather than yours: an axis
  // reads its labels from the cells, so a raw serial number where a date
  // belongs plots as 46000 rather than as a day.
  [
    nextColumn_(DASH.CATEGORY_COL, 1),
    DASH.CATEGORY_VALUE_COL,
    nextColumn_(DASH.MONTHLY_COL, 1),
    nextColumn_(DASH.MONTHLY_COL, 2),
    nextColumn_(DASH.TREND_COL, 1)
  ].forEach(function (column) {
    sheet.getRange(column + DASH.FEED_ROW + ':' + column).setNumberFormat(money);
  });
  sheet.getRange(DASH.TREND_COL + DASH.FEED_ROW + ':' + DASH.TREND_COL)
    .setNumberFormat('yyyy-mm-dd');

  // A is every block's label column and also the strips' row names, which are
  // the longest text on the tab. B is the review description.
  sheet.setColumnWidth(1, 200);
  sheet.setColumnWidth(2, 240);
  sheet.setColumnWidth(3, 120);

  flagDashboardStates_(sheet);
}

/** Where `balance_updated_at` lands once the accounts QUERY has spilled. */
function accountsUpdatedColumn_() {
  return nextColumn_('A', 4);
}

/**
 * Colour, as the answer to "is anything wrong, and where".
 *
 * The alternative is a column of timestamps and day counts you read and
 * subtract from today in your head, every time, to find the one that stopped
 * moving. A consent that lapsed three weeks ago leaves a balance sitting there
 * looking exactly like a current one — that is the failure this catches, and it
 * should be a glance rather than an exercise.
 *
 * Every rule here is `= $G<row> = 2` or `= $G<row> = 1`. All of the thinking is
 * in the hidden severity column, and that is the whole design:
 *
 *   **A conditional-format rule cannot contain a comma.** `localizeFormula`
 *   translates the formulas this project writes into *cells*, at the one
 *   boundary they all pass through — and `setConditionalFormatRules` is not
 *   that boundary. In a decimal-comma locale `=AND(a,b)` is a parse failure
 *   with no cell to show `#ERROR!` in: the rule simply never fires, and the
 *   thing it was watching goes on looking fine. So no rule here may use `AND`,
 *   `IF`, `OR` or `VLOOKUP`, which is every function you would reach for.
 *
 *   An equality against a number needs no separator, and by *being* a
 *   comparison it returns a real boolean rather than a `1` — the other trap in
 *   the same sentence, since Sheets does not coerce `1` to `TRUE`.
 *
 * That also means the thresholds live in `_config` and are read once, by a
 * formula in a cell, instead of being frozen as literals inside a rule no test
 * can evaluate.
 *
 * Rebuilt from scratch each run rather than appended to, because
 * `setConditionalFormatRules` replaces the whole list: adding to what is
 * already there would stack a duplicate rule on every `setup()`.
 */
function flagDashboardStates_(sheet) {
  var flag = function (row) { return '=$' + DASH.FLAG_COL + row; };

  var health = sheet.getRange(
    'A' + DASH.HEALTH_ROW + ':C' + (DASH.HEALTH_ROW + DASH.HEALTH_ROWS - 1));
  var accounts = sheet.getRange('A' + DASH.ACCOUNTS_ROW + ':' + DASH.SYNC_COL +
    (DASH.ACCOUNTS_ROW + DASH.ACCOUNTS_LIMIT));

  // The next-step line is amber whenever it says anything at all, which is the
  // one rule here that tests its own cell rather than the severity column: it
  // is already prose, so there is no severity to compute — it either has
  // something to tell you or it is empty. `LEN(x)>0` carries no comma.
  var step = sheet.getRange(DASH.NEXT_STEP_CELL + ':C2');

  var rules = [
    [step, '=LEN($' + DASH.NEXT_STEP_CELL + ')>0', DASH_COLOR.WARN],
    [health, flag(DASH.HEALTH_ROW) + '=2', DASH_COLOR.BAD],
    [health, flag(DASH.HEALTH_ROW) + '=1', DASH_COLOR.WARN],
    [accounts, flag(DASH.ACCOUNTS_ROW) + '=2', DASH_COLOR.BAD],
    [accounts, flag(DASH.ACCOUNTS_ROW) + '=1', DASH_COLOR.WARN]
  ].map(function (spec) {
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(spec[1])
      .setBackground(spec[2])
      .setRanges([spec[0]])
      .build();
  });

  sheet.setConditionalFormatRules(rules);
}

// ---------------------------------------------------------------------------
// recent — newest first, which `transactions` itself can never be
// ---------------------------------------------------------------------------

/**
 * The last thing you spent, at the top.
 *
 * `transactions` is append-only and **never sorted** — a partial sort destroys
 * row identity and every formula reference at once, which is the classic
 * spreadsheet catastrophe and the reason that rule exists. So the newest row is
 * the bottom row of four thousand, and the tab that holds the truth is the one
 * tab you cannot skim. This is the view that fixes that, by sorting a copy.
 *
 * ## Two blocks rather than one merged list
 *
 * Pending rows live on their own tab with only columns A–O: no `amount_base`, no
 * category, because none of that has been derived for a row the bank has not
 * booked yet. Merging the two into one date-sorted list would need an array
 * literal — `{booked; pending}` — and **this project cannot use array
 * literals.** `localizeFormula` rewrites unquoted commas to `;` at the write
 * boundary so a decimal-comma locale gets a formula it can parse, and an array
 * literal's separators are commas and semicolons that mean something. The
 * rewrite would corrupt it silently.
 *
 * That constraint pushes towards the better layout anyway. A pending charge is
 * a different kind of fact from a booked one — the amount can still change, and
 * it is not counted in any total on the dashboard — so a list that interleaved
 * them would need a column saying which is which, read on every row. Two blocks
 * say it once.
 *
 * Bounded for the same reason every dashboard block is: the booked block sits
 * below the pending one, and a QUERY that outgrows its slot lands `#REF!` on its
 * neighbour rather than stopping politely at the edge.
 */
var RECENT = {
  FILTER_ROW: 3,          // A:B  Year, Month — the two cells that are yours
  PENDING_ROW: 8,         // A:E  header on 7; the QUERY's own header on 8
  PENDING_LIMIT: 25,
  BOOKED_ROW: 37,         // A:E  header on 36; the QUERY's own header on 37
  BOOKED_LIMIT: 200,

  // Off to the right and hidden. The year list has to be a *range* rather than
  // a fixed list because which years you have is a fact about your data; the
  // month list is a range too, for a different reason — a formula has to turn
  // the name you picked back into a number, and MATCH against a range is how
  // that is done without an array literal.
  YEAR_COL: 'H',
  MONTH_COL: 'I'
};

/** The months, in calendar order. `All` first because it is the default. */
var RECENT_MONTHS = [
  'All', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

function buildRecent_(ss, sep) {
  var sheet = ss.getSheetByName(TABS.RECENT);
  if (!sheet) return;

  // Same argument as `clearGeneratedBlocks_`: this is a view, and a view's
  // layout moves between versions. Overwriting alone would leave the previous
  // arrangement sitting there as orphaned headers and live QUERYs.
  //
  // The two filter cells are read back first and restored after, because the
  // sweep is indiscriminate by design and they are the only cells on the tab
  // that are yours. Writing the defaults only-when-blank — which is what the
  // reports tab does — is not enough here: the clear makes them blank every
  // time, so re-running setup() while you were looking at last March would put
  // you back on All.
  var chosen = sheet.getRange('B' + RECENT.FILTER_ROW + ':B' + (RECENT.FILTER_ROW + 1))
    .getValues();

  sheet.getRange(1, 1, Math.max(sheet.getMaxRows(), 1), 5).clearContent();
  sheet.getRange('B' + RECENT.FILTER_ROW + ':B' + (RECENT.FILTER_ROW + 1))
    .setValues(chosen);

  sheet.getRange('A1').setValue('Recent').setFontSize(14).setFontWeight('bold');
  sheet.getRange('A2').setValue(
    'Newest first. Read-only — correct a category on the review tab, or in ' +
    'transactions itself.');

  writeRecentFilters_(sheet, sep);

  [
    [RECENT.PENDING_ROW, 'Pending — not booked yet, amounts can still change',
      recentPendingFormula()],
    [RECENT.BOOKED_ROW, 'Booked', recentBookedFormula()]
  ].forEach(function (block) {
    sheet.getRange('A' + (block[0] - 1)).setValue(block[1]).setFontWeight('bold');
    sheet.getRange('A' + block[0]).setFormula(localizeFormula(block[2], sep));
  });

  formatRecent_(sheet);
}

/**
 * `order by <date> desc`, which is the entire point of the tab.
 *
 * `where <date> is not null` rather than `where <uid> <> ''`, and the
 * difference is the trap that produced `in_reports`. Several tabs here carry an
 * open-ended ARRAYFORMULA, so a range reaches the sheet's last row rather than
 * the last record, and QUERY types a column by what is in the majority of it.
 * Against a mostly-empty column `<> ''` is comparing text to a column Sheets
 * may well have decided is something else. `is not null` is a null test rather
 * than a value comparison and needs no agreement about the column's type.
 */
function recentBookedFormula() {
  var date = q_('booking_date');

  return '=IFERROR(QUERY(' + txQueryRange_() + ',' +
    '"select ' + date + ', ' + q_('account_name') + ', ' + q_('description') + ', ' +
    q_('amount_base') + ', ' + q_('category') + ' ' +
    'where ' + date + ' is not null"' + recentWhereFormula_(date) + '&" ' +
    'order by ' + date + ' desc ' +
    'limit ' + RECENT.BOOKED_LIMIT + ' ' +
    'label ' + date + ' \'Date\', ' + q_('account_name') + ' \'Account\', ' +
    q_('description') + ' \'Description\', ' + q_('amount_base') + ' \'Amount\', ' +
    q_('category') + ' \'Category\'",0),"nothing yet")';
}

/**
 * The same, for rows the bank has taken but not settled.
 *
 * Shows `amount` and `currency` rather than `amount_base`, because `pending`
 * carries only the columns code writes — the derived ones do not exist there.
 * Naming the currency is what keeps that honest: an unconverted foreign amount
 * next to a euro one, with nothing saying which is which, is the mistake
 * `amount_base` exists to prevent.
 */
function recentPendingFormula() {
  var p = function (name) { return colOf(PENDING_COLUMNS, name); };
  var date = p('booking_date');

  return '=IFERROR(QUERY(' + pendingQueryRange_() + ',' +
    '"select ' + date + ', ' + p('account_name') + ', ' + p('description') + ', ' +
    p('amount') + ', ' + p('currency') + ' ' +
    'where ' + date + ' is not null ' +
    'order by ' + date + ' desc ' +
    'limit ' + RECENT.PENDING_LIMIT + ' ' +
    'label ' + date + ' \'Date\', ' + p('account_name') + ' \'Account\', ' +
    p('description') + ' \'Description\', ' + p('amount') + ' \'Amount\', ' +
    p('currency') + ' \'Cur\'",0),"nothing pending")';
}

/**
 * Two dropdowns, and the clause they add to the booked query.
 *
 * Deliberately **only the booked block**. A pending charge is a handful of rows
 * from the last few days by definition, so a year filter over it would be a
 * control that either changes nothing or empties it — a filter that can only
 * mislead is worse than no filter.
 *
 * The year list is a *range* rather than a fixed list, because which years you
 * have is a fact about your data: hard-coding 2020-2030 offers you years you
 * have nothing in and stops working in 2031. The month list is fixed, because
 * there are twelve of them and there always will be.
 *
 * `All` is the first entry of both, and choosing it contributes no clause at
 * all — the same rule the `reports` tab follows, so the default query is short
 * and the clauses you see are exactly the ones you chose.
 */
function writeRecentFilters_(sheet, sep) {
  var row = RECENT.FILTER_ROW;

  sheet.getRange('A' + row).setValue('Year').setFontWeight('bold');
  sheet.getRange('A' + (row + 1)).setValue('Month').setFontWeight('bold');

  // Only when blank. Re-running setup() while you are looking at last March
  // must not put you back on All.
  if (isBlankCell_(sheet.getRange('B' + row).getValue())) {
    sheet.getRange('B' + row).setValue('All');
  }
  if (isBlankCell_(sheet.getRange('B' + (row + 1)).getValue())) {
    sheet.getRange('B' + (row + 1)).setValue('All');
  }

  sheet.getRange('B' + row + ':B' + (row + 1)).setBackground(DASH_COLOR.INPUT);

  sheet.getRange(RECENT.YEAR_COL + '1').setValue('All');
  sheet.getRange(RECENT.YEAR_COL + '2')
    .setFormula(localizeFormula(recentYearsFormula(), sep));

  sheet.getRange(1, columnIndexOf_(RECENT.MONTH_COL), RECENT_MONTHS.length, 1)
    .setValues(RECENT_MONTHS.map(function (name) { return [name]; }));

  sheet.hideColumns(columnIndexOf_(RECENT.YEAR_COL), 2);

  [['B' + row, RECENT.YEAR_COL], ['B' + (row + 1), RECENT.MONTH_COL]]
    .forEach(function (pair) {
      sheet.getRange(pair[0]).setDataValidation(
        SpreadsheetApp.newDataValidation()
          .requireValueInRange(sheet.getRange(pair[1] + '1:' + pair[1]), true)
          .setAllowInvalid(false).build());
    });
}

/**
 * Every year you have a transaction in, newest first.
 *
 * `SORT(..., 1, FALSE)` because you are far more often looking for something
 * from this year than from five years ago, and a dropdown you have to scroll
 * to reach the common answer is a dropdown that has failed at its one job.
 */
function recentYearsFormula() {
  var dates = txRange_('booking_date');
  return '=IFERROR(SORT(UNIQUE(FILTER(YEAR(' + dates + '),LEN(' + dates + ')>0)),1,FALSE),"")';
}

/**
 * The where-clause fragment the two dropdowns contribute, as a formula.
 *
 * Concatenated into the query string rather than filtering the result, so the
 * work happens inside QUERY and the `limit` still means "the newest 200 *of
 * what you asked for*". Filtering afterwards would cap you at 200 rows overall
 * and then show whichever of them happened to match — a block that quietly
 * lies about being the most recent.
 *
 * `year()` and `month()` are QUERY's own scalar functions, so this needs no
 * derived column. QUERY's `month()` is **zero-based** — January is 0 — which is
 * the kind of off-by-one that produces a report that is right eleven twelfths
 * of the time, so the index into `RECENT_MONTHS` is what supplies it: `All` at
 * position 0 makes the list position and the month number line up for free.
 */
function recentWhereFormula_(dateColumn) {
  var year = '$B$' + RECENT.FILTER_ROW;
  var month = '$B$' + (RECENT.FILTER_ROW + 1);

  var months = '$' + RECENT.MONTH_COL + '$1:$' + RECENT.MONTH_COL;

  // MATCH returns the 1-based row, and `All` occupies the first of them, so
  // January lands on 2 and subtracting 2 gives QUERY the 0 it wants.
  return '&IF(' + year + '="All","",' +
    '" and year(' + dateColumn + ') = "&' + year + ')' +
    '&IF(' + month + '="All","",' +
    '" and month(' + dateColumn + ') = "&(MATCH(' + month + ',' + months + ',0)-2))';
}

/** The same rule as `txQueryRange_`: start at A or every letter above shifts. */
function pendingQueryRange_() {
  return TABS.PENDING + '!$A$2:$' +
    colOf(PENDING_COLUMNS, PENDING_COLUMNS[PENDING_COLUMNS.length - 1]);
}

function formatRecent_(sheet) {
  var money = currencyFormat_(readConfig_().base_currency || 'EUR');

  [RECENT.PENDING_ROW, RECENT.BOOKED_ROW].forEach(function (row) {
    var limit = row === RECENT.PENDING_ROW ? RECENT.PENDING_LIMIT : RECENT.BOOKED_LIMIT;
    sheet.getRange('A' + row + ':A' + (row + limit)).setNumberFormat('yyyy-mm-dd');
    sheet.getRange('D' + row + ':D' + (row + limit)).setNumberFormat(money);
  });

  sheet.setColumnWidth(1, 100);
  sheet.setColumnWidth(2, 140);
  sheet.setColumnWidth(3, 320);
  sheet.setFrozenRows(1);
}
