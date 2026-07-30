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
function colIndex_(headers, name) {
  var index = headers.indexOf(name);
  if (index === -1) throw new Error('colIndex_: no column named "' + name + '"');
  return index + 1;
}

function writeCell_(sheet, row, headers, name, value) {
  sheet.getRange(row, colIndex_(headers, name)).setValue(value);
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

/**
 * The data rows of a tab as objects keyed by column name.
 *
 * Reads the header block only, so columns you have added to the right of the
 * schema are neither read nor disturbed.
 */
function readRecords_(sheet, headers) {
  var keyColumn = 1;
  var last = lastRecordRow_(sheet, keyColumn);
  if (last < 2) return [];

  return sheet.getRange(2, 1, last - 1, headers.length).getValues().map(function (values, i) {
    var record = { _row: i + 2 };
    headers.forEach(function (name, c) { record[name] = values[c]; });
    return record;
  });
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

  // Emptiness is checked before Number(), because `Number('')` is 0 and
  // `isFinite(0)` is true — so a cleared cell would otherwise read as a
  // deliberate zero. A zero-day sync window fetches nothing and looks exactly
  // like a working sync.
  var blank = raw === '' || raw === null || raw === undefined ||
    (typeof raw === 'string' && !raw.trim());

  var value = Number(raw);
  if (!blank && isFinite(value)) return value;

  var fallback = DEFAULT_CONFIG.filter(function (row) { return row[0] === key; })[0];
  return fallback ? Number(fallback[1]) : 0;
}

/** `yes`/`true`/`1` are all yes; anything else is no. */
function configFlag_(config, key) {
  return isTruthyCell_(config[key]);
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
