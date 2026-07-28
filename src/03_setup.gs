/**
 * 03_setup.gs — builds the spreadsheet.
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
  buildTable_(ss, TABS.CATEGORY_MAP, CATEGORY_MAP_COLUMNS, report);
  buildTable_(ss, TABS.MEMORY, MEMORY_COLUMNS, report);
  buildTable_(ss, TABS.TESTS, TEST_COLUMNS, report);

  // Working tabs with no fixed schema.
  getOrCreate_(ss, TABS.IMPORT_RAW, report);      // CSV lands here via File → Import
  getOrCreate_(ss, TABS.IMPORT_STAGED, report);   // formula-mapped, you paste from it
  getOrCreate_(ss, TABS.DASHBOARD, report);

  applyFormulas_(ss);
  applyFormats_(ss);
  applyValidation_(ss);
  applyProtection_(ss);
  hidePrivateTabs_(ss);
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

  sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (sh.getMaxColumns() > headers.length) {
    sh.deleteColumns(headers.length + 1, sh.getMaxColumns() - headers.length);
  }
  sh.setFrozenRows(1);

  if (seed && seed.length && sh.getLastRow() < 2) {
    sh.getRange(2, 1, seed.length, seed[0].length).setValues(seed);
    if (report) report.seeded.push(name);
  }
  return sh;
}

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

function applyFormulas_(ss) {
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  setFormula_(tx, colOf(TX_COLUMNS, 'amount_eur'), amountEurFormula());
  setFormula_(tx, colOf(TX_COLUMNS, 'category'), categoryFormula());
  setFormula_(tx, colOf(TX_COLUMNS, 'subcategory'), subcategoryFormula());
  setFormula_(tx, colOf(TX_COLUMNS, 'type'), typeFormula());

  // category_auto / subcategory_auto / category_source are written by the
  // categorisation cascade in 07_categorize.gs (phase 7), not by a formula:
  // tier 3 needs normalizeMerchant() and tier 5 needs priority-ordered
  // substring matching, neither of which is expressible in ARRAYFORMULA.

  var acc = ss.getSheetByName(TABS.ACCOUNTS);
  setFormula_(acc, colOf(ACCOUNT_COLUMNS, 'balance'), accountBalanceFormula());
}

/** Write a single array formula into row 2 of a column. Idempotent. */
function setFormula_(sheet, letter, formula) {
  sheet.getRange(letter + '2').setFormula(formula);
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
    'N($' + open + '$2:$' + open + ')+SUMIF(' + txAccount + ',' + idRange + ',' + txAmount + '),' +
    '"")))))';
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

/** `_`-prefixed tabs are machinery. Hidden, not deleted — you may need to read them. */
function hidePrivateTabs_(ss) {
  ss.getSheets().forEach(function (sh) {
    if (sh.getName().charAt(0) === '_') sh.hideSheet();
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
