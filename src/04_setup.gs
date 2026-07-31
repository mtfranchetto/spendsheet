/**
 * 04_setup.gs — builds the spreadsheet.
 *
 * setup() is idempotent by construction: it creates only what is missing,
 * rewrites headers and formulas to their canonical values, and seeds a tab
 * only when that tab has no data rows. Run it twice and the second run
 * changes nothing. That property is what makes it safe to re-run after every
 * upgrade, which is the whole reason the repo *is* the template — there is
 * no binary spreadsheet artefact to keep in sync.
 *
 * The formula builders at the bottom are pure functions returning strings,
 * so they are unit-tested without a spreadsheet.
 */

/** Entry point. Menu → Setup sheet. */
function setup() {
  // Under a lock for the same reason syncAll is: two runs creating and
  // deleting the same tabs at once is a race, and it is an easy one to start
  // — setup() takes long enough that clicking the menu item twice feels
  // reasonable.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) {
    throw new Error('Setup is already running. Wait for it to finish, then try again.');
  }
  try {
    return runSetup_();
  } finally {
    lock.releaseLock();
  }
}

function runSetup_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var report = { created: [], existing: [], seeded: [] };

  buildTable_(ss, TABS.TRANSACTIONS, TX_COLUMNS, report);
  buildTable_(ss, TABS.PENDING, PENDING_COLUMNS, report);
  buildTable_(ss, TABS.ACCOUNTS, ACCOUNT_COLUMNS, report);
  buildTable_(ss, TABS.RULES, RULE_COLUMNS, report, DEFAULT_RULES);
  buildTable_(ss, TABS.CATEGORIES, CATEGORY_COLUMNS, report, DEFAULT_CATEGORIES);
  buildTable_(ss, TABS.RECURRING, RECURRING_COLUMNS, report);
  buildTable_(ss, TABS.CASHFLOW, CASHFLOW_COLUMNS, report);
  buildTable_(ss, TABS.CASH_ENTRY, CASH_ENTRY_COLUMNS, report);
  buildTable_(ss, TABS.ANOMALIES, ANOMALY_COLUMNS, report);
  buildTable_(ss, TABS.STATUS, STATUS_COLUMNS, report);
  buildTable_(ss, TABS.RUNS, RUN_COLUMNS, report);
  buildTable_(ss, TABS.CONFIG, CONFIG_COLUMNS, report, DEFAULT_CONFIG);
  buildTable_(ss, TABS.IMPORT_MAP, IMPORT_MAP_COLUMNS, report, DEFAULT_IMPORT_MAP);
  buildTable_(ss, TABS.CATEGORY_MAP, CATEGORY_MAP_COLUMNS, report, DEFAULT_CATEGORY_MAP);
  buildTable_(ss, TABS.MEMORY, MEMORY_COLUMNS, report);
  buildTable_(ss, TABS.TESTS, TEST_COLUMNS, report);

  // Working tabs with no fixed schema.
  getOrCreate_(ss, TABS.IMPORT_RAW, report);      // CSV lands here via File → Import
  getOrCreate_(ss, TABS.DASHBOARD, report);

  var sep = detectArgSeparator_(ss);
  buildImportStaged_(ss, sep, report);
  applyFormulas_(ss, sep);
  applyFormats_(ss);
  applyValidation_(ss);
  applyProtection_(ss);
  hidePrivateTabs_(ss, report);
  removeDefaultSheet_(ss);
  orderTabs_(ss);

  var msg = report.created.length
    ? 'Created: ' + report.created.join(', ')
    : 'Everything already in place — nothing changed.';
  if (report.seeded.length) msg += '\nSeeded: ' + report.seeded.join(', ');

  SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Setup complete', 10);
  return report;
}

// ---------------------------------------------------------------------------
// Tab construction
// ---------------------------------------------------------------------------

function getOrCreate_(ss, name, report) {
  var sh = ss.getSheetByName(name);
  if (sh) {
    if (report) report.existing.push(name);
    return sh;
  }
  sh = ss.insertSheet(name);
  if (report) report.created.push(name);
  return sh;
}

/**
 * Create the tab if missing, write its header row, and seed it only when it
 * has no data rows. Seeding on an empty-but-existing tab is deliberate: it
 * lets you delete every rule and re-run setup() to get the defaults back.
 */
function buildTable_(ss, name, headers, report, seed) {
  var sh = getOrCreate_(ss, name, report);
  var isNew = report && report.created.indexOf(name) !== -1;

  sh.getRange(1, 1, 1, headers.length).setValues([headers]);

  // Trim the blank columns a new sheet is born with — but ONLY on a new
  // sheet. Doing this every run would delete any column you appended to the
  // right of the schema, which is a legitimate thing to do and silent data
  // loss if we punish it.
  if (isNew && sh.getMaxColumns() > headers.length) {
    sh.deleteColumns(headers.length + 1, sh.getMaxColumns() - headers.length);
  }
  sh.setFrozenRows(1);

  if (seed && seed.length && sh.getLastRow() < 2) {
    sh.getRange(2, 1, seed.length, seed[0].length).setValues(seed);
    if (report) report.seeded.push(name);
  }
  return sh;
}

/**
 * `_import_staged` — the tab that reads whatever landed in `_import_raw`.
 *
 * Rebuilt every run rather than seeded, because it is entirely formulas: there
 * is nothing of yours in it to preserve, and the mapping it reads lives in
 * `_import_map`, which is yours and is not touched here.
 */
function buildImportStaged_(ss, sep, report) {
  var sheet = getOrCreate_(ss, TABS.IMPORT_STAGED, report);
  sheet.getRange(1, 1, 1, STAGED_COLUMNS.length).setValues([STAGED_COLUMNS]);
  sheet.setFrozenRows(1);

  stagedFormulas().forEach(function (entry) {
    setFormula_(sheet, colOf(STAGED_COLUMNS, entry.column), entry.formula, sep);
  });

  // Past the schema, so it can say where to paste without being in the way of
  // what you are pasting.
  sheet.getRange(1, STAGED_COLUMNS.length + 2)
    .setFormula(localizeFormula(stagedInstructionsFormula(), sep));
}

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

function applyFormulas_(ss, sep) {
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  setFormula_(tx, colOf(TX_COLUMNS, 'amount_eur'), amountEurFormula(), sep);
  setFormula_(tx, colOf(TX_COLUMNS, 'category'), categoryFormula(), sep);
  setFormula_(tx, colOf(TX_COLUMNS, 'subcategory'), subcategoryFormula(), sep);
  setFormula_(tx, colOf(TX_COLUMNS, 'type'), typeFormula(), sep);

  // category_auto / subcategory_auto / category_source are written by the
  // categorisation cascade in 09_categorize.gs (phase 7), not by a formula:
  // tier 3 needs normalizeMerchant() and tier 5 needs priority-ordered
  // substring matching, neither of which is expressible in ARRAYFORMULA.

  var acc = ss.getSheetByName(TABS.ACCOUNTS);
  setFormula_(acc, colOf(ACCOUNT_COLUMNS, 'balance'), accountBalanceFormula(), sep);

  var status = ss.getSheetByName(TABS.STATUS);
  setFormula_(status, colOf(STATUS_COLUMNS, 'days_left'), consentDaysLeftFormula(), sep);
  setFormula_(status, colOf(STATUS_COLUMNS, 'state'), consentStateFormula(), sep);
}

/** Write a single array formula into row 2 of a column. Idempotent. */
function setFormula_(sheet, letter, formula, sep) {
  sheet.getRange(letter + '2').setFormula(localizeFormula(formula, sep));
}

/**
 * Rewrite argument separators for the spreadsheet's locale.
 *
 * Locales that use a decimal comma — Italian, German, French, Spanish and
 * others — separate formula arguments with `;`, and setFormula() does NOT
 * convert: a comma-separated formula lands as a #ERROR! parse failure.
 *
 * So every formula in this project is authored in canonical comma form and
 * translated exactly once, here, on the way into the sheet. Threading a
 * separator through each builder's string concatenation would work too, but
 * it would need remembering for every formula ever added — this cannot be
 * forgotten.
 *
 * Quote-aware, because a comma inside a string literal is data, not syntax.
 */
function localizeFormula(formula, sep) {
  if (!sep || sep === ',') return formula;

  var out = '';
  var inString = false;
  for (var i = 0; i < formula.length; i++) {
    var ch = formula.charAt(i);
    if (ch === '"') inString = !inString;
    out += (ch === ',' && !inString) ? sep : ch;
  }
  return out;
}

/**
 * Which argument separator this spreadsheet wants, determined by asking it
 * rather than by keeping a list of locales.
 *
 * `=SUM(1,1)` is 2 where the comma separates arguments, and 1.1 where the
 * comma is a decimal point and the whole thing is a single number. One probe,
 * unambiguous, and correct for locales nobody thought to enumerate.
 *
 * Falls back to comma if the probe returns something unexpected: that is the
 * canonical form, so the worst case is the behaviour we had before.
 */
function detectArgSeparator_(ss) {
  // Named per execution rather than fixed. Two overlapping setup() runs
  // sharing one probe is a race that ends with the second deleting a sheet
  // the first already removed — "A sheet with ID … doesn't exist", thrown
  // from the cleanup rather than from anything that matters.
  var name = '__spendsheet_locale_probe_' + Utilities.getUuid().slice(0, 8);
  var previous = ss.getActiveSheet();
  var sheet = ss.insertSheet(name);

  try {
    var cell = sheet.getRange('A1');
    cell.setFormula('=SUM(1,1)');
    SpreadsheetApp.flush();
    var value = cell.getValue();
    if (value === 2) return ',';
    if (value === 1.1) return ';';
    return ',';
  } finally {
    discardProbe_(ss, name, previous);
  }
}

/**
 * Clean up the probe, and never let the cleanup be the thing that fails.
 *
 * Re-fetched by name rather than deleted through the reference we are holding,
 * because that reference is exactly what goes stale. And wrapped, because a
 * scratch tab that outlives its run is untidy — while a setup() that aborts
 * over one leaves the spreadsheet half-built.
 */
function discardProbe_(ss, name, previous) {
  try {
    var sheet = ss.getSheetByName(name);
    if (sheet) ss.deleteSheet(sheet);

    // insertSheet() activates what it creates, so the book is left pointing at
    // a sheet that no longer exists unless we put it back.
    if (previous && ss.getSheetByName(previous.getName())) ss.setActiveSheet(previous);
  } catch (e) {
    Logger.log('discardProbe_: ' + e.message);
  }
}

/**
 * amount_eur — the column every report reads, never `amount`.
 *
 * In v1 this is just `amount` when the currency already matches, and blank
 * otherwise. Blank rather than unconverted: a non-EUR figure summed as if it
 * were EUR is silently wrong, and wrong-and-quiet is the one outcome worth
 * engineering against. Non-EUR rows are logged to _anomalies and counted on
 * the dashboard instead.
 *
 * Turning on real FX later is purely additive — add an `fx` tab and change
 * this one formula. Nothing downstream moves, which is the entire point of
 * shipping the column now.
 */
function amountEurFormula() {
  var a = colOf(TX_COLUMNS, 'uid');
  var amt = colOf(TX_COLUMNS, 'amount');
  var cur = colOf(TX_COLUMNS, 'currency');
  return '=ARRAYFORMULA(IF(LEN($' + a + '$2:$' + a + ')=0,"",' +
    'IF($' + cur + '$2:$' + cur + '=' + configLookup_('base_currency', '"EUR"') + ',' +
    '$' + amt + '$2:$' + amt + ',"")))';
}

/** category — your override always wins, otherwise whatever the cascade decided. */
function categoryFormula() {
  var a = colOf(TX_COLUMNS, 'uid');
  var auto = colOf(TX_COLUMNS, 'category_auto');
  var ovr = colOf(TX_COLUMNS, 'category_override');
  return '=ARRAYFORMULA(IF(LEN($' + a + '$2:$' + a + ')=0,"",' +
    'IF(LEN($' + ovr + '$2:$' + ovr + ')>0,$' + ovr + '$2:$' + ovr + ',' +
    '$' + auto + '$2:$' + auto + ')))';
}

/**
 * subcategory — cleared when you override the category.
 *
 * A subcategory left over from a different parent category is worse than no
 * subcategory: it reads as real and rolls up wrongly. There is deliberately
 * no subcategory_override column; if you need that precision, put it in notes.
 */
function subcategoryFormula() {
  var a = colOf(TX_COLUMNS, 'uid');
  var auto = colOf(TX_COLUMNS, 'subcategory_auto');
  var ovr = colOf(TX_COLUMNS, 'category_override');
  return '=ARRAYFORMULA(IF(LEN($' + a + '$2:$' + a + ')=0,"",' +
    'IF(LEN($' + ovr + '$2:$' + ovr + ')>0,"",$' + auto + '$2:$' + auto + ')))';
}

/**
 * type — derived from the category's `kind`, never stored independently.
 *
 * This is what keeps transfers out of spending reports: a row categorised
 * Transfer inherits kind=transfer, and every report filters on it. Deriving
 * rather than storing means recategorising a row fixes its type for free.
 */
function typeFormula() {
  var a = colOf(TX_COLUMNS, 'uid');
  var cat = colOf(TX_COLUMNS, 'category');
  return '=ARRAYFORMULA(IF(LEN($' + a + '$2:$' + a + ')=0,"",' +
    'IFERROR(VLOOKUP($' + cat + '$2:$' + cat + ',' + TABS.CATEGORIES + '!$A:$C,3,FALSE),"")))';
}

/**
 * accounts.balance — one formula covering all three account kinds, written
 * once and covering every row you will ever add.
 *
 *   bank  → whatever the API last reported
 *   cash  → derived from its own transactions, so a wallet maintains itself
 *   asset → the value you typed
 *
 * This split is why adding a manual account is typing a row rather than
 * running a script: no column is ever written by both code and a formula.
 */
function accountBalanceFormula() {
  var id = colOf(ACCOUNT_COLUMNS, 'account_id');
  var kind = colOf(ACCOUNT_COLUMNS, 'kind');
  var open = colOf(ACCOUNT_COLUMNS, 'opening_balance');
  var api = colOf(ACCOUNT_COLUMNS, 'balance_api');
  var man = colOf(ACCOUNT_COLUMNS, 'balance_manual');

  var txAccount = TABS.TRANSACTIONS + '!$' + colOf(TX_COLUMNS, 'account_id') + '$2:$' + colOf(TX_COLUMNS, 'account_id');
  var txAmount = TABS.TRANSACTIONS + '!$' + colOf(TX_COLUMNS, 'amount_eur') + '$2:$' + colOf(TX_COLUMNS, 'amount_eur');
  var idRange = '$' + id + '$2:$' + id;

  return '=ARRAYFORMULA(IF(LEN(' + idRange + ')=0,"",' +
    'IF($' + kind + '$2:$' + kind + '="' + ACCOUNT_KIND.BANK + '",$' + api + '$2:$' + api + ',' +
    'IF($' + kind + '$2:$' + kind + '="' + ACCOUNT_KIND.ASSET + '",$' + man + '$2:$' + man + ',' +
    'IF($' + kind + '$2:$' + kind + '="' + ACCOUNT_KIND.CASH + '",' +
    // IF(blank,0,x) rather than N(x): N does not vectorise reliably inside
    // ARRAYFORMULA, and an empty opening_balance would otherwise poison the
    // addition with #VALUE!.
    'IF($' + open + '$2:$' + open + '="",0,$' + open + '$2:$' + open + ')' +
    '+SUMIF(' + txAccount + ',' + idRange + ',' + txAmount + '),' +
    '"")))))';
}

/**
 * Days until a consent dies. A formula rather than a stored number, so it
 * is truthful on a morning when the sync hasn't run — which is exactly the
 * morning you'd want to know.
 *
 * Manual accounts have no consent and no `valid_until`, so they stay blank
 * rather than reading as expired.
 */
function consentDaysLeftFormula() {
  var id = colOf(STATUS_COLUMNS, 'connection_id');
  var until = colOf(STATUS_COLUMNS, 'valid_until');
  return '=ARRAYFORMULA(IF(LEN($' + id + '$2:$' + id + ')=0,"",' +
    'IF(LEN($' + until + '$2:$' + until + ')=0,"",' +
    'INT($' + until + '$2:$' + until + ')-TODAY())))';
}

/**
 * Connection state, derived from the two facts that determine it rather
 * than written by code and left to drift. An error outranks the clock: a
 * connection that is failing is not "ACTIVE" merely because its consent
 * has not expired yet.
 */
function consentStateFormula() {
  var id = colOf(STATUS_COLUMNS, 'connection_id');
  var days = colOf(STATUS_COLUMNS, 'days_left');
  var error = colOf(STATUS_COLUMNS, 'last_error');
  var warn = configLookup_('consent_warning_days', '7');

  return '=ARRAYFORMULA(IF(LEN($' + id + '$2:$' + id + ')=0,"",' +
    'IF(LEN($' + error + '$2:$' + error + ')>0,"ERROR",' +
    'IF(LEN($' + days + '$2:$' + days + ')=0,"MANUAL",' +
    'IF($' + days + '$2:$' + days + '<0,"EXPIRED",' +
    'IF($' + days + '$2:$' + days + '<=' + warn + ',"EXPIRING","ACTIVE"))))))';
}

/** A _config value by key, with a fallback when the row is missing. */
function configLookup_(key, fallbackLiteral) {
  return 'IFERROR(VLOOKUP("' + key + '",' + TABS.CONFIG + '!$A:$B,2,FALSE),' + fallbackLiteral + ')';
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function applyFormats_(ss) {
  var dateCols = ['booking_date', 'value_date', 'transaction_date'];
  var moneyCols = ['amount', 'amount_eur'];

  [TABS.TRANSACTIONS, TABS.PENDING].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    var headers = name === TABS.PENDING ? PENDING_COLUMNS : TX_COLUMNS;
    dateCols.forEach(function (c) {
      if (headers.indexOf(c) !== -1) formatColumn_(sh, colOf(headers, c), 'yyyy-mm-dd');
    });
    moneyCols.forEach(function (c) {
      if (headers.indexOf(c) !== -1) formatColumn_(sh, colOf(headers, c), '#,##0.00');
    });
    formatColumn_(sh, colOf(headers, 'imported_at'), 'yyyy-mm-dd hh:mm');
  });

  var acc = ss.getSheetByName(TABS.ACCOUNTS);
  ['opening_balance', 'balance_api', 'balance_manual', 'balance'].forEach(function (c) {
    formatColumn_(acc, colOf(ACCOUNT_COLUMNS, c), '#,##0.00');
  });

  var cash = ss.getSheetByName(TABS.CASH_ENTRY);
  formatColumn_(cash, colOf(CASH_ENTRY_COLUMNS, 'date'), 'yyyy-mm-dd');
  formatColumn_(cash, colOf(CASH_ENTRY_COLUMNS, 'amount'), '#,##0.00');

  ss.getSheets().forEach(function (sh) {
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) return;
    var header = sh.getRange(1, 1, 1, lastCol);
    header.setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
  });
}

function formatColumn_(sheet, letter, pattern) {
  sheet.getRange(letter + '2:' + letter).setNumberFormat(pattern);
}

/**
 * Dropdowns. Mobile Sheets honours data validation, which is what makes the
 * cash_entry tab usable as a phone input surface — and it works offline,
 * unlike a Google Form, which cannot submit without a connection at all.
 */
function applyValidation_(ss) {
  var cats = ss.getSheetByName(TABS.CATEGORIES);
  var accounts = ss.getSheetByName(TABS.ACCOUNTS);
  var cash = ss.getSheetByName(TABS.CASH_ENTRY);

  var categoryRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(cats.getRange('A2:A'), true)
    .setAllowInvalid(true)
    .build();
  var accountRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accounts.getRange('A2:A'), true)
    .setAllowInvalid(true)
    .build();

  cash.getRange(colOf(CASH_ENTRY_COLUMNS, 'account') + '2:' + colOf(CASH_ENTRY_COLUMNS, 'account'))
    .setDataValidation(accountRule);
  cash.getRange(colOf(CASH_ENTRY_COLUMNS, 'category') + '2:' + colOf(CASH_ENTRY_COLUMNS, 'category'))
    .setDataValidation(categoryRule);

  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  tx.getRange(colOf(TX_COLUMNS, 'category_override') + '2:' + colOf(TX_COLUMNS, 'category_override'))
    .setDataValidation(categoryRule);

  // The sign rule, written where a phone will show it: tapping a header cell
  // in mobile Sheets reveals its note. Documentation nobody has to find.
  cash.getRange(colOf(CASH_ENTRY_COLUMNS, 'amount') + '1').setNote(
    'Type the amount without a sign.\n\n' +
    'A bare number is spending. Pick an Income or Transfer category and it ' +
    'counts the other way — so an ATM withdrawal adds to this account, and ' +
    'the matching debit on the bank side nets it to zero.\n\n' +
    'Type a minus sign to force money out.');

  var kindRule = SpreadsheetApp.newDataValidation()
    .requireValueInList([ACCOUNT_KIND.BANK, ACCOUNT_KIND.CASH, ACCOUNT_KIND.ASSET], true)
    .setAllowInvalid(false)
    .build();
  accounts.getRange(colOf(ACCOUNT_COLUMNS, 'kind') + '2:' + colOf(ACCOUNT_COLUMNS, 'kind'))
    .setDataValidation(kindRule);
}

/**
 * Warning-only protection on the machine-owned columns.
 *
 * Deliberately not a hard lock. On a single-user sheet a lock is pure
 * friction and you legitimately need to fix things sometimes; a confirmation
 * prompt catches the accident without blocking the intent.
 *
 * Tagged by description so re-running setup() does not stack duplicates.
 */
function applyProtection_(ss) {
  protectRange_(ss.getSheetByName(TABS.TRANSACTIONS),
    'A2:' + colOf(TX_COLUMNS, 'imported_at'), 'spendsheet: written by sync');
  protectRange_(ss.getSheetByName(TABS.TRANSACTIONS),
    colOf(TX_COLUMNS, 'amount_eur') + '2:' + colOf(TX_COLUMNS, 'amount_eur'),
    'spendsheet: formula (amount_eur)');
  protectRange_(ss.getSheetByName(TABS.TRANSACTIONS),
    colOf(TX_COLUMNS, 'category') + '2:' + colOf(TX_COLUMNS, 'type'),
    'spendsheet: formula (category)');
  protectRange_(ss.getSheetByName(TABS.ACCOUNTS),
    colOf(ACCOUNT_COLUMNS, 'balance') + '2:' + colOf(ACCOUNT_COLUMNS, 'balance'),
    'spendsheet: formula (balance)');
  protectRange_(ss.getSheetByName(TABS.PENDING), 'A2:' + colOf(PENDING_COLUMNS, 'imported_at'),
    'spendsheet: rewritten every sync');

  // state and days_left are derived; valid_until sits between them and is
  // written by code, so these are two ranges rather than one.
  protectRange_(ss.getSheetByName(TABS.STATUS),
    colOf(STATUS_COLUMNS, 'state') + '2:' + colOf(STATUS_COLUMNS, 'state'),
    'spendsheet: formula (consent state)');
  protectRange_(ss.getSheetByName(TABS.STATUS),
    colOf(STATUS_COLUMNS, 'days_left') + '2:' + colOf(STATUS_COLUMNS, 'days_left'),
    'spendsheet: formula (days left)');
}

/**
 * Keyed on the range rather than the description: two ranges sharing a
 * description would otherwise silently leave the second one unprotected.
 */
function protectRange_(sheet, a1, description) {
  var target = sheet.getRange(a1).getA1Notation();
  var existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE);
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getRange().getA1Notation() === target) return;
  }
  sheet.getRange(a1).protect().setDescription(description).setWarningOnly(true);
}

/**
 * `_`-prefixed tabs are machinery, so they start hidden — but only on the
 * run that creates them. If you unhide `_config` to look at it, re-running
 * setup() leaves it alone. Visibility is your call once the tab exists.
 */
function hidePrivateTabs_(ss, report) {
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (name.charAt(0) !== '_') return;
    if (report && report.created.indexOf(name) === -1) return;
    sh.hideSheet();
  });
}

/**
 * Drop the empty starter tab a blank spreadsheet comes with, so you end up
 * with exactly our 19 and no stray "Sheet1". Only ever removes a sheet that
 * is both untouched and not one of ours — an empty tab you created on purpose
 * and named something else is left alone.
 */
function removeDefaultSheet_(ss) {
  var ours = Object.keys(TABS).map(function (k) { return TABS[k]; });
  var defaults = ['Sheet1', 'Foglio1', 'Hoja 1', 'Feuille 1', 'Tabellenblatt1'];

  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (ours.indexOf(name) !== -1) return;
    if (defaults.indexOf(name) === -1) return;
    if (sh.getLastRow() !== 0 || sh.getLastColumn() !== 0) return;
    if (ss.getSheets().length <= 1) return;
    ss.deleteSheet(sh);
  });
}

/** Put the tabs you actually use in front. */
function orderTabs_(ss) {
  var order = [
    TABS.DASHBOARD, TABS.TRANSACTIONS, TABS.PENDING, TABS.ACCOUNTS,
    TABS.CASH_ENTRY, TABS.RULES, TABS.CATEGORIES, TABS.RECURRING, TABS.CASHFLOW
  ];
  order.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
}
