/**
 * 03_sheets.gs — the spreadsheet primitives everything else is built from.
 *
 * These used to live wherever they were first needed, which meant the auth
 * file owned the append logic and the sync would have grown its own copy.
 * They are here instead because they are not about banks, consent or
 * transactions: they are about addressing a tab by column name and getting a
 * write to land where it should.
 *
 * Two rules are encoded here that are easy to get wrong by hand:
 *
 *   1. `getLastRow()` is not a record count. Several tabs carry an open-ended
 *      ARRAYFORMULA in row 2, so Sheets reports ~1000 rows of content on a tab
 *      holding nothing. Appending at `getLastRow() + 1` once put a real
 *      account at row 1001 while every run reported success. Row position is
 *      derived from a key column instead — always.
 *
 *   2. Bulk writes go through one `setValues`. A per-cell loop is fine for the
 *      handful of rows in `accounts`; at a few thousand transactions it burns
 *      the six-minute execution limit on round-trips alone.
 */

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * A tab by name, or a clear error.
 *
 * "Cannot read property getRange of null" is the least useful way to be told
 * that setup() has not been run.
 */
function sheetOrThrow_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sheet) throw new Error('No "' + name + '" tab. Run Spendsheet → Setup sheet first.');
  return sheet;
}

/** 1-based column index of a named column, e.g. colIndex_(TX_COLUMNS,'amount') === 7. */
// ---------------------------------------------------------------------------
// Addressing a formula
// ---------------------------------------------------------------------------

/*
 * These lived in `16_dashboard.gs` until the dashboard tab was removed, which
 * is the wrong home for them twice over: the reports tab and the review tab
 * both build formulas, and neither has anything to do with a dashboard. They
 * are addressing, and addressing is what this file is.
 */

/** `AA` -> 27. The inverse of `columnLetter`. */
function columnIndexOf_(letters) {
  var n = 0;
  for (var i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.toUpperCase().charCodeAt(i) - 64);
  }
  return n;
}

/** The column `offset` places to the right of a letter. */
function nextColumn_(letter, offset) {
  return columnLetter(columnIndexOf_(letter) + offset);
}

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

/**
 * The whole `transactions` block, for QUERY.
 *
 * QUERY names columns by their position **within the range given**, not by
 * their address on the sheet — so this has to start at column A or every letter
 * in every query shifts silently.
 */
function txQueryRange_() {
  return TABS.TRANSACTIONS + '!$A$2:$' + colOf(TX_COLUMNS, TX_COLUMNS[TX_COLUMNS.length - 1]);
}

/** A column letter for use inside a QUERY string. */
function q_(name) {
  return colOf(TX_COLUMNS, name);
}

function colIndex_(headers, name) {
  var index = headers.indexOf(name);
  if (index === -1) throw new Error('colIndex_: no column named "' + name + '"');
  return index + 1;
}

function writeCell_(sheet, row, headers, name, value) {
  sheet.getRange(row, colIndex_(headers, name)).setValue(value);
  forgetReadCache_();
  if (versionedSheet_(sheet)) bumpDataVersion_();
}

function readCell_(sheet, row, headers, name) {
  return sheet.getRange(row, colIndex_(headers, name)).getValue();
}

/** An object keyed by column name, laid out as a row in header order. */
function toRow_(headers, record) {
  return headers.map(function (name) {
    var value = record[name];
    return value === undefined || value === null ? '' : value;
  });
}

// ---------------------------------------------------------------------------
// Finding rows
// ---------------------------------------------------------------------------

/**
 * The last row that actually holds a record, judged by its key column.
 * Returns 1 (the header) when there are none.
 */
function lastRecordRow_(sheet, keyColumn) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;

  var values = sheet.getRange(2, keyColumn, lastRow - 1, 1).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== '' && values[i][0] !== null) return i + 2;
  }
  return 1;
}

/**
 * The first row whose key column is empty — where an *upsert* should write.
 *
 * Deliberately different from `lastRecordRow_() + 1`: this one reuses a gap
 * left by a deleted row, which is what you want on a small hand-editable tab
 * like `accounts` and emphatically not what you want on an append-only log.
 * Appending into a gap in `transactions` would put a new row in the middle of
 * history and break insert order permanently.
 */
function nextEmptyRow_(sheet, keyColumn) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2;

  var values = sheet.getRange(2, keyColumn, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) return i + 2;
  }
  return lastRow + 1;
}

/**
 * The last row with anything at all in the schema block.
 *
 * For tabs you type into in no fixed order — `cash_entry` on a phone — where
 * insisting on one key column means a row whose first cell you haven't filled
 * yet is invisible, and a transaction you typed silently never syncs.
 *
 * Only safe on a tab with no formulas in that block, since a formula counts
 * as content. `cash_entry` has none.
 */
function lastFilledRow_(sheet, width) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 1;

  var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    for (var c = 0; c < width; c++) {
      if (values[i][c] !== '' && values[i][c] !== null) return i + 2;
    }
  }
  return 1;
}

function findRowByValue_(sheet, column, value) {
  if (!value) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var values = sheet.getRange(2, column, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2;
  }
  return null;
}

/** Every value in a column, from row 2 down to the last record. */
function readColumn_(sheet, column) {
  var last = lastRecordRow_(sheet, column);
  if (last < 2) return [];
  return sheet.getRange(2, column, last - 1, 1).getValues().map(function (row) { return row[0]; });
}

/** Pass as `keyColumn` when no single column is reliably filled first. */
var ANY_COLUMN = 0;

/**
 * The data rows of a tab as objects keyed by column name.
 *
 * Reads the header block only, so columns you have added to the right of the
 * schema are neither read nor disturbed.
 */
function readRecords_(sheet, headers, keyColumn) {
  return recordValues_(sheet, headers.length, keyColumn).map(function (values, i) {
    var record = { _row: i + 2 };
    headers.forEach(function (name, c) { record[name] = values[c]; });
    return record;
  });
}

/**
 * A read cache for the length of one page request, and off everywhere else.
 *
 * Opening the app made **35 spreadsheet round trips** over about **seven
 * distinct tabs**. `_config` was read eight times because `readConfig_` is not
 * memoised and every caller reaches for it; `accounts` four times, by four
 * functions that each fetch it for themselves; `_status` and `_runs` twice
 * each. Measured on the live book: ~175ms a trip, `bootstrapMs` 6,170 — and
 * only 315ms of that was the ledger, which is the one read that had a cache.
 *
 * The multiplier nobody put there is that **`readRecords_` is two trips**:
 * `lastRecordRow_` scans the key column, then the block is read, because
 * `getLastRow()` lies on any tab carrying an `ARRAYFORMULA`. So seven tabs is
 * fourteen unavoidable calls and the other twenty-one were the same data
 * fetched again.
 *
 * **It is opt-in, and that is the whole safety argument.** A memo that is
 * always on is a correctness bug waiting for the first function that writes a
 * cell and reads it back — `setup()` and the sync both do, repeatedly. So the
 * default is `null`, meaning off, and the only thing that switches it on is a
 * *read-only* app request. That is not a new rule to remember: it is the seam
 * this project already has, where `21_query.gs` reads and `22_actions.gs`
 * writes. `appConfirm` and `appAddCash` deliberately run without it.
 *
 * Any write clears it anyway, as insurance rather than as the argument.
 *
 * What is cached is the **raw values**, not the records built from them.
 * Handing two callers the same record objects means a field one of them sets
 * appears in the other's copy, which is the kind of bug that surfaces a month
 * later on one tab. Rebuilding the objects is microseconds; the round trip is
 * the 175ms.
 */
var READ_CACHE = null;

function withReadCache_(fn) {
  var outer = READ_CACHE;
  READ_CACHE = {};
  try {
    return fn();
  } finally {
    READ_CACHE = outer;
  }
}

/** Any write invalidates it — see the note above on why this is not the argument. */
function forgetReadCache_() {
  if (READ_CACHE) READ_CACHE = {};
}

function recordValues_(sheet, width, keyColumn) {
  if (!READ_CACHE) return readRecordValues_(sheet, width, keyColumn);

  // `|` rather than a control character, deliberately: a literal one in a
  // source file makes grep classify it as binary and report nothing at all.
  var key = sheet.getName() + '|' + width + '|' + keyColumn;
  if (!Object.prototype.hasOwnProperty.call(READ_CACHE, key)) {
    READ_CACHE[key] = readRecordValues_(sheet, width, keyColumn);
  }
  return READ_CACHE[key];
}

function readRecordValues_(sheet, width, keyColumn) {
  var last = keyColumn === ANY_COLUMN
    ? lastFilledRow_(sheet, width)
    : lastRecordRow_(sheet, keyColumn || 1);
  if (last < 2) return [];

  return sheet.getRange(2, 1, last - 1, width).getValues();
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Append rows strictly after the last record, in one write.
 *
 * Never fills a gap — see `nextEmptyRow_`. The block is exactly as wide as the
 * rows given, so a tab whose later columns hold formulas or your own notes is
 * left alone.
 */
/**
 * A number that changes whenever `transactions` does.
 *
 * The ledger cache in `21_query.gs` is keyed on this, and the whole question a
 * cache has to answer is "has anything changed since". The obvious answer — the
 * row count — is wrong here, and wrong in the direction that matters:
 * confirming a transaction writes column AB and appends nothing, so the count
 * is identical and a cache keyed on it serves the row you just confirmed
 * straight back to you. The app's own writes would be the ones it could not
 * see. Same for a category override, a subcategory correction, and every edit
 * the review queue exists to make.
 *
 * So it counts *writes*, not rows. Bumped from `appendRows_` and `writeCell_`
 * rather than from each of the dozen callers that reach for them, because a
 * list of writers someone has to keep current is the thing that goes stale —
 * and the one that gets forgotten is the one that shows you the wrong balance.
 *
 * Failing to read it returns something that can never match a stored key, so a
 * broken PropertiesService means no cache rather than a stale one. That
 * direction is not negotiable: a cache that cannot prove it is current must
 * behave as though it is not.
 */
var DATA_VERSION_KEY = 'transactions_version';

function dataVersion_() {
  try {
    return String(
      PropertiesService.getScriptProperties().getProperty(DATA_VERSION_KEY) || '0');
  } catch (e) {
    return 'unreadable-' + Date.now();
  }
}

function bumpDataVersion_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var next = (Number(props.getProperty(DATA_VERSION_KEY)) || 0) + 1;
    props.setProperty(DATA_VERSION_KEY, String(next));
  } catch (e) {
    // A version that cannot be bumped is a cache that goes on serving the old
    // answer, so this is worth an anomaly rather than a silent pass.
    if (typeof logAnomaly_ === 'function') {
      logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'could not bump the data version', e.message);
    }
  }
}

/** Whether a write to this sheet invalidates the ledger cache. */
function versionedSheet_(sheet) {
  try {
    return !!sheet && sheet.getName() === TABS.TRANSACTIONS;
  } catch (e) {
    return false;
  }
}

function appendRows_(sheet, keyColumn, rows) {
  if (!rows || !rows.length) return { row: null, count: 0 };

  var width = rows[0].length;
  rows.forEach(function (row, i) {
    if (row.length !== width) {
      throw new Error('appendRows_: row ' + i + ' has ' + row.length + ' cells, expected ' + width);
    }
  });

  var start = lastRecordRow_(sheet, keyColumn) + 1;
  sheet.getRange(start, 1, rows.length, width).setValues(rows);
  forgetReadCache_();
  if (versionedSheet_(sheet)) bumpDataVersion_();
  return { row: start, count: rows.length };
}

/**
 * Blank every data row, keeping the header.
 *
 * `clearContent` rather than `deleteRows`, because deleting rows shifts
 * everything below them — including the row an ARRAYFORMULA anchors to.
 */
function clearDataRows_(sheet, keyColumn, width) {
  var last = lastRecordRow_(sheet, keyColumn);
  if (last < 2) return 0;

  sheet.getRange(2, 1, last - 1, width).clearContent();
  return last - 1;
}

/** Keep the newest `limit` rows of an append-only log. */
function trimToLastRows_(sheet, keyColumn, width, limit) {
  var last = lastRecordRow_(sheet, keyColumn);
  var rows = last - 1;
  if (rows <= limit) return 0;

  var excess = rows - limit;
  var keep = sheet.getRange(2 + excess, 1, limit, width).getValues();
  sheet.getRange(2, 1, rows, width).clearContent();
  sheet.getRange(2, 1, limit, width).setValues(keep);
  return excess;
}

// ---------------------------------------------------------------------------
// _config
// ---------------------------------------------------------------------------

/**
 * The `_config` tab as a plain object.
 *
 * Read fresh on each call rather than cached: a run may take minutes, and a
 * setting you changed to make a run behave should behave that way on the run
 * you changed it for.
 */
function readConfig_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CONFIG);
  var config = {};
  DEFAULT_CONFIG.forEach(function (row) { config[row[0]] = row[1]; });
  if (!sheet) return config;

  readRecords_(sheet, CONFIG_COLUMNS).forEach(function (row) {
    if (row.key !== '' && row.key !== null) config[String(row.key)] = row.value;
  });
  return config;
}

function configNumber_(config, key) {
  var raw = config[key];
  var value = Number(raw);
  if (!isBlankCell_(raw) && isFinite(value)) return value;

  var fallback = DEFAULT_CONFIG.filter(function (row) { return row[0] === key; })[0];
  return fallback ? Number(fallback[1]) : 0;
}

/** `yes`/`true`/`1` are all yes; anything else is no. */
function configFlag_(config, key) {
  return isTruthyCell_(config[key]);
}

/**
 * A cell with nothing in it.
 *
 * Worth its own function because the obvious check is wrong: `Number('')` is
 * 0 and `isFinite(0)` is true, so an empty cell reads as a deliberate zero
 * everywhere a number is parsed. A zero-day sync window fetches nothing and
 * looks exactly like a working sync; a zero-euro cash entry is a transaction
 * that never happened.
 */
function isBlankCell_(value) {
  if (value === '' || value === null || value === undefined) return true;
  return typeof value === 'string' && !value.trim();
}

/**
 * A cell meaning yes.
 *
 * A checkbox gives a real boolean, but the same column is often typed into by
 * hand, and someone writing `yes` in a column the code fills with `TRUE` has
 * not made a mistake worth punishing with silence.
 */
function isTruthyCell_(value) {
  if (value === true) return true;
  if (value === false || value === '' || value === null || value === undefined) return false;
  return /^(yes|true|1|on|y|si|sì)$/i.test(String(value).trim());
}

// ---------------------------------------------------------------------------
// _anomalies
// ---------------------------------------------------------------------------

/**
 * Record something we could not interpret, rather than dropping it.
 *
 * Never throws: a failure to log an anomaly must not become the thing that
 * breaks the run it was reporting on.
 */
function logAnomaly_(kind, accountId, detail, raw) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ANOMALIES);
    if (!sheet) return;

    var json = raw === undefined || raw === '' ? '' : (typeof raw === 'string' ? raw : JSON.stringify(raw));
    if (json && json.length > MAX_CELL_CHARS) json = json.slice(0, MAX_CELL_CHARS) + '…[truncated]';

    appendRows_(sheet, 1, [[new Date(), accountId || '', kind, detail || '', json || '']]);
  } catch (e) {
    Logger.log('logAnomaly_ failed: ' + e.message);
  }
}
