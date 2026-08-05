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
  var report = {
    created: [], existing: [], seeded: [], added: [], diverged: [],
    newColumns: [], movedColumns: []
  };

  buildTable_(ss, TABS.TRANSACTIONS, TX_COLUMNS, report);
  buildTable_(ss, TABS.PENDING, PENDING_COLUMNS, report);
  buildTable_(ss, TABS.ACCOUNTS, ACCOUNT_COLUMNS, report);
  buildTable_(ss, TABS.RULES, RULE_COLUMNS, report, DEFAULT_RULES);
  buildTable_(ss, TABS.CATEGORIES, CATEGORY_COLUMNS, report, DEFAULT_CATEGORIES);
  buildTable_(ss, TABS.LABELS, LABEL_COLUMNS, report, DEFAULT_LABELS);
  buildTable_(ss, TABS.CASH_ENTRY, CASH_ENTRY_COLUMNS, report);
  buildTable_(ss, TABS.ANOMALIES, ANOMALY_COLUMNS, report);
  buildTable_(ss, TABS.STATUS, STATUS_COLUMNS, report);
  buildTable_(ss, TABS.RUNS, RUN_COLUMNS, report);
  buildTable_(ss, TABS.CONFIG, CONFIG_COLUMNS, report, DEFAULT_CONFIG);
  buildTable_(ss, TABS.IMPORT_MAP, IMPORT_MAP_COLUMNS, report, DEFAULT_IMPORT_MAP);
  buildTable_(ss, TABS.CATEGORY_MAP, CATEGORY_MAP_COLUMNS, report, DEFAULT_CATEGORY_MAP);
  buildTable_(ss, TABS.MEMORY, MEMORY_COLUMNS, report);
  buildTable_(ss, TABS.REMOVED, TX_COLUMNS, report);
  buildTable_(ss, TABS.REVIEW, REVIEW_COLUMNS, report);
  buildTable_(ss, TABS.TESTS, TEST_COLUMNS, report);

  // After every tab exists, so a book built by an older version catches up.
  UPGRADABLE_SEEDS.forEach(function (entry) { addMissingSeedRows_(ss, entry, report); });

  // Working tabs with no fixed schema.
  getOrCreate_(ss, TABS.IMPORT_RAW, report);      // CSV lands here via File → Import
  getOrCreate_(ss, TABS.DASHBOARD, report);
  getOrCreate_(ss, TABS.REPORTS, report);
  getOrCreate_(ss, TABS.RECENT, report);

  var sep = detectArgSeparator_(ss);
  buildImportStaged_(ss, sep, report);
  applyFormulas_(ss, sep);

  // Later phases extending an earlier one, through the same guarded forward
  // reference the sync uses for assertNoRowLoss_. File numbering is load order;
  // by the time anything runs, everything is defined.
  if (functionExists_('buildDashboard_')) buildDashboard_(ss, sep);
  if (functionExists_('buildRecent_')) buildRecent_(ss, sep);
  if (functionExists_('buildCashEntryForm_')) buildCashEntryForm_(ss);
  if (functionExists_('buildAnalytics_')) buildAnalytics_(ss, sep, report);
  if (functionExists_('buildReviewTab_')) buildReviewTab_(ss, report);

  applyFormats_(ss);
  applyColumnVisibility_(ss, report);
  applyValidation_(ss);
  applyProtection_(ss);
  hidePrivateTabs_(ss, report);
  removeDefaultSheet_(ss);
  orderTabs_(ss);

  var msg = report.created.length
    ? 'Created: ' + report.created.join(', ')
    : 'Everything already in place — nothing changed.';
  if (report.seeded.length) msg += '\nSeeded: ' + report.seeded.join(', ');
  if (report.added.length) msg += '\n' + describeAdditions_(report.added);
  if ((report.diverged || []).length) msg += '\n' + describeDivergence_(report.diverged);

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
 * Which seeded tabs gain rows on upgrade, and how many columns identify a row.
 *
 * `transactions` and friends are absent because they have no seed. `rules` is
 * absent for a different reason: its rows are a starting point you are expected
 * to argue with, and re-adding a rule you deliberately deleted every time you
 * upgrade would be infuriating in a way a missing category never is.
 */
var UPGRADABLE_SEEDS = [
  { tab: TABS.CONFIG, seed: function () { return DEFAULT_CONFIG; }, keyWidth: 1 },
  { tab: TABS.CATEGORIES, seed: function () { return DEFAULT_CATEGORIES; }, keyWidth: 2 },
  { tab: TABS.IMPORT_MAP, seed: function () { return DEFAULT_IMPORT_MAP; }, keyWidth: 2 },
  { tab: TABS.CATEGORY_MAP, seed: function () { return DEFAULT_CATEGORY_MAP; }, keyWidth: 2 }
];

/**
 * Add seed rows a sheet does not have yet, without touching the ones it does.
 *
 * Seeding is all-or-nothing — a tab with rows in it is left alone, which is
 * what keeps your edits. The cost is that a book set up in March never learns
 * anything added in April: the sheet keeps working, the new default simply is
 * not in it, and nothing says so. A `_config` key you have never seen leaves a
 * feature reading its default with no way to change it; twenty-five missing
 * `_category_map` rows import a year of history with blank categories.
 *
 * A row is identified by its first `keyWidth` columns, so a row whose *value*
 * you changed still matches and is left exactly as you left it.
 *
 * What this cannot tell apart is a row you never had from a row you deleted on
 * purpose — the second comes back. That is the trade, and it is why every
 * addition is named in the setup toast rather than applied quietly.
 */
function addMissingSeedRows_(ss, entry, report) {
  var sheet = ss.getSheetByName(entry.tab);
  if (!sheet) return;

  var seed = entry.seed();
  var key = function (row) {
    return row.slice(0, entry.keyWidth).map(function (cell) {
      return String(cell === null || cell === undefined ? '' : cell);
    }).join('\u0000');
  };

  var columns = [];
  for (var c = 1; c <= entry.keyWidth; c++) columns.push(readColumn_(sheet, c));

  var present = {};
  columns[0].forEach(function (_, i) {
    present[key(columns.map(function (column) { return column[i]; }))] = true;
  });

  var missing = seed.filter(function (row) { return !present[key(row)]; });
  reportSeedDivergence_(sheet, entry, seed, report);

  if (!missing.length) return;

  appendRows_(sheet, 1, missing);
  if (report) {
    report.added = (report.added || []).concat(missing.map(function (row) {
      return entry.tab + ': ' + row.slice(0, entry.keyWidth).join(' / ');
    }));
  }
}

/**
 * Rows the sheet already has, but with a different answer than the defaults.
 *
 * Reported, never corrected. Those are the same rows you are invited to edit
 * — `_category_map` says so in as many words — so overwriting them would
 * discard exactly the customisations `tests/customization.test.mjs` exists to
 * protect. There is no way to tell "I changed this" from "an old version
 * wrote this", and guessing wrong destroys work.
 *
 * But saying nothing was worse. `Child Support` was mapped to
 * `Other / Uncategorised` by an early version and later corrected to
 * `Income / Child support`; a sheet seeded before that kept the old row
 * forever, because this function only ever *added* what was absent. The
 * result filed €467 of money received as money spent, and the only symptom
 * was a monthly total that quietly disagreed with BudgetBakers on both sides
 * at once.
 */
function reportSeedDivergence_(sheet, entry, seed, report) {
  if (!report) return;

  var width = seed.length ? seed[0].length : 0;
  if (width <= entry.keyWidth) return;

  var rows = readRecordsRaw_(sheet, width);
  var byKey = {};
  rows.forEach(function (row) {
    byKey[seedKey_(row, entry.keyWidth)] = row;
  });

  seed.forEach(function (want) {
    var have = byKey[seedKey_(want, entry.keyWidth)];
    if (!have) return;

    var differs = false;
    for (var c = entry.keyWidth; c < width; c++) {
      if (String(have[c] === undefined ? '' : have[c]) !== String(want[c])) differs = true;
    }
    if (!differs) return;

    report.diverged = (report.diverged || []).concat([{
      tab: entry.tab,
      key: want.slice(0, entry.keyWidth).join(' / '),
      yours: have.slice(entry.keyWidth, width).join(' / '),
      standard: want.slice(entry.keyWidth, width).join(' / ')
    }]);
  });
}

function seedKey_(row, keyWidth) {
  return row.slice(0, keyWidth).map(function (cell) {
    return String(cell === null || cell === undefined ? '' : cell);
  }).join('\u0000');
}

/** Rows as plain arrays, for comparing against seed data of the same shape. */
function readRecordsRaw_(sheet, width) {
  var last = lastRecordRow_(sheet, 1);
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, width).getValues();
}

/**
 * The additions, as a line that fits on a toast.
 *
 * A new `_config` key is named, because it is a setting you now have a
 * decision to make about. Everything else is counted — twenty-five new
 * category mappings are worth knowing the size of, not the contents of, and a
 * toast that scrolls is a toast nobody reads.
 */

/**
 * Divergence, said out loud and written down.
 *
 * Named rather than counted, and the full list goes to `_anomalies` because a
 * toast is gone in ten seconds and this is a decision you may want to make
 * next week. Each line reads "what your sheet says" against "what the
 * defaults say", in that order, because yours is the one that is in force.
 */
function describeDivergence_(diverged) {
  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '',
    diverged.length + ' seeded row(s) differ from the defaults — yours are in force, ' +
    'nothing was changed.', diverged);

  var shown = diverged.slice(0, 3).map(function (d) {
    return '  ' + d.key + ': you have "' + d.yours + '", default is "' + d.standard + '"';
  }).join('\n');

  return diverged.length + ' seeded row(s) differ from the defaults (unchanged):\n' + shown +
    (diverged.length > 3 ? '\n  …' + (diverged.length - 3) + ' more, all listed in _anomalies' : '');
}

function describeAdditions_(added) {
  var settings = [];
  var counts = {};
  var order = [];

  added.forEach(function (entry) {
    var split = entry.indexOf(': ');
    var tab = entry.slice(0, split);
    if (tab === TABS.CONFIG) return settings.push(entry.slice(split + 2));
    if (!counts[tab]) order.push(tab);
    counts[tab] = (counts[tab] || 0) + 1;
  });

  var parts = order.map(function (tab) { return counts[tab] + ' rows in ' + tab; });
  if (settings.length) parts.unshift('new settings ' + settings.join(', '));
  return 'Added ' + parts.join('; ') + '.';
}

/**
 * Create the tab if missing, write its header row, and seed it only when it
 * has no data rows. Seeding on an empty-but-existing tab is deliberate: it
 * lets you delete every rule and re-run setup() to get the defaults back.
 */
function buildTable_(ss, name, headers, report, seed) {
  var sh = getOrCreate_(ss, name, report);
  var isNew = report && report.created.indexOf(name) !== -1;

  recordNewColumns_(sh, name, headers, report, isNew);
  makeRoomForNewColumns_(sh, name, report);
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
 * Which columns this run is about to add to a tab that already existed.
 *
 * Recorded before the header row is overwritten, because afterwards there is
 * no way to tell a column an upgrade just introduced from one that has been
 * there since March.
 *
 * It exists so that a **new** column gets the same default a new book would
 * give it. `applyColumnVisibility_` deliberately hides nothing on a re-run —
 * unhiding a column is a decision, and re-hiding it would undo that decision
 * exactly when you are in the middle of chasing something. But a column that
 * did not exist five seconds ago carries no decision to respect, and
 * `in_reports` is the case that made this obvious: a hidden helper on a new
 * book, and a thousand rows of `FALSE` in the middle of your sheet on an
 * upgraded one.
 */
function recordNewColumns_(sheet, name, headers, report, isNew) {
  if (!report || isNew) return;

  var width = sheet.getLastColumn();
  var existing = width ? sheet.getRange(1, 1, 1, width).getValues()[0].map(String) : [];

  report.newColumns = (report.newColumns || []).concat(
    headers.map(function (header, i) {
      return existing.indexOf(header) === -1 ? { tab: name, name: header, index: i + 1 } : null;
    }).filter(function (entry) { return entry; }));
}

/**
 * Give a column the schema has just grown into an empty slot to land in.
 *
 * The schema only ever grows to the **right**, and the first free column to
 * the right is exactly where you would have put a column of your own — so
 * "append to the right is safe" and "a new schema column lands on the right"
 * are the same slot, and the second silently wins.
 *
 * Writing the header row over it loses two things at once: the name of your
 * column, and the new formula, because an ARRAYFORMULA anchored at row 2
 * cannot expand through a column that already has data and gives `#REF!`
 * instead. The two symptoms do not point at each other — you get one broken
 * formula on one tab and a header that quietly changed name — which is how
 * `in_reports` shipped looking green and landed as an empty dashboard.
 *
 * So: if the slot is occupied, insert a column and let your data shift right.
 * Inserting is safe here in a way it is never safe mid-schema — the position
 * is past everything code addresses by letter, and Sheets rewrites the
 * references in your own formulas as it moves them.
 *
 * Entries arrive in ascending order and each insert shifts what follows, which
 * is why a block of your columns migrates right intact rather than being
 * interleaved with the new ones.
 */
function makeRoomForNewColumns_(sheet, name, report) {
  if (!report || !report.newColumns) return;

  var height = sheet.getMaxRows() - 1;
  if (height < 1) return;

  report.newColumns.forEach(function (entry) {
    if (entry.tab !== name || entry.index > sheet.getMaxColumns()) return;

    var range = sheet.getRange(2, entry.index, height, 1);
    var values = range.getValues();
    var formulas = range.getFormulas();

    // A formula in row 2 settles it: the column is already ours, and every
    // value under it is that formula's spill.
    //
    // The rows below cannot be consulted at all, because a spilled cell and a
    // cell you typed are indistinguishable through this API — `getValues()`
    // returns the computed value for both, and `getFormulas()` returns `''`
    // for both, since only the anchor holds the formula. An earlier version
    // asserted the opposite ("an array of ours that expanded leaves computed
    // cells, never stored ones") and read a live spill as somebody's data.
    //
    // What made that reachable was a **rename**. `recordNewColumns_` calls a
    // column new when its name is absent from the header row, so renaming
    // `amount_eur` to `amount_base` presented an occupied, working, spilling
    // column as a new one — and this function dutifully inserted a column to
    // get out of the way of our own output. Every derived column shifted one
    // place right of its header, which is the single edit this tab cannot
    // survive, and it took two tabs' worth of formulas down with it.
    if (formulas[0][0]) return;

    // Formulas as well as values. A column of yours built from formulas shows
    // blank in `getValues()` on every row the formula returns "" for, so a
    // value-only test calls it empty and flattens it — the one kind of column
    // where the loss is total rather than recoverable by re-typing.
    var occupied = values.some(function (row, i) {
      return !isBlankCell_(row[0]) || formulas[i][0];
    });
    if (!occupied) return;

    sheet.insertColumnBefore(entry.index);
    report.movedColumns = (report.movedColumns || []).concat([
      { tab: name, index: entry.index, madeRoomFor: entry.name }
    ]);
  });
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
}

// ---------------------------------------------------------------------------
// Formulas
// ---------------------------------------------------------------------------

function applyFormulas_(ss, sep) {
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  setFormula_(tx, colOf(TX_COLUMNS, 'amount_base'), amountEurFormula(), sep);
  setFormula_(tx, colOf(TX_COLUMNS, 'category'), categoryFormula(), sep);
  setFormula_(tx, colOf(TX_COLUMNS, 'subcategory'), subcategoryFormula(), sep);
  setFormula_(tx, colOf(TX_COLUMNS, 'type'), typeFormula(), sep);
  setFormula_(tx, colOf(TX_COLUMNS, 'in_reports'), inReportsFormula(), sep);

  // category_auto / subcategory_auto / category_source are written by the
  // categorisation cascade in 14_categorize.gs, not by a formula: tier 3 needs
  // normalizeMerchant() and tier 5 needs priority-ordered substring matching,
  // neither of which is expressible in ARRAYFORMULA.

  var labels = ss.getSheetByName(TABS.LABELS);
  setFormula_(labels, colOf(LABEL_COLUMNS, 'transactions'), labelCountFormula(), sep);
  setFormula_(labels, colOf(LABEL_COLUMNS, 'total_eur'), labelTotalFormula(), sep);

  var acc = ss.getSheetByName(TABS.ACCOUNTS);
  setFormula_(acc, colOf(ACCOUNT_COLUMNS, 'balance'), accountBalanceFormula(), sep);

  var status = ss.getSheetByName(TABS.STATUS);
  setFormula_(status, colOf(STATUS_COLUMNS, 'days_left'), consentDaysLeftFormula(), sep);
  setFormula_(status, colOf(STATUS_COLUMNS, 'state'), consentStateFormula(), sep);

  var cats = ss.getSheetByName(TABS.CATEGORIES);
  setFormula_(cats, colOf(CATEGORY_COLUMNS, 'parent_list'), categoryParentsFormula(), sep);
  setFormula_(cats, colOf(CATEGORY_COLUMNS, 'child_list'), categoryChildrenFormula(), sep);
  setFormula_(cats, colOf(CATEGORY_COLUMNS, 'child_key'), categoryColumnCopyFormula_('subcategory'), sep);
  setFormula_(cats, colOf(CATEGORY_COLUMNS, 'child_parent'), categoryColumnCopyFormula_('category'), sep);
}

/**
 * A column of `categories` copied, so a lookup has a pair it can cross.
 *
 * `child_key` and `child_parent` are `subcategory` and `category` in that
 * order, which is the only arrangement a vectorised lookup can use: VLOOKUP
 * requires the key to the left of the answer, and INDEX/MATCH — the obvious
 * way to read A from B — returns a single value inside an ARRAYFORMULA rather
 * than a column. Two copied columns cost nothing and work.
 *
 * Both are gated on `subcategory` rather than each on itself, so the pair
 * always has the same height. Gating `child_parent` on `category` would keep a
 * parent whose child cell is blank, and every such row would then answer a
 * lookup for the empty string.
 */
function categoryColumnCopyFormula_(name) {
  var key = '$' + colOf(CATEGORY_COLUMNS, 'subcategory') + '$2:$' +
    colOf(CATEGORY_COLUMNS, 'subcategory');
  var value = '$' + colOf(CATEGORY_COLUMNS, name) + '$2:$' + colOf(CATEGORY_COLUMNS, name);

  return '=ARRAYFORMULA(IF(' + key + '="","",' + value + '))';
}

/** `categories!$G$2:$H` — the pair `subcategoryParentFormula_` looks through. */
function childParentRange_() {
  return TABS.CATEGORIES + '!$' + colOf(CATEGORY_COLUMNS, 'child_key') + '$2:$' +
    colOf(CATEGORY_COLUMNS, 'child_parent');
}

/**
 * categories.parent_list — each parent once, in the order the tab lists them.
 *
 * Sorting was considered and rejected: the seed order groups Income first and
 * `Other` last, which is the order you think in. Alphabetical would put
 * `Fees & Taxes` above `Food & Drink` and bury `Transfer` in the middle.
 */
/**
 * The range every category dropdown points at — one place, so they agree.
 *
 * Returns null on a book without the tab rather than throwing, because a
 * missing dropdown is a worse-but-usable sheet and a throw here would take
 * the whole of `setup()` down with it.
 */
function categoryListRange_(ss) {
  return derivedCategoryRange_(ss, 'parent_list');
}

/** The same, for subcategories. Every one of them, not the chosen parent's. */
function subcategoryListRange_(ss) {
  return derivedCategoryRange_(ss, 'child_list');
}

function derivedCategoryRange_(ss, name) {
  var cats = ss.getSheetByName(TABS.CATEGORIES);
  if (!cats) return null;

  var column = colOf(CATEGORY_COLUMNS, name);
  return cats.getRange(column + '2:' + column);
}

function categoryParentsFormula() {
  return uniqueColumnFormula_(colOf(CATEGORY_COLUMNS, 'category'));
}

/**
 * Sorted, where the parents deliberately are not.
 *
 * The parent list keeps the seed order because that order is Income first and
 * `Other` last, which is how you think about them. Subcategories have no such
 * order — they arrive grouped by parent, so an unsorted list means scrolling
 * past twelve `Housing` children to reach a `Transport` one you can already
 * name. Alphabetical is the only order a flat list of eighty can usefully have.
 */
function categoryChildrenFormula() {
  return '=SORT(' + uniqueColumnFormula_(colOf(CATEGORY_COLUMNS, 'subcategory')).slice(1) + ')';
}

function uniqueColumnFormula_(letter) {
  var range = '$' + letter + '$2:$' + letter;
  return '=UNIQUE(FILTER(' + range + ',' + range + '<>""))';
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
 * amount_base — the column every report reads, never `amount`.
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

/**
 * category — your override, then your subcategory's parent, then the cascade.
 *
 * The middle branch is what makes correcting a row one choice instead of two.
 * A subcategory names exactly one parent, so `Groceries` already says
 * `Food & Drink`, and asking for both was asking you to type what the sheet
 * could work out. `category_override` stays first because it is the only way
 * to say "this parent, and none of its children in particular".
 *
 * `VLOOKUP` and not `INDEX`/`MATCH`: INDEX returns one value inside an
 * ARRAYFORMULA no matter how tall its argument is, which yields the first
 * row's answer repeated down the column — right on row 2, wrong everywhere
 * else, and wrong in a way that reads as working. `typeFormula` crosses the
 * same tab the same way for the same reason.
 *
 * `IFERROR` back to the cascade rather than to blank: a subcategory you typed
 * that is not on the tab yet is a normal state — the dropdown allows it — and
 * blanking the category of every such row would empty the reports for a
 * spelling you were about to fix.
 */
function categoryFormula() {
  var a = colOf(TX_COLUMNS, 'uid');
  var auto = '$' + colOf(TX_COLUMNS, 'category_auto') + '$2:$' +
    colOf(TX_COLUMNS, 'category_auto');
  var ovr = colOf(TX_COLUMNS, 'category_override');
  var sub = '$' + colOf(TX_COLUMNS, 'subcategory_override') + '$2:$' +
    colOf(TX_COLUMNS, 'subcategory_override');

  return '=ARRAYFORMULA(IF(LEN($' + a + '$2:$' + a + ')=0,"",' +
    'IF(LEN($' + ovr + '$2:$' + ovr + ')>0,$' + ovr + '$2:$' + ovr + ',' +
    'IF(LEN(' + sub + ')>0,' +
    'IFERROR(VLOOKUP(' + sub + ',' + childParentRange_() + ',2,FALSE),' + auto + '),' +
    auto + '))))';
}

/**
 * subcategory — cleared when you override the category.
 *
 * A subcategory left over from a different parent category is worse than no
 * subcategory: it reads as real and rolls up wrongly. There is deliberately
 * no subcategory_override column; if you need that precision, put it in notes.
 */
/**
 * subcategory — yours, then blank, then the cascade's.
 *
 * The middle branch is the one worth explaining. A `category_override` you
 * typed overrules the cascade's *category*, and the cascade's subcategory
 * belonged to the category you just overruled — `Groceries` under a row you
 * have moved to `Transport` is not a detail, it is wrong. So an override with
 * no subcategory beside it blanks the subcategory rather than keeping a stale
 * one.
 *
 * `subcategory_override` is how you say the other half. Without it the only
 * expressible correction was "this category, and no subcategory at all", which
 * is not what anyone means by correcting a row.
 */
function subcategoryFormula() {
  var a = colOf(TX_COLUMNS, 'uid');
  var auto = colOf(TX_COLUMNS, 'subcategory_auto');
  var ovr = colOf(TX_COLUMNS, 'category_override');
  var sub = colOf(TX_COLUMNS, 'subcategory_override');

  return '=ARRAYFORMULA(IF(LEN($' + a + '$2:$' + a + ')=0,"",' +
    'IF(LEN($' + sub + '$2:$' + sub + ')>0,$' + sub + '$2:$' + sub + ',' +
    'IF(LEN($' + ovr + '$2:$' + ovr + ')>0,"",$' + auto + '$2:$' + auto + '))))';
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
 * in_reports — whether a row counts as spending. The one place that decides.
 *
 * Three properties are load-bearing, and each of them has already cost this
 * project something in a different column:
 *
 * **It returns a boolean in every branch.** Sheets does not compare across
 * types — `=1=TRUE` is FALSE here where it is TRUE in Excel — so an expression
 * built by multiplying two tests yields `1`, and `where AC = true` silently
 * matches nothing. The nested IF ends in `<>`, which returns a real boolean,
 * and the other branch is the literal FALSE.
 *
 * **Rows with no transaction in them say FALSE, not "".** Every other derived
 * column here emits `""` for an empty row, which is right for a number or a
 * name. It is wrong for a boolean: QUERY infers a column's type from what is
 * in it, and an ARRAYFORMULA spills to the *sheet's* last row, not to the last
 * record. On a book with thirty transactions in a thousand-row sheet, a column
 * of thirty booleans and nine hundred and seventy empty strings is a text
 * column — and `= true` matches nothing, on the newest books, which are
 * exactly the ones where a blank dashboard reads as "not set up yet". FALSE on
 * the empty rows is also true: a row that does not exist is not spending.
 *
 * **`excluded` is compared to TRUE rather than tested for emptiness.** `LEN`
 * would be wrong in both directions — `LEN(FALSE)` is 5, so an unticked
 * checkbox would exclude the row. The checkbox validation applied in
 * `applyValidation_` is what makes the comparison reliable; a typed `yes` is
 * accepted by `isTruthyCell_` in code and would *not* exclude here, which is
 * why the column gets a real checkbox rather than being left free text.
 */
function inReportsFormula() {
  var uid = colOf(TX_COLUMNS, 'uid');
  var excluded = colOf(TX_COLUMNS, 'excluded');
  var type = colOf(TX_COLUMNS, 'type');

  return '=ARRAYFORMULA(IF(LEN($' + uid + '$2:$' + uid + ')=0,FALSE,' +
    'IF($' + excluded + '$2:$' + excluded + '=TRUE,FALSE,' +
    '$' + type + '$2:$' + type + '<>"' + TX_TYPE.TRANSFER + '")))';
}

/**
 * labels.transactions and labels.total_eur — the label report.
 *
 * Reporting over a comma-separated column, without new machinery: `COUNTIF` and
 * `SUMIF` both vectorise their *criteria* inside an ARRAYFORMULA, so one
 * formula anchored at row 2 covers every label you will ever add.
 *
 * The match is a wildcard substring, which carries one caveat worth stating
 * plainly rather than engineering around: **a label that is a substring of
 * another counts both.** `kids` would include `kids-school`. Whole-item
 * matching inside a comma-separated cell needs the range transformed before
 * SUMIF sees it, which SUMIF does not allow — and the alternatives (an MMULT
 * matrix over every transaction, or a helper column on `transactions`) are a
 * lot of machinery to buy a constraint that "keep label names distinct" already
 * satisfies.
 *
 * `total_eur` reads `amount_base` because every report does. It is signed, so a
 * label covering both a purchase and its refund nets out, which is the honest
 * figure for "what did this cost".
 *
 * Both are `…IFS` rather than `…IF` so they can carry the `in_reports`
 * condition, which is what makes a label you excluded, or a labelled transfer
 * between your own accounts, stop inflating the total. That was the whole
 * point of the column: one place decides what spending is, and everything that
 * reports on money asks it.
 */
function labelCountFormula() {
  var label = '$' + colOf(LABEL_COLUMNS, 'label') + '$2:$' + colOf(LABEL_COLUMNS, 'label');
  return '=ARRAYFORMULA(IF(LEN(' + label + ')=0,"",' +
    'COUNTIFS(' + txLabelsRange_() + ',"*"&' + label + '&"*",' +
    txColumnRange_('in_reports') + ',TRUE)))';
}

function labelTotalFormula() {
  var label = '$' + colOf(LABEL_COLUMNS, 'label') + '$2:$' + colOf(LABEL_COLUMNS, 'label');
  return '=ARRAYFORMULA(IF(LEN(' + label + ')=0,"",' +
    'SUMIFS(' + txColumnRange_('amount_base') + ',' +
    txLabelsRange_() + ',"*"&' + label + '&"*",' +
    txColumnRange_('in_reports') + ',TRUE)))';
}

/**
 * Built whole rather than left for the caller to prefix.
 *
 * `TABS.TRANSACTIONS + '$AA$2:$AA'` reads correctly at the call site and
 * produces `transactions$AA$2:$AA`, which does not parse — the `!` is easy to
 * lose exactly once and the harness cannot see it, because it never hands a
 * formula to a spreadsheet.
 */
function txLabelsRange_() {
  return txColumnRange_('labels');
}

/** A whole column of `transactions`, `!` and all. */
function txColumnRange_(name) {
  var column = colOf(TX_COLUMNS, name);
  return TABS.TRANSACTIONS + '!$' + column + '$2:$' + column;
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
  var txAmount = TABS.TRANSACTIONS + '!$' + colOf(TX_COLUMNS, 'amount_base') + '$2:$' + colOf(TX_COLUMNS, 'amount_base');
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

/**
 * Which columns carry a currency symbol, and which must not.
 *
 * Only a column guaranteed to be in one currency can name it. `amount_base`
 * qualifies by construction — its formula is blank whenever the row's
 * currency isn't the base one, which is the whole reason that column exists.
 * `cash_entry.amount` qualifies because cash entries have no currency field
 * at all.
 *
 * `transactions.amount` does **not**. It is the figure the bank sent, in the
 * bank's currency, and Fineco alone supplies CHF, GBP and USD rows. Stamping
 * € on it would render a foreign amount as euros — a wrong number that reads
 * as a right one, which is the failure this project spends most of its effort
 * avoiding. Column H says what currency it is; the format must not contradict
 * it.
 */
function currencyFormat_(code) {
  var symbols = { EUR: '€', GBP: '£', USD: '$' };
  var symbol = symbols[String(code || '').toUpperCase()] || String(code || '').toUpperCase();
  return symbol ? '#,##0.00 "' + symbol + '"' : '#,##0.00';
}

function applyFormats_(ss) {
  var dateCols = ['booking_date', 'value_date', 'transaction_date'];
  var base = readConfig_();
  var baseFormat = currencyFormat_(base.base_currency || 'EUR');

  [TABS.TRANSACTIONS, TABS.PENDING].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    var headers = name === TABS.PENDING ? PENDING_COLUMNS : TX_COLUMNS;
    dateCols.forEach(function (c) {
      if (headers.indexOf(c) !== -1) formatColumn_(sh, colOf(headers, c), 'yyyy-mm-dd');
    });

    // Unqualified: the row's own currency, whatever that is.
    if (headers.indexOf('amount') !== -1) formatColumn_(sh, colOf(headers, 'amount'), '#,##0.00');
    if (headers.indexOf('amount_base') !== -1) {
      formatColumn_(sh, colOf(headers, 'amount_base'), baseFormat);
    }
    formatColumn_(sh, colOf(headers, 'imported_at'), 'yyyy-mm-dd hh:mm');
  });

  var acc = ss.getSheetByName(TABS.ACCOUNTS);
  ['opening_balance', 'balance_api', 'balance_manual', 'balance'].forEach(function (c) {
    formatColumn_(acc, colOf(ACCOUNT_COLUMNS, c), '#,##0.00');
  });
  formatAccountBalancesByCurrency_(acc, baseFormat);

  var cash = ss.getSheetByName(TABS.CASH_ENTRY);
  formatColumn_(cash, colOf(CASH_ENTRY_COLUMNS, 'date'), 'yyyy-mm-dd');
  formatColumn_(cash, colOf(CASH_ENTRY_COLUMNS, 'amount'), baseFormat);

  // Qualified for the same reason amount_base is: the column sums amount_base,
  // which is blank on any row that is not in the base currency.
  var labels = ss.getSheetByName(TABS.LABELS);
  if (labels) formatColumn_(labels, colOf(LABEL_COLUMNS, 'total_eur'), baseFormat);

  var memory = ss.getSheetByName(TABS.MEMORY);
  if (memory) formatColumn_(memory, colOf(MEMORY_COLUMNS, 'last_seen'), 'yyyy-mm-dd');

  ss.getSheets().forEach(function (sh) {
    var lastCol = sh.getLastColumn();
    if (lastCol < 1) return;
    var header = sh.getRange(1, 1, 1, lastCol);
    header.setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
  });
}


/**
 * Each account's balance shown in that account's own currency.
 *
 * A column format cannot vary by row, so this is per row — which is fine
 * here and nowhere else: `accounts` holds tens of rows, not thousands. It is
 * also why a row you add by hand shows an unqualified number until the next
 * `setup()`, which is a re-run rather than a repair.
 *
 * The alternative was one symbol for the whole column, which would have
 * labelled Fineco's CHF, GBP and USD pockets as euros.
 */
function formatAccountBalancesByCurrency_(sheet, baseFormat) {
  var columns = ['opening_balance', 'balance_api', 'balance_manual', 'balance']
    .map(function (name) { return colIndex_(ACCOUNT_COLUMNS, name); });

  readRecords_(sheet, ACCOUNT_COLUMNS).forEach(function (row) {
    if (!row.account_id) return;
    var format = row.currency ? currencyFormat_(row.currency) : baseFormat;
    columns.forEach(function (column) {
      sheet.getRange(row._row, column).setNumberFormat(format);
    });
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
    .requireValueInRange(categoryListRange_(ss), true)
    .setAllowInvalid(true)
    .build();
  // Names, not ids. This pointed at column A — `account_id` — which for a bank
  // account is a provider UUID, so picking a wallet on a phone meant choosing
  // between forty characters of hex and forty other characters of hex.
  // `resolveCashAccount_` accepts either, so books written before this still
  // drain.
  var accountRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(accounts.getRange(whole_(ACCOUNT_COLUMNS, 'name')), true)
    .setAllowInvalid(true)
    .build();

  cash.getRange(colOf(CASH_ENTRY_COLUMNS, 'account') + '2:' + colOf(CASH_ENTRY_COLUMNS, 'account'))
    .setDataValidation(accountRule);
  cash.getRange(whole_(CASH_ENTRY_COLUMNS, 'category')).setDataValidation(categoryRule);

  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  tx.getRange(whole_(TX_COLUMNS, 'category_override')).setDataValidation(categoryRule);

  var subcategories = subcategoryListRange_(ss);
  if (subcategories) {
    var subcategoryRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(subcategories, true).setAllowInvalid(true).build();
    tx.getRange(whole_(TX_COLUMNS, 'subcategory_override')).setDataValidation(subcategoryRule);
    cash.getRange(whole_(CASH_ENTRY_COLUMNS, 'subcategory')).setDataValidation(subcategoryRule);
  }

  // The one place a label gets a dropdown. `transactions.labels` deliberately
  // does not — it holds `kids, travel` as often as one value, and a list rule
  // would flag every multi-label row. A cash entry is one thing you are
  // logging right now, so the common case is one label, and `allowInvalid`
  // leaves typing two of them open.
  var labels = ss.getSheetByName(TABS.LABELS);
  if (labels) {
    cash.getRange(whole_(CASH_ENTRY_COLUMNS, 'labels')).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInRange(labels.getRange(whole_(LABEL_COLUMNS, 'label')), true)
        .setAllowInvalid(true).build());
  }

  // The sign rule, written where a phone will show it: tapping a header cell
  // in mobile Sheets reveals its note. Documentation nobody has to find.
  cash.getRange(colOf(CASH_ENTRY_COLUMNS, 'amount') + '1').setNote(
    'Type the amount without a sign.\n\n' +
    'A bare number is spending. Pick an Income or Transfer category and it ' +
    'counts the other way — so an ATM withdrawal adds to this account, and ' +
    'the matching debit on the bank side nets it to zero.\n\n' +
    'Type a minus sign to force money out.');

  // A real checkbox, so confirming is a tap on a phone rather than typing the
  // word TRUE. `isTruthyCell_` still accepts a typed `yes` — someone who wrote
  // one has not made a mistake worth punishing with silence.
  var checkbox = SpreadsheetApp.newDataValidation().requireCheckbox().build();

  tx.getRange(colOf(TX_COLUMNS, 'confirmed') + '2:' + colOf(TX_COLUMNS, 'confirmed'))
    .setDataValidation(checkbox);

  // `excluded` gets one for a second reason on top of the tap: `in_reports`
  // compares it to TRUE, and a comparison against a column somebody might have
  // typed `yes` into is a silent miss. Code reading the same column still goes
  // through `isTruthyCell_`, so a sheet that predates this stays correct
  // everywhere except the formula — and the checkbox is what closes that gap
  // going forward.
  tx.getRange(colOf(TX_COLUMNS, 'excluded') + '2:' + colOf(TX_COLUMNS, 'excluded'))
    .setDataValidation(checkbox);

  // Same argument, on the two `accounts` flags the net worth total reads.
  // These are written as real booleans by `refreshAccounts`, so the only rows
  // at risk are the ones you type yourself — which is exactly how a manual
  // account is added, and therefore not a rare case.
  ['active', 'include_in_net_worth'].forEach(function (name) {
    accounts.getRange(colOf(ACCOUNT_COLUMNS, name) + '2:' + colOf(ACCOUNT_COLUMNS, name))
      .setDataValidation(checkbox);
  });

  // Deliberately no dropdown on `transactions.labels`. A label column holds
  // `kids, travel` as often as it holds one value, and a list rule would flag
  // every multi-label row with a warning triangle — which trains you to ignore
  // warnings, the opposite of what validation is for. The `labels` tab catches
  // the typo instead: a misspelling shows up there as a label with no
  // transactions against it, next to the real one with all of them.

  // How you mark a transfer, written where you would look for it. There is no
  // `type` you can type — `type` is derived from the category — so the answer
  // is a category, and nothing said so anywhere.
  tx.getRange(colOf(TX_COLUMNS, 'category_override') + '1').setNote(
    'Pick a category to correct the guess. The list is the parent categories ' +
    'from the categories tab.\n\n' +
    'To mark a move between your own accounts, choose Transfer — that is what ' +
    'sets type to transfer, and a transfer counts towards net worth but never ' +
    'towards spending.\n\n' +
    'An override is a stronger statement than a tick, so a row carrying one ' +
    'counts as confirmed on its own.');

  accounts.getRange(whole_(ACCOUNT_COLUMNS, 'kind'))
    .setDataValidation(listRule_(ACCOUNT_KINDS, false));

  applyClosedListValidation_(ss, checkbox);
}

/**
 * Every remaining column whose values come from a fixed set.
 *
 * The principle, stated once because it applies to all of them: **a column with
 * a closed vocabulary should be a dropdown, and the dropdown's list should be
 * the same object the code reads.** Typing into one of these is how you get a
 * `starts-with` that no rule engine has ever heard of, or an `Expense` that
 * does not match `expense` — failures that look like "the rule just doesn't
 * fire" and have no error anywhere to find.
 *
 * `setAllowInvalid` is the judgement call in each case, and it splits cleanly:
 *
 *   **false** where the code has a fixed `if` chain and anything else is
 *   meaningless — `rules.field`, `rules.match_type`, `rules.type`,
 *   `categories.kind`, `_import_map.target_column`, `accounts.kind`. A warning
 *   triangle on a value nothing will ever read is not a warning, it is a lie.
 *
 *   **true** where the list is a *convenience over live data* and being off it
 *   is legitimate — every category and subcategory dropdown, and the account
 *   filter. You may well be typing a category a moment before you add it to the
 *   `categories` tab, and refusing that would make the tab impossible to grow.
 *
 * Deliberately left as free text, and each for its own reason:
 *
 *   `transactions.labels` holds `kids, travel` as often as one value, and a
 *   list rule would flag every multi-label row — which trains you to ignore
 *   warnings, the opposite of what validation is for. The `labels` tab catches
 *   the typo instead: a misspelling appears there with no transactions against
 *   it, beside the real one with all of them.
 *
 *   `accounts.currency` is ISO 4217. A hundred and eighty entries is not a
 *   list you pick from, and the wrong one is caught anyway — a row whose
 *   currency is not the base currency gets no `amount_base`.
 *
 *   `accounts.provider`, `rules.value`, `labels.label` and every note or
 *   description column are open by nature. `labels.label` in particular is the
 *   *source* of a dropdown elsewhere; constraining it would close the loop.
 */
function applyClosedListValidation_(ss, checkbox) {
  var categoryRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(categoryListRange_(ss), true).setAllowInvalid(true).build();
  var subcategoryRule = subcategoryListRange_(ss)
    ? SpreadsheetApp.newDataValidation()
      .requireValueInRange(subcategoryListRange_(ss), true).setAllowInvalid(true).build()
    : null;

  var rules = ss.getSheetByName(TABS.RULES);
  if (rules) {
    rules.getRange(whole_(RULE_COLUMNS, 'field'))
      .setDataValidation(listRule_(RULE_FIELDS, false));
    rules.getRange(whole_(RULE_COLUMNS, 'match_type'))
      .setDataValidation(listRule_(RULE_MATCH_TYPES, false));
    rules.getRange(whole_(RULE_COLUMNS, 'type'))
      .setDataValidation(listRule_(TX_TYPES, false));
    rules.getRange(whole_(RULE_COLUMNS, 'category')).setDataValidation(categoryRule);
    if (subcategoryRule) {
      rules.getRange(whole_(RULE_COLUMNS, 'subcategory')).setDataValidation(subcategoryRule);
    }
    // A rule you switched off is a rule you are still deciding about, so this
    // is a checkbox rather than the word `false` — which `isTruthyCell_` would
    // read correctly and which nobody can see at a glance.
    rules.getRange(whole_(RULE_COLUMNS, 'enabled')).setDataValidation(checkbox);
  }

  var cats = ss.getSheetByName(TABS.CATEGORIES);
  if (cats) {
    cats.getRange(whole_(CATEGORY_COLUMNS, 'kind'))
      .setDataValidation(listRule_(TX_TYPES, false));

    // The parent, picked from the parents that already exist. `allowInvalid`
    // because creating a new parent is the other reason to type here — but
    // adding a *child* to an existing one is much the commoner, and typing it
    // is how you end up with `Food and Drink` beside `Food & Drink`: two
    // categories, two dropdown entries, and every total split between them.
    cats.getRange(whole_(CATEGORY_COLUMNS, 'category')).setDataValidation(categoryRule);
  }

  // The only thing a source header can usefully map to is a column that exists.
  var importMap = ss.getSheetByName(TABS.IMPORT_MAP);
  if (importMap) {
    importMap.getRange(whole_(IMPORT_MAP_COLUMNS, 'target_column'))
      .setDataValidation(listRule_(TX_COLUMNS, false));
    importMap.getRange(whole_(IMPORT_MAP_COLUMNS, 'preset'))
      .setDataValidation(listRule_(seededPresets_(DEFAULT_IMPORT_MAP), true));
  }

  var categoryMap = ss.getSheetByName(TABS.CATEGORY_MAP);
  if (categoryMap) {
    categoryMap.getRange(whole_(CATEGORY_MAP_COLUMNS, 'category'))
      .setDataValidation(categoryRule);
    if (subcategoryRule) {
      categoryMap.getRange(whole_(CATEGORY_MAP_COLUMNS, 'subcategory'))
        .setDataValidation(subcategoryRule);
    }
    categoryMap.getRange(whole_(CATEGORY_MAP_COLUMNS, 'preset'))
      .setDataValidation(listRule_(seededPresets_(DEFAULT_CATEGORY_MAP), true));
  }
}

/**
 * The preset names a seed already uses, for the column you type one into.
 *
 * Derived from the seed rather than from the tab, which sounds backwards and
 * is not: a rule reading the same column it validates is self-referential, and
 * a helper column of `UNIQUE(preset)` would be two more columns on two
 * internal tabs to save a word of typing.
 *
 * `allowInvalid` is true, because adding a preset for a bank nobody has
 * imported from yet is exactly what this column is for. The dropdown is here
 * to stop `BudgetBakers` and `budgetbakers` being two presets — a mapping that
 * silently applies to nothing, which is the failure this table makes easy.
 */
function seededPresets_(seed) {
  var seen = [];
  seed.forEach(function (row) {
    var preset = String(row[0] || '');
    if (preset && seen.indexOf(preset) === -1) seen.push(preset);
  });
  return seen;
}

/** `B2:B` for a named column, which is what every whole-column rule wants. */
function whole_(headers, name) {
  var letter = colOf(headers, name);
  return letter + '2:' + letter;
}

function listRule_(values, allowInvalid) {
  return SpreadsheetApp.newDataValidation()
    .requireValueInList(values, true)
    .setAllowInvalid(Boolean(allowInvalid))
    .build();
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
    colOf(TX_COLUMNS, 'amount_base') + '2:' + colOf(TX_COLUMNS, 'amount_base'),
    'spendsheet: formula (amount_base)');
  protectRange_(ss.getSheetByName(TABS.TRANSACTIONS),
    colOf(TX_COLUMNS, 'category') + '2:' + colOf(TX_COLUMNS, 'type'),
    'spendsheet: formula (category)');
  protectRange_(ss.getSheetByName(TABS.TRANSACTIONS),
    colOf(TX_COLUMNS, 'in_reports') + '2:' + colOf(TX_COLUMNS, 'in_reports'),
    'spendsheet: formula (in_reports)');
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
 * Columns worth seeing on `transactions`, out of twenty-eight.
 *
 * Everything else is either an identifier you never read (`uid`,
 * `entry_reference`, `bank_transaction_code`), a date the booking date already
 * answers for, or an intermediate the formula columns are built from
 * (`category_auto`, `subcategory_auto`).
 *
 * This exists because reviewing a row means reading the description and setting
 * two columns, and the two columns were twenty-two apart. The alternative —
 * moving `confirmed` next to `category_override` — is the one edit this schema
 * cannot survive: `setup()` rewrites the header row and does **not** move the
 * data under it, so reordering relabels every column from T rightwards while
 * their contents stay exactly where they were. Nothing would look wrong.
 *
 * Hiding is the same fact expressed where it costs nothing.
 */
var TX_VISIBLE_COLUMNS = [
  'account_name', 'booking_date', 'amount', 'description', 'counterparty',
  'amount_base', 'category_source', 'category_override', 'category',
  'labels', 'confirmed'
];

/**
 * Hide the machinery on `transactions`, on the run that creates it and never
 * again.
 *
 * Same contract as `hidePrivateTabs_`: a sensible default for a new book, and
 * your call for ever afterwards. Re-running `setup()` will not re-hide a column
 * you went and unhid, which matters because the reason to unhide one is usually
 * that you are in the middle of chasing something.
 */
function applyColumnVisibility_(ss, report) {
  var sheet = ss.getSheetByName(TABS.TRANSACTIONS);
  if (!sheet || !report) return;

  if (report.created.indexOf(TABS.TRANSACTIONS) !== -1) {
    TX_COLUMNS.forEach(function (name, i) {
      if (TX_VISIBLE_COLUMNS.indexOf(name) !== -1) return;
      sheet.hideColumns(i + 1);
    });
    return;
  }

  // An upgrade adding a column, on a sheet whose visibility is otherwise
  // yours. See `recordNewColumns_`.
  (report.newColumns || []).forEach(function (entry) {
    if (entry.tab !== TABS.TRANSACTIONS) return;
    if (TX_VISIBLE_COLUMNS.indexOf(entry.name) !== -1) return;
    sheet.hideColumns(entry.index);
  });
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
    TABS.DASHBOARD, TABS.RECENT, TABS.REPORTS, TABS.REVIEW, TABS.TRANSACTIONS,
    TABS.PENDING, TABS.ACCOUNTS, TABS.CASH_ENTRY, TABS.RULES,
    TABS.CATEGORIES, TABS.LABELS
  ];
  order.forEach(function (name, i) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(i + 1);
  });
}

// ---------------------------------------------------------------------------
// Accepting the defaults
// ---------------------------------------------------------------------------

/**
 * Menu → Update mappings to defaults.
 *
 * `setup()` reports a seeded row that disagrees with the defaults and changes
 * nothing, because it cannot tell an edit you made from one an old version
 * left behind. That is the right default and a dead end on its own: after the
 * taxonomy shrank from fifteen categories to twelve, eleven mappings still
 * pointed at parents that no longer exist, and the only offered remedy was
 * retyping them.
 *
 * So this is the other half — the same comparison, shown in full, applied
 * only on a yes. Keys are never touched, so nothing is added or removed here;
 * only the answer part of a row you already have is replaced.
 *
 * It also names **orphans**: rows whose target category is not in `categories`
 * at all. Those are invisible rather than wrong — an override naming a
 * category the taxonomy does not have simply never appears in a report that
 * groups by category, which is the most expensive way for a mapping to fail.
 */
function applySeedDefaults() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var report = { diverged: [] };
  UPGRADABLE_SEEDS.forEach(function (entry) {
    var sheet = ss.getSheetByName(entry.tab);
    if (sheet) reportSeedDivergence_(sheet, entry, entry.seed(), report);
  });

  var orphans = orphanedCategoryMappings_(ss);

  if (!report.diverged.length && !orphans.length) {
    ui.alert('Update mappings', 'Every seeded row already matches the defaults.', ui.ButtonSet.OK);
    return { updated: 0, orphans: orphans };
  }

  var answer = ui.alert('Update mappings',
    describeSeedUpdate_(report.diverged, orphans), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    ss.toast('Nothing was changed.', 'Cancelled', 5);
    return { updated: 0, orphans: orphans };
  }

  var updated = 0;
  UPGRADABLE_SEEDS.forEach(function (entry) {
    updated += rewriteSeedRows_(ss.getSheetByName(entry.tab), entry);
  });

  ss.toast(updated + ' row(s) updated.' +
    (orphans.length ? ' ' + orphans.length + ' orphan(s) left for you — see _anomalies.' : ''),
    'Defaults applied', 20);
  return { updated: updated, orphans: orphans };
}

// ---------------------------------------------------------------------------
// Retiring a category
// ---------------------------------------------------------------------------

/**
 * Menu → Tidy retired categories.
 *
 * `applySeedDefaults()` fixes rows whose *answer* drifted from the defaults. It
 * cannot fix a row that should not exist any more, because seeding only ever
 * adds: after the taxonomy went from fifteen parents to twelve, `Family`,
 * `Travel` and `Bills & Utilities` stayed in `categories` with all their
 * children, offered by every dropdown, one careless click from coming back.
 *
 * Removing them is not enough on its own. A `_category_map` row, a `rules` row
 * or a `category_override` still naming a retired category does not break —
 * it goes *invisible*, which is worse: the row is categorised as something no
 * report groups by, so its money silently leaves every total while the sheet
 * looks fine. That is the failure the tie-out against BudgetBakers caught.
 *
 * So references are repointed first and the rows removed second, and everything
 * is named before anything happens.
 *
 * `RETIRED_CATEGORIES` in 00_config.gs is keyed on the full category/subcategory
 * pair, which is what makes each move unambiguous. A `category_override` holds
 * a parent alone, so a parent is only rewritten when every one of its retired
 * children agrees on where it went: `Travel` always became `Entertainment`,
 * while `Family` split between `Shopping` and `Entertainment` and is therefore
 * reported and left for you.
 */
function tidyCategories() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plan = planCategoryTidy_(ss);

  if (plan.error) {
    ui.alert('Tidy retired categories', plan.error, ui.ButtonSet.OK);
    return plan;
  }

  var answer = ui.alert('Tidy retired categories', describeCategoryTidy_(plan), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    ss.toast('Nothing was changed.', 'Cancelled', 5);
    return plan;
  }

  var result = commitCategoryTidy_(ss, plan);
  ss.toast(result.removed + ' categories removed, ' + result.repointed + ' references repointed.',
    'Taxonomy tidied', 15);
  return result;
}

function planCategoryTidy_(ss) {
  var categories = ss.getSheetByName(TABS.CATEGORIES);
  if (!categories) return { error: 'No ' + TABS.CATEGORIES + ' tab. Run Setup sheet first.' };

  var rows = readRecords_(categories, CATEGORY_COLUMNS, colIndex_(CATEGORY_COLUMNS, 'category'));
  var present = {};
  rows.forEach(function (row) {
    if (row.category) present[pairKey_(row.category, row.subcategory)] = true;
  });

  var retired = RETIRED_CATEGORIES.filter(function (entry) {
    return present[pairKey_(entry.category, entry.subcategory)];
  });

  var parentMoves = unambiguousParentMoves_();

  var plan = {
    categories: categories,
    rows: rows,
    retired: retired,
    parentMoves: parentMoves,
    mappings: retargetPairs_(ss, TABS.CATEGORY_MAP, CATEGORY_MAP_COLUMNS, 'source_category'),
    rules: retargetPairs_(ss, TABS.RULES, RULE_COLUMNS, 'priority'),
    overrides: retargetOverrides_(ss, parentMoves),
    ambiguous: ambiguousParents_()
  };

  var work = retired.length + plan.mappings.length + plan.rules.length + plan.overrides.length;
  if (!work) {
    return { error: 'Nothing to tidy — no retired category is left in ' + TABS.CATEGORIES +
      ', and nothing still points at one.' };
  }

  return plan;
}

function pairKey_(category, subcategory) {
  return String(category || '') + '\u0000' + String(subcategory || '');
}

/**
 * Retired parents whose children all went to the same place.
 *
 * A parent is only safe to rewrite on its own when there is one answer. Anything
 * else has to be looked at, because picking either branch would file real
 * spending under a category you did not choose.
 */
function unambiguousParentMoves_() {
  var seen = {};
  RETIRED_CATEGORIES.forEach(function (entry) {
    var to = entry.to[0];
    if (!(entry.category in seen)) { seen[entry.category] = to; return; }
    if (seen[entry.category] !== to) seen[entry.category] = null;
  });

  var moves = {};
  Object.keys(seen).forEach(function (parent) {
    if (seen[parent]) moves[parent] = seen[parent];
  });
  return moves;
}

function ambiguousParents_() {
  var all = {};
  RETIRED_CATEGORIES.forEach(function (entry) { all[entry.category] = true; });

  var unambiguous = unambiguousParentMoves_();
  return Object.keys(all).filter(function (parent) { return !unambiguous[parent]; });
}

/**
 * Rows on a tab whose `category`/`subcategory` name a retired pair.
 *
 * Both `_category_map` and `rules` carry those two columns under exactly those
 * names, so one function covers both — they differ only in which column decides
 * where the records end.
 */
function retargetPairs_(ss, tab, headers, keyColumn) {
  var sheet = ss.getSheetByName(tab);
  if (!sheet) return [];

  var byPair = {};
  RETIRED_CATEGORIES.forEach(function (entry) {
    byPair[pairKey_(entry.category, entry.subcategory)] = entry.to;
  });

  return readRecords_(sheet, headers, colIndex_(headers, keyColumn))
    .map(function (row) {
      var to = byPair[pairKey_(row.category, row.subcategory)];
      if (!to) return null;
      return {
        tab: tab,
        headers: headers,
        row: row._row,
        from: row.category + ' / ' + row.subcategory,
        to: to[0] + ' / ' + to[1],
        category: to[0],
        subcategory: to[1]
      };
    })
    .filter(function (entry) { return entry; });
}

/**
 * `category_override` cells naming a retired parent.
 *
 * Parent-only, because that is all the column ever holds — `subcategory` blanks
 * itself whenever an override is present, so there is no child here to key on.
 */
function retargetOverrides_(ss, parentMoves) {
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  if (!tx) return [];

  return readRecords_(tx, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'))
    .map(function (row) {
      var from = String(row.category_override || '');
      var to = parentMoves[from];
      if (!to) return null;
      return { row: row._row, from: from, to: to };
    })
    .filter(function (entry) { return entry; });
}

function describeCategoryTidy_(plan) {
  var lines = [];

  if (plan.retired.length) {
    lines.push('Remove ' + plan.retired.length + ' retired categories from ' + TABS.CATEGORIES + ':');
    plan.retired.forEach(function (entry) {
      lines.push('  ' + entry.category + ' / ' + entry.subcategory + '  →  ' +
        entry.to[0] + ' / ' + entry.to[1]);
    });
    lines.push('');
  }

  [['mappings', TABS.CATEGORY_MAP], ['rules', TABS.RULES]].forEach(function (pair) {
    var entries = plan[pair[0]];
    if (!entries.length) return;
    lines.push('Repoint ' + entries.length + ' rows in ' + pair[1] + ':');
    summarizeMoves_(entries).forEach(function (line) { lines.push('  ' + line); });
    lines.push('');
  });

  if (plan.overrides.length) {
    lines.push('Rewrite category_override on ' + plan.overrides.length + ' transactions:');
    summarizeMoves_(plan.overrides).forEach(function (line) { lines.push('  ' + line); });
    lines.push('');
  }

  if (plan.ambiguous.length) {
    lines.push('⚠ Left alone: ' + plan.ambiguous.join(', ') + '. Their children went to more ' +
      'than one parent, so a row naming only the parent cannot be resolved without guessing. ' +
      'Retype those by hand.');
    lines.push('');
  }

  lines.push('Continue?');
  return lines.join('\n');
}

function summarizeMoves_(entries) {
  var counts = {};
  entries.forEach(function (entry) {
    var key = entry.from + '  →  ' + entry.to;
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts).sort().map(function (key) { return key + '  (' + counts[key] + ')'; });
}

/**
 * References first, rows second.
 *
 * In that order because the reverse leaves a window — however short — where a
 * mapping points at a category the taxonomy no longer has, which is exactly the
 * invisible state this exists to end.
 */
function commitCategoryTidy_(ss, plan) {
  var repointed = 0;

  plan.mappings.concat(plan.rules).forEach(function (entry) {
    var sheet = ss.getSheetByName(entry.tab);
    writeCell_(sheet, entry.row, entry.headers, 'category', entry.category);
    writeCell_(sheet, entry.row, entry.headers, 'subcategory', entry.subcategory);
    repointed++;
  });

  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  plan.overrides.forEach(function (entry) {
    writeCell_(tx, entry.row, TX_COLUMNS, 'category_override', entry.to);
    repointed++;
  });

  var removed = removeRetiredCategories_(plan);

  return { removed: removed, repointed: repointed, ambiguous: plan.ambiguous };
}

/**
 * Rewrite `categories` without the retired rows.
 *
 * Compacted rather than blanked in place: the dropdown reads `A2:A`, and a run
 * of gaps in the middle of the list is the kind of untidiness that gets
 * "cleaned up" later by deleting rows, which is how an anchored formula on some
 * other tab dies. There are no formulas on this tab, so one rewrite is safe and
 * leaves nothing to tidy afterwards.
 */
function removeRetiredCategories_(plan) {
  var retiredKeys = {};
  plan.retired.forEach(function (entry) {
    retiredKeys[pairKey_(entry.category, entry.subcategory)] = true;
  });
  if (!plan.retired.length) return 0;

  var keep = plan.rows
    .filter(function (row) { return row.category; })
    .filter(function (row) { return !retiredKeys[pairKey_(row.category, row.subcategory)]; })
    .map(function (row) { return toRow_(CATEGORY_COLUMNS, row); });

  var sheet = plan.categories;
  clearDataRows_(sheet, colIndex_(CATEGORY_COLUMNS, 'category'), CATEGORY_COLUMNS.length);
  if (keep.length) sheet.getRange(2, 1, keep.length, CATEGORY_COLUMNS.length).setValues(keep);

  return plan.retired.length;
}

/** Replace the non-key columns of any row whose key matches a seed row. */
function rewriteSeedRows_(sheet, entry) {
  if (!sheet) return 0;

  var seed = entry.seed();
  var width = seed.length ? seed[0].length : 0;
  if (width <= entry.keyWidth) return 0;

  var wanted = {};
  seed.forEach(function (row) { wanted[seedKey_(row, entry.keyWidth)] = row; });

  var rows = readRecordsRaw_(sheet, width);
  var changed = 0;

  rows.forEach(function (have, i) {
    var want = wanted[seedKey_(have, entry.keyWidth)];
    if (!want) return;

    var differs = false;
    for (var c = entry.keyWidth; c < width; c++) {
      if (String(have[c] === undefined ? '' : have[c]) !== String(want[c])) differs = true;
    }
    if (!differs) return;

    // Only the columns after the key, so the row keeps its identity and its
    // position — this is an edit, not a delete and re-add.
    sheet.getRange(i + 2, entry.keyWidth + 1, 1, width - entry.keyWidth)
      .setValues([want.slice(entry.keyWidth)]);
    changed++;
  });

  return changed;
}

/**
 * Mappings pointing at a category the taxonomy no longer has.
 *
 * Not the same as a divergence: these may be rows you invented, and they are
 * not fixed by applying defaults. They are worth naming because the failure
 * is silent — the override is written, and every report that groups by
 * category simply never shows it.
 */
function orphanedCategoryMappings_(ss) {
  var categories = ss.getSheetByName(TABS.CATEGORIES);
  var map = ss.getSheetByName(TABS.CATEGORY_MAP);
  if (!categories || !map) return [];

  var known = {};
  readRecords_(categories, CATEGORY_COLUMNS).forEach(function (row) {
    if (row.category) known[row.category + '\u0000' + row.subcategory] = true;
  });

  return readRecords_(map, CATEGORY_MAP_COLUMNS)
    .filter(function (row) { return row.source_category && row.category; })
    .filter(function (row) { return !known[row.category + '\u0000' + row.subcategory]; })
    .map(function (row) {
      return { source: row.source_category, target: row.category + ' / ' + row.subcategory };
    });
}

function describeSeedUpdate_(diverged, orphans) {
  var lines = [];

  if (diverged.length) {
    lines.push('Replace ' + diverged.length + ' row(s) with the current defaults:');
    diverged.slice(0, 8).forEach(function (d) {
      lines.push('  ' + d.key + ':  "' + d.yours + '"  ->  "' + d.standard + '"');
    });
    if (diverged.length > 8) lines.push('  …and ' + (diverged.length - 8) + ' more.');
  }

  if (orphans.length) {
    lines.push('');
    lines.push(orphans.length + ' mapping(s) point at a category that no longer exists.');
    lines.push('They are left alone — a report grouping by category will not show them:');
    orphans.slice(0, 5).forEach(function (o) {
      lines.push('  ' + o.source + ' -> ' + o.target);
    });
  }

  lines.push('');
  lines.push('Anything you invented, and any key not in the defaults, is untouched.');
  lines.push('');
  lines.push('Continue?');
  return lines.join('\n');
}
