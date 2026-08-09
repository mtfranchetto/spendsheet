/**
 * 13_import.gs — bringing years of history in from another app.
 *
 * **There is no CSV parser here.** Loading a file is File → Import, which is a
 * one-time human operation and is not improved by wrapping it in a menu item
 * that can only fail in new ways. What this file builds is the tab in between:
 * `_import_staged`, a sheet of formulas that reads whatever landed in
 * `_import_raw`, maps it through `_import_map` and `_category_map`, and shows
 * you the result before any of it becomes history.
 *
 * Committing that result **is** a menu item — `importStagedRows` — and there is
 * no longer a documented way to do it by hand. The paste it replaced was two
 * blocks that had to land on the same row, values-only both times, filtered
 * first, without crossing the `amount_base` ARRAYFORMULA; the tab used to carry
 * a cell spelling out both targets. Keeping that cell meant the tab advertised
 * the procedure whose four silent failure modes are the reason the menu item
 * exists, and it could not offer what the menu item does: uids are matched, so
 * running it twice imports nothing the second time. One way in, and it is the
 * one that cannot half-land.
 *
 * That ordering is the point. You **see** which rows are excluded and why,
 * rather than trusting a log written after the fact. And when the mapping is
 * wrong — which it will be, because every export differs by app version and
 * locale — the fix is editing a tab, not editing code.
 *
 * Everything below is a pure string builder, so the formulas are unit-tested
 * without a spreadsheet. They are authored with commas and translated once by
 * `localizeFormula()` on the way in; see 04_setup.gs.
 *
 * **Cleaning up an overlap that already landed is `15_duplicates.gs`.** It used
 * to live at the bottom of this file, which was reasonable while it was one
 * menu item reading the cutoff's own leftovers, and stopped being reasonable
 * when it grew a second matching pass: this file is about *reading an export*,
 * and duplicates were becoming a third kind of thing in it.
 *
 * ## What a real BudgetBakers export looks like
 *
 * Probed against one, because the format could not be verified from any
 * primary source — their support page refuses automated fetches. Four things
 * were not what the design assumed:
 *
 *   **Semicolon-delimited**, so File → Import needs the separator set by hand.
 *
 *   **The sign is not in the amount.** Every amount is positive and direction
 *   lives in a `type` column of `Expense`/`Income` — precisely the same trap as
 *   `credit_debit_indicator`, and the same `ABS` guards it.
 *
 *   **`transfer` is a boolean, not a pair id.** The design expected the export
 *   to mark which two rows are the legs of one move; it only marks that a row
 *   *is* a transfer. So `transfer_group` is left empty and the category alone
 *   carries the meaning — kind `transfer`, which is what keeps it out of
 *   spending reports. Pairing legs is phase 7's job, and it has to work by
 *   amount and proximity anyway: in a real export the two legs of one transfer
 *   were three days apart.
 *
 *   **Amounts are not consistently formatted.** `116.87` and `1000` both
 *   appear, so the parse cannot assume a decimal point exists.
 */

/**
 * Columns of `_import_staged`. Only the ones an export can actually fill.
 *
 * This used to be `TX_COLUMNS_CODE` plus four, so that A–O lined up column for
 * column with `transactions` and the block could be pasted across in one go.
 * That alignment was the *only* argument for the five columns no CSV supplies —
 * `transaction_date`, `entry_reference`, `bank_transaction_code` and `mcc` are
 * bank fields an export has never carried, and `value_date` was filled with a
 * copy of `booking_date` to keep the shape.
 *
 * `importStagedRows` writes each column by name, so the alignment buys nothing
 * any more, and five always-empty columns on a tab you read before committing
 * are five columns of noise in the way of the two that matter. A fabricated
 * `value_date` was worse than noise: identical to the column beside it and
 * indistinguishable from something the bank actually said.
 *
 * The order still follows `transactions` because reading them side by side is
 * how you check a mapping — it just no longer has to be a *contiguous* prefix.
 */
var STAGED_COLUMNS = [
  'uid', 'account_id', 'account_name', 'booking_date', 'amount', 'currency',
  'description', 'counterparty', 'source', 'imported_at',
  'category_override', 'labels', 'include', 'why'
];

// ---------------------------------------------------------------------------
// Reading _import_raw through _import_map
// ---------------------------------------------------------------------------

/** Which preset the mapping tabs are keyed by. */
function importPreset_() {
  return configLookup_('import_preset', '"budgetbakers"');
}

/**
 * The source header mapped to one of our columns, looked up rather than
 * hardcoded — which is what makes correcting a wrong guess a spreadsheet edit
 * instead of a code change.
 */
function importSourceHeader_(target) {
  var map = TABS.IMPORT_MAP;
  var preset = importPreset_();
  var sources = 'FILTER(' + map + '!$B$2:$B,' + map + '!$A$2:$A=' + preset + ')';
  var targets = 'FILTER(' + map + '!$C$2:$C,' + map + '!$A$2:$A=' + preset + ')';
  return 'INDEX(' + sources + ',MATCH("' + target + '",' + targets + ',0))';
}

/**
 * A whole column of `_import_raw`, found by its header.
 *
 * `INDEX(range, 0, n)` returns the entire nth column as an array, which is what
 * lets one ARRAYFORMULA cover every imported row rather than a filled-down
 * formula that has to know how many rows you pasted.
 */
function importRawColumn_(target) {
  var raw = TABS.IMPORT_RAW;
  return 'INDEX(' + raw + '!$A$2:$AZ,0,MATCH(' + importSourceHeader_(target) +
    ',' + raw + '!$A$1:$AZ$1,0))';
}

// ---------------------------------------------------------------------------
// Parsing, without trusting the locale
// ---------------------------------------------------------------------------

/**
 * A number out of whatever the importer left behind.
 *
 * If Sheets already parsed the cell, that value is used. If it left it as text
 * — which is what happens to `116.87` in a decimal-comma locale, since a
 * two-digit group after a dot is not a valid thousands separator — the parts
 * either side of the dot are parsed as **integers**, which every locale reads
 * the same way. No `VALUE()` on a decimal string, ever: that is the one call
 * whose meaning changes with the spreadsheet's language.
 *
 * The minus is stripped and reapplied rather than carried through the split.
 * Splitting `-116.87` on the dot gives `-116` and `87`, and adding them lands
 * on `-115.13` — off by 1.74, wrong in the direction of *less* debt, and
 * plausible enough to survive a read-through. BudgetBakers never emits a
 * negative so this could not fire there, but a bank export that signs its
 * amounts is exactly the second preset someone adds.
 */
function importNumberExpr_(cell) {
  var raw = 'TRIM(TO_TEXT(' + cell + '))';
  var sign = 'IF(LEFT(' + raw + ',1)="-",-1,1)';
  var text = 'SUBSTITUTE(SUBSTITUTE(' + raw + ',",",""),"-","")';
  var dot = 'FIND(".",' + text + ')';
  var frac = 'MID(' + text + ',' + dot + '+1,9)';

  return 'IFERROR(IF(ISNUMBER(' + cell + '),' + cell + ',' + sign + '*' +
    'IF(ISERROR(' + dot + '),VALUE(' + text + '),' +
    'VALUE(LEFT(' + text + ',' + dot + '-1))+VALUE(' + frac + ')/POWER(10,LEN(' + frac + ')))),0)';
}

/**
 * A date out of an ISO 8601 timestamp.
 *
 * Built from the parts rather than handed to `DATEVALUE`, for the same reason
 * `parseIsoDate` in 07_transactions builds a Date from its components: a
 * string parse that depends on the locale, or on a UTC-to-local shift, moves
 * bookings across midnight and you find out months later in a monthly total.
 */
function importDateExpr_(cell) {
  var text = 'TO_TEXT(' + cell + ')';
  return 'IFERROR(IF(ISNUMBER(' + cell + '),INT(' + cell + '),' +
    'DATE(VALUE(LEFT(' + text + ',4)),VALUE(MID(' + text + ',6,2)),VALUE(MID(' + text + ',9,2)))),"")';
}

// ---------------------------------------------------------------------------
// The cutoff
// ---------------------------------------------------------------------------

/**
 * The earliest date the API already covers, per account.
 *
 * This is what stops an import duplicating everything the sync has already
 * fetched, and it is **derived rather than configured**: the cutoff for an
 * account is simply the oldest API-sourced row it already has. Nothing to set,
 * nothing to keep up to date, and it stays correct when you connect a second
 * bank six months later.
 *
 * A `QUERY` grouped by account, so a VLOOKUP against it vectorises.
 */
function importCutoffTable_() {
  var tx = TABS.TRANSACTIONS;
  var first = colIndex_(TX_COLUMNS, 'account_id');

  // QUERY numbers columns from the start of its range, not from column A.
  var account = columnLetter(colIndex_(TX_COLUMNS, 'account_id') - first + 1);
  var date = columnLetter(colIndex_(TX_COLUMNS, 'booking_date') - first + 1);
  var source = columnLetter(colIndex_(TX_COLUMNS, 'source') - first + 1);

  return 'QUERY(' + tx + '!$' + colOf(TX_COLUMNS, 'account_id') + '$2:$' +
    colOf(TX_COLUMNS, 'source') + ',"select ' + account + ', min(' + date + ') where ' +
    source + " = '" + TX_SOURCE_API + "' group by " + account +
    ' label min(' + date + ') \'\'",0)';
}

/**
 * account_id for a row, matched on the account name you gave it.
 *
 * `XLOOKUP` rather than `INDEX(…,MATCH(…))`, which is what this was and which
 * silently produced an empty column. **INDEX does not vectorise**: handed an
 * array of row numbers inside an ARRAYFORMULA it takes the first and discards
 * the rest, so one row's answer became every row's — and when that row missed,
 * the whole column went blank while the names it was matching sat there
 * looking correct.
 *
 * Not VLOOKUP, because `account_id` sits to the *left* of `name` and VLOOKUP
 * only reads rightwards. The usual fix is an array literal `{name,id}`, but
 * `localizeFormula` rewrites every unquoted comma to the locale separator,
 * which turns two columns into two stacked rows. XLOOKUP takes its ranges as
 * ordinary arguments and so survives that untouched.
 */
function importAccountIdExpr_() {
  var accounts = TABS.ACCOUNTS;
  var name = colOf(ACCOUNT_COLUMNS, 'name');
  var id = colOf(ACCOUNT_COLUMNS, 'account_id');

  return 'XLOOKUP(' + importRawColumn_('account_name') + ',' +
    accounts + '!$' + name + '$2:$' + name + ',' +
    accounts + '!$' + id + '$2:$' + id + ',"")';
}

// ---------------------------------------------------------------------------
// The staged columns
// ---------------------------------------------------------------------------

/**
 * The column of `_import_raw` that tells a staged row whether it exists at all.
 *
 * A function that builds the whole reference, rather than a bare range each
 * caller prefixes with the tab name, because the `!` between the two is the
 * entire difference between a formula and a parse error — and concatenating
 * `_import_raw` with `$A$2:$A` reads perfectly well at the call site while
 * producing `_import_raw$A$2:$A`, which Sheets cannot parse.
 *
 * It shipped that way. Every unit test passed: the parentheses balanced, the
 * quotes balanced, localisation was clean. None of them could tell, because
 * the harness never hands a formula to a spreadsheet — the same gap that let
 * the locale `#ERROR!` bug through, and the reason `assertsSheetRefs` below
 * now checks the one thing a string test actually can.
 */
function stagedAnchor_() {
  return TABS.IMPORT_RAW + '!$A$2:$A';
}

/**
 * TRUE for the rows that should become history.
 *
 * The trailing `>0` is not decoration. Twelve other columns ask
 * `include = TRUE`, and **Sheets does not coerce a number to a boolean in a
 * comparison** — `1 = TRUE` is FALSE there, where in Excel it is TRUE. Left as
 * the bare product of the two conditions this returns `1`, every one of those
 * comparisons misses, and the tab renders as a full set of blank columns with
 * `include` reading `1` and `why` giving the excluded-row reason. Both at
 * once, which is the tell: the two columns disagree because only one of them
 * is comparing types Sheets thinks are comparable.
 */
function stagedIncludeFormula() {
  var date = importDateExpr_(importRawColumn_('booking_date'));
  var cutoff = 'IFERROR(VLOOKUP(' + importAccountIdExpr_() + ',' + importCutoffTable_() + ',2,FALSE),0)';

  var hasDate = '(' + date + '<>"")';
  var beforeCutoff = '((' + cutoff + '=0)+(' + date + '<' + cutoff + ')>0)';

  return '=ARRAYFORMULA(IF(' + stagedAnchor_() + '="","",' +
    '(' + hasDate + '*' + beforeCutoff + ')>0))';
}

/** Why a row is not coming through, in words rather than a code. */
function stagedWhyFormula() {
  var include = '$' + colOf(STAGED_COLUMNS, 'include') + '2:$' + colOf(STAGED_COLUMNS, 'include');
  var date = importDateExpr_(importRawColumn_('booking_date'));

  return '=ARRAYFORMULA(IF(' + stagedAnchor_() + '="","",' +
    'IF(' + include + '=TRUE,"",' +
    'IF(' + date + '="","no readable date",' +
    '"already covered by the API for this account"))))';
}

/**
 * One staged column.
 *
 * Every one is blanked when the row is excluded, so the whole block can be
 * copied without first remembering to filter. An excluded row shows its reason
 * and nothing else — which is safer than a row that looks importable and is
 * only kept out by your attention.
 */
function stagedColumnFormula(expression) {
  var include = '$' + colOf(STAGED_COLUMNS, 'include') + '2:$' + colOf(STAGED_COLUMNS, 'include');

  return '=ARRAYFORMULA(IF(' + stagedAnchor_() + '="","",' +
    'IF(' + include + '=TRUE,' + expression + ',"")))';
}

/**
 * The signed amount.
 *
 * `ABS` first, then the sign from `type`. The same load-bearing guard as the
 * API path: an export that ever emits a negative amount *and* `Expense` would
 * otherwise double-negate into income, turning every total in the sheet upside
 * down while looking entirely plausible.
 *
 * **`type` is optional**, and that is what lets a second preset exist. Plenty
 * of exports carry no direction column at all and sign the amount instead —
 * `-42.00` for money out. Mapping `type` for those would mean pointing it at a
 * column that means something else. So when the preset has no `type` row the
 * lookup errors, and the fallback is the amount's own sign.
 *
 * Which means a preset that maps `type` to a header the file does not have
 * quietly gets the raw amount rather than an error. The check is the one you
 * would do anyway: `_import_staged` shows the signed amount for every row
 * before any of it is pasted, and an export imported with the wrong sign shows
 * a screen of positive numbers.
 */
function stagedAmountExpression() {
  var number = importNumberExpr_(importRawColumn_('amount'));
  return 'IFERROR(IF(' + importRawColumn_('type') + '="' + IMPORT_TYPE_EXPENSE + '",-1,1)*ABS(' +
    number + '),' + number + ')';
}

/**
 * A readable, non-hashed identity.
 *
 * Cross-source dedup cannot work — an imported row and the same transaction
 * fetched from the bank share no field that is stable between them — so there
 * is nothing for a hash to buy. The cutoff is what prevents overlap, and a key
 * you can read tells you where a row came from at a glance.
 */
function stagedUidExpression() {
  return '"csv:"&' + importPreset_() + '&":"&' + configLookup_('import_batch', '"import1"') +
    '&"#"&ROW(' + stagedAnchor_() + ')';
}

/** Your taxonomy, via `_category_map`. Unmapped source categories stay blank. */
function stagedCategoryExpression(field) {
  var map = TABS.CATEGORY_MAP;
  var preset = importPreset_();
  var sources = 'FILTER(' + map + '!$B$2:$B,' + map + '!$A$2:$A=' + preset + ')';
  var values = 'FILTER(' + map + '!$' + colOf(CATEGORY_MAP_COLUMNS, field) + '$2:$' +
    colOf(CATEGORY_MAP_COLUMNS, field) + ',' + map + '!$A$2:$A=' + preset + ')';

  // XLOOKUP for the same reason as importAccountIdExpr_: INDEX takes the
  // first row of an array and drops the rest, which is one wrong answer
  // repeated rather than an error anybody would notice.
  return 'XLOOKUP(' + importRawColumn_('category_override') + ',' +
    sources + ',' + values + ',"")';
}

/**
 * Every formula the staged tab needs, in column order.
 *
 * `transfer_group` is deliberately absent: the export flags that a row is a
 * transfer without saying which other row it pairs with, so inventing a group
 * id here would be a guess dressed as data.
 */
function stagedFormulas() {
  var formulas = [
    ['uid', stagedUidExpression()],
    ['account_id', importAccountIdExpr_()],
    ['account_name', importRawColumn_('account_name')],
    ['booking_date', importDateExpr_(importRawColumn_('booking_date'))],
    ['amount', stagedAmountExpression()],
    ['currency', importRawColumn_('currency')],
    ['description', importRawColumn_('description')],
    ['counterparty', importRawColumn_('counterparty')],
    ['source', '"csv:"&' + importPreset_()],
    ['imported_at', 'TODAY()'],
    ['category_override', stagedCategoryExpression('category')],
    // Straight through, unmapped and unparsed: a label is whatever you called
    // it, and inventing a taxonomy for them here would be a decision nobody
    // asked for. `_labels` gets a dropdown in phase 7; the values are the
    // point now, because re-labelling a history by hand is not a thing anyone
    // does twice.
    ['labels', importRawColumn_('labels')]
  ].map(function (pair) {
    return { column: pair[0], formula: stagedColumnFormula(pair[1]) };
  });

  formulas.push({ column: 'include', formula: stagedIncludeFormula() });
  formulas.push({ column: 'why', formula: stagedWhyFormula() });
  return formulas;
}

// ---------------------------------------------------------------------------
// Committing the staged rows
// ---------------------------------------------------------------------------

/**
 * Menu → Import staged rows.
 *
 * The repo's rule is that one-time human operations get documented rather
 * than automated, and the CSV importer was removed under it. This is not that
 * importer: `File → Import` still loads the file, the mapping is still
 * formulas you can read, and you still review `_import_staged` before
 * anything moves. What this replaces is only the paste.
 *
 * That paste was worth replacing. It is two blocks that must land on the same
 * row, values-only both times, after filtering out the excluded rows, without
 * touching the one column holding an ARRAYFORMULA — four ways to quietly
 * corrupt a tab that is never rewritten once written. Same reasoning as
 * `installCredentials()`: a procedure that silently corrupts is a trap.
 *
 * It also gains something the paste could not have. Uids here are
 * `csv:<preset>:<batch>#<row>`, so a row already imported is recognisable,
 * and running this twice imports nothing the second time. A double paste has
 * no such defence.
 */
function importStagedRows() {
  var ui = SpreadsheetApp.getUi();
  var plan = planStagedImport_();

  if (plan.error) {
    ui.alert('Import staged rows', plan.error, ui.ButtonSet.OK);
    return plan;
  }

  var answer = ui.alert('Import staged rows', describeStagedPlan_(plan), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Nothing was imported.', 'Cancelled', 5);
    return plan;
  }

  var result = commitStagedImport_(plan);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    result.imported + ' rows added at row ' + result.row + '.', 'Imported', 15);
  return result;
}

/**
 * What an import would do, without doing any of it.
 *
 * Separated from the commit so the confirmation describes the same work that
 * will run, rather than a second guess at it.
 */
function planStagedImport_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var staged = ss.getSheetByName(TABS.IMPORT_STAGED);
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  if (!staged || !tx) return { error: 'Run Setup sheet first — a tab is missing.' };

  var records = readRecords_(staged, STAGED_COLUMNS, colIndex_(STAGED_COLUMNS, 'uid'));
  var included = records.filter(function (row) { return isTruthyCell_(row.include); });
  if (!included.length) {
    return {
      error: 'No rows to import.\n\nEither _import_raw is empty, or every row is ' +
        'excluded — column ' + colOf(STAGED_COLUMNS, 'why') + ' gives the reason for each.'
    };
  }

  var seen = {};
  readColumn_(tx, colIndex_(TX_COLUMNS, 'uid')).forEach(function (uid) {
    if (uid) seen[String(uid)] = true;
  });

  var fresh = included.filter(function (row) { return !seen[String(row.uid)]; });
  var already = included.length - fresh.length;

  if (!fresh.length) {
    return {
      error: 'All ' + included.length + ' rows are already in ' + TABS.TRANSACTIONS + '.\n\n' +
        'To import a second file, change import_batch in ' + TABS.CONFIG +
        ' — the uid is built from it, so reusing it makes every row look imported.'
    };
  }

  var missingAccount = fresh.filter(function (row) { return !row.account_id; }).length;

  return {
    rows: fresh,
    excluded: records.length - included.length,
    already: already,
    missingAccount: missingAccount,
    accounts: countStagedBy_(fresh, 'account_name'),
    range: stagedDateRange_(fresh)
  };
}

/** Group a column into { value: count }, for a summary that names names. */
function countStagedBy_(rows, field) {
  var counts = {};
  rows.forEach(function (row) {
    var key = row[field] === '' || row[field] === null || row[field] === undefined
      ? '(none)' : String(row[field]);
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function stagedDateRange_(rows) {
  var times = rows
    .map(function (row) { return row.booking_date instanceof Date ? row.booking_date.getTime() : null; })
    .filter(function (t) { return t !== null; });
  if (!times.length) return null;
  return { from: new Date(Math.min.apply(null, times)), to: new Date(Math.max.apply(null, times)) };
}

/**
 * The confirmation text.
 *
 * Says what will change and what will not, because the thing being asked
 * about appends to a tab that is never rewritten — there is no undo beyond
 * deleting the rows again.
 */
function describeStagedPlan_(plan) {
  var lines = ['Add ' + plan.rows.length + ' rows to ' + TABS.TRANSACTIONS + '.'];

  if (plan.range) {
    lines.push('Dates ' + dateKey(plan.range.from) + ' to ' + dateKey(plan.range.to) + '.');
  }

  lines.push('');
  Object.keys(plan.accounts).sort().forEach(function (name) {
    lines.push('  ' + name + ': ' + plan.accounts[name]);
  });
  lines.push('');

  if (plan.excluded) {
    lines.push(plan.excluded + ' rows excluded — see column ' +
      colOf(STAGED_COLUMNS, 'why') + '. They are not imported.');
  }
  if (plan.already) {
    lines.push(plan.already + ' rows are already in ' + TABS.TRANSACTIONS + ' and will be skipped.');
  }
  if (plan.missingAccount) {
    lines.push('⚠ ' + plan.missingAccount + ' rows have no account_id — their account name ' +
      'matches no row in ' + TABS.ACCOUNTS + '. Fix that first, or they import unattached.');
  }

  lines.push('');
  lines.push('Rows are appended and never rewritten, so undoing this means deleting them.');
  lines.push('');
  lines.push('Continue?');
  return lines.join('\n');
}

/**
 * One of the columns beyond the code-owned block, written on its own.
 *
 * They are not contiguous — `category_override` is T and `labels` is AA, with
 * the `amount_base` ARRAYFORMULA and five other formula columns in between — so
 * each is placed separately rather than as one wide block that would overwrite
 * everything it spanned.
 */
function writeStagedColumn_(sheet, startRow, name, records) {
  // Through `textSafe_` for the reason its comment gives, and this path needs
  // saying separately: these columns come from a pasted CSV, so the text is a
  // previous tool's idea of a description rather than one this project built.
  var values = records.map(function (record) {
    return [record[name] === null || record[name] === undefined ? '' : textSafe_(record[name])];
  });
  sheet.getRange(startRow, colIndex_(TX_COLUMNS, name), values.length, 1).setValues(values);
}

function commitStagedImport_(plan) {
  var tx = sheetOrThrow_(TABS.TRANSACTIONS);
  var width = TX_COLUMNS_CODE.length;

  // A–O still goes across in one write, but the staged tab no longer holds all
  // fifteen — see STAGED_COLUMNS. The ones it does not hold are bank fields no
  // export carries, so they land empty rather than absent: `setValues` on an
  // `undefined` is not a blank cell, it throws.
  var block = plan.rows.map(function (record) {
    return TX_COLUMNS_CODE.map(function (name) {
      return record[name] === null || record[name] === undefined ? '' : record[name];
    });
  });

  var placed = appendRows_(tx, colIndex_(TX_COLUMNS, 'uid'), block);

  writeStagedColumn_(tx, placed.row, 'category_override', plan.rows);
  writeStagedColumn_(tx, placed.row, 'labels', plan.rows);

  // Imported rows arrive confirmed. You categorised them once already, in the
  // tool they came from — re-reviewing four thousand of them would be a chore
  // invented by the migration rather than by the data. It is also what gives
  // the cascade something to learn from on day one: `learnFromCorrections`
  // reads confirmed rows only, and without this it would have none.
  var confirmed = plan.rows.map(function () { return { confirmed: true }; });
  writeStagedColumn_(tx, placed.row, 'confirmed', confirmed);

  return { imported: placed.count, row: placed.row, width: width, plan: plan };
}

