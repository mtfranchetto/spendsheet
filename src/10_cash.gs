/**
 * 10_cash.gs — money that no API knows about.
 *
 * Adding a manual account is **not in this file, because it is not code**:
 * you type a row into `accounts`, pick `cash` or `asset` for its kind, and
 * the balance formula setup() already wrote covers it. A wizard for that
 * would be a menu item wrapping a thing you can do in four seconds.
 *
 * What does earn code is the other half — draining `cash_entry` into
 * `transactions` — because it runs unattended, repeatedly, and has to get
 * identity right.
 *
 * `cash_entry` is a **tab in the Sheets mobile app, not a Google Form**.
 * Forms has no native mobile app and cannot submit offline at all, and
 * logging a €3 coffee happens standing in a bar with no signal. Sheets has a
 * real offline mode, so an entry typed underground arrives whenever the phone
 * next reaches the network.
 *
 * Worth saying plainly: the zero-effort option is not itemising cash at all.
 * The ATM withdrawal is already captured as one expense. Cash is the
 * highest-friction part of every personal finance system and the first thing
 * people abandon.
 */

/** The row is yours until it has the two things that make it a transaction. */
function isCompleteCashEntry(entry) {
  return Boolean(entry.account) && !isBlankCell_(entry.amount) && isFinite(Number(entry.amount));
}

/**
 * The sign of a cash entry.
 *
 * Standing in a bar you type `3`, not `-3`, so a bare number means spending —
 * which is what almost every cash entry is. The category's own `kind` moves
 * it the other way when it should: income obviously, and also transfers,
 * because the common transfer into cash is an ATM withdrawal, which *adds* to
 * your wallet while showing as a debit on the bank side. That pair nets to
 * zero, which is the point.
 *
 * A minus sign you typed deliberately always wins — that is how you record
 * the rare direction, cash going back into a bank.
 */
function cashEntryAmount(typed, categoryKind) {
  var parsed = Number(typed);
  if (isBlankCell_(typed) || !isFinite(parsed)) return null;
  if (parsed < 0) return parsed;

  return (categoryKind === 'income' || categoryKind === 'transfer') ? parsed : -parsed;
}

/**
 * Identity for something with no bank behind it.
 *
 * There is no `entry_reference` and no batch to count an ordinal against:
 * two identical coffees can easily be typed hours apart and drained by
 * different runs, where a within-batch ordinal would give both the same key
 * and silently discard the second. So the uid carries a counter that only
 * ever goes up, kept in Script Properties.
 *
 * The content is hashed in alongside it rather than the counter alone, so
 * that if the property is ever lost the collision risk falls back to "two
 * genuinely identical entries" rather than becoming a certainty.
 */
function computeCashUid(entry, sequence) {
  return sha256Hex([
    'cash',
    entry.account,
    dateKey(entry.date),
    amountKey(entry.amount),
    normalizeDescription(entry.note),
    sequence
  ].join(UID_SEPARATOR));
}

function nextCashSequence_() {
  var properties = PropertiesService.getScriptProperties();
  var next = Number(properties.getProperty(SYNC_PROP.CASH_SEQUENCE) || 0) + 1;
  properties.setProperty(SYNC_PROP.CASH_SEQUENCE, String(next));
  return next;
}

/**
 * Move every completed `cash_entry` row into `transactions`.
 *
 * Incomplete rows are left alone rather than rejected: on a phone, a row with
 * a date and no amount yet is someone mid-typing, not an error. They stay
 * unprocessed and get picked up whenever they are finished, and the run
 * message says how many are waiting so they cannot sit there unnoticed
 * forever.
 */
function drainCashEntries_(existing, now) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CASH_ENTRY);
  if (!sheet) return { inserted: 0, incomplete: 0 };

  // ANY_COLUMN: on a phone you may fill these cells in any order, and a row
  // whose date you have not typed yet must not be invisible.
  var entries = readRecords_(sheet, CASH_ENTRY_COLUMNS, ANY_COLUMN)
    .filter(function (entry) { return !entry.processed; });
  if (!entries.length) return { inserted: 0, incomplete: 0 };

  var names = cashAccountNames_();
  var kinds = categoryKinds_();
  var currency = readConfig_().base_currency || 'EUR';
  var incomplete = 0;
  var records = [];
  var rows = [];

  entries.forEach(function (entry) {
    if (!isCompleteCashEntry(entry)) {
      incomplete++;
      return;
    }

    var accountId = String(entry.account);
    var record = {
      account_id: accountId,
      account_name: names[accountId] || accountId,
      booking_date: entry.date || new Date(now.getTime()),
      value_date: entry.date || '',
      transaction_date: entry.date || '',
      amount: cashEntryAmount(entry.amount, kinds[entry.category]),
      currency: currency,
      description: String(entry.note || entry.category || 'Cash'),
      counterparty: '',
      entry_reference: '',
      bank_transaction_code: '',
      mcc: '',
      source: TX_SOURCE_CASH,
      imported_at: now
    };
    record.uid = computeCashUid(record, nextCashSequence_());

    // The category you picked is an override, not a guess, so it goes in the
    // column the cascade is forbidden from touching.
    record._categoryOverride = entry.category || '';
    record._row = entry._row;
    records.push(record);
  });

  var partitioned = partitionByUid(records, existing.byUid);

  partitioned.fresh.forEach(function (record) {
    rows.push(toRow_(TX_COLUMNS_CODE, record));
    existing.byUid[record.uid] = { amount: record.amount, booking_date: record.booking_date };
  });

  if (rows.length) {
    var written = appendRows_(sheetOrThrow_(TABS.TRANSACTIONS), 1, rows);
    writeCashOverrides_(written.row, partitioned.fresh);
  }

  // Marked only after the append has gone in, so a failure halfway leaves the
  // entry unprocessed and it is retried rather than lost.
  records.forEach(function (record) {
    writeCell_(sheet, record._row, CASH_ENTRY_COLUMNS, 'processed', now);
  });

  return { inserted: rows.length, incomplete: incomplete };
}

/**
 * Write the picked category into `category_override`.
 *
 * A separate write because it lands in column T, on the far side of the
 * formulas — the block append covers A–O only, and reaching across it would
 * overwrite `amount_eur` with a blank.
 */
function writeCashOverrides_(firstRow, records) {
  var sheet = sheetOrThrow_(TABS.TRANSACTIONS);
  var column = colIndex_(TX_COLUMNS, 'category_override');

  records.forEach(function (record, i) {
    if (record._categoryOverride) {
      sheet.getRange(firstRow + i, column).setValue(record._categoryOverride);
    }
  });
}

/** account_id → the name you gave it. */
function cashAccountNames_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  var names = {};
  if (!sheet) return names;

  readRecords_(sheet, ACCOUNT_COLUMNS).forEach(function (row) {
    if (row.account_id) names[String(row.account_id)] = row.name || String(row.account_id);
  });
  return names;
}

/** category → kind, which is what decides the direction of a cash entry. */
function categoryKinds_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CATEGORIES);
  var kinds = {};
  if (!sheet) return kinds;

  readRecords_(sheet, CATEGORY_COLUMNS).forEach(function (row) {
    if (row.category && !kinds[row.category]) kinds[row.category] = row.kind;
  });
  return kinds;
}

// ---------------------------------------------------------------------------
// One row, and it lands straight away
// ---------------------------------------------------------------------------

/**
 * `cash_entry` as a form rather than as a spreadsheet.
 *
 * The original design was a tab you appended rows to, drained by the nightly
 * sync. Mechanically that is still what happens, and it is still the backstop.
 * As an *interface* it was wrong for the actual usage, which is roughly one
 * entry a day: you typed a row, nothing visible happened, and it appeared in
 * `transactions` some hours later. A whole tab to hold a queue of one, with a
 * delay you cannot see the end of.
 *
 * So there is one input row — row 2 — and the moment it has the two things
 * that make it a transaction, a simple `onEdit` drains it and empties the row
 * again. Type, and it is in. What you typed is then on `recent`, at the top,
 * which is where you would look anyway.
 *
 * Three things this deliberately keeps:
 *
 *   **The sync still drains.** If the trigger fails — and a simple `onEdit`
 *   fails silently, with nowhere on a phone for an error to appear — the row
 *   stays exactly where it is and the next sync picks it up. The immediate
 *   path is an optimisation over a mechanism that already worked, never a
 *   replacement for it. That is why it reuses `drainCashEntries_` whole rather
 *   than writing a second, faster path to `transactions`.
 *
 *   **A row is only cleared after the append has landed.** Same ordering as
 *   `processed`: a failure halfway leaves the entry there to be retried.
 *
 *   **A lock.** This is the one `onEdit` in the project that *appends* to
 *   `transactions` rather than rewriting two cells of an existing row, so the
 *   argument that it cannot collide with a running sync no longer holds. It
 *   takes the same lock the sync does and gives up rather than waiting: giving
 *   up leaves the row for the sync, which is about to append it anyway.
 */
var CASH_CONFIRM_CELL = 'H2';
var CASH_CONFIRM_LABEL = 'H1';

function onCashEntryEdit_(sheet, range) {
  // Row 1 is the header and column H is where this function's own confirmation
  // goes — writing there must not retrigger it.
  if (range.getRow() < 2) return;
  if (range.getColumn() >= columnIndexOf_(CASH_CONFIRM_CELL.charAt(0))) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var now = new Date();
    var result = drainCashEntries_(readExistingIndex_(sheetOrThrow_(TABS.TRANSACTIONS)), now);
    if (!result.inserted) return;

    clearDrainedCashRows_(sheet);
    sheet.getRange(CASH_CONFIRM_CELL).setValue(
      result.inserted + ' added ' + Utilities.formatDate(
        now, readConfig_().timezone || 'Europe/Rome', 'HH:mm') + ' — see recent');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Empty the rows that made it into `transactions`.
 *
 * Only the ones carrying a `processed` stamp, which `drainCashEntries_` writes
 * last of all. An incomplete row — a date typed, an amount not yet — is
 * someone mid-entry and is left exactly alone.
 *
 * This is the one behaviour the old design had that is genuinely lost: a
 * processed row used to stay on the tab as a record of what you had entered.
 * It is not much of a loss, because that record is `transactions` and it is
 * one tap away on `recent`, and it is what buys the tab being empty and ready
 * every time you open it.
 */
function clearDrainedCashRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return;

  var column = colIndex_(CASH_ENTRY_COLUMNS, 'processed');
  var stamps = sheet.getRange(2, column, last - 1, 1).getValues();

  for (var i = stamps.length - 1; i >= 0; i--) {
    if (isBlankCell_(stamps[i][0])) continue;
    sheet.getRange(i + 2, 1, 1, CASH_ENTRY_COLUMNS.length).clearContent();
  }
}

/**
 * The form's presentation: one obvious row, and nothing that looks like data.
 *
 * `processed` is hidden because it is now machinery rather than a column you
 * read — the row it stamps is cleared moments later. It stays in the schema
 * because the sync's drain still writes it, and because it is what
 * `clearDrainedCashRows_` reads to know which rows are safe to empty.
 */
function buildCashEntryForm_(ss) {
  var sheet = ss.getSheetByName(TABS.CASH_ENTRY);
  if (!sheet) return;

  sheet.getRange(2, 1, 1, CASH_ENTRY_COLUMNS.length - 1)
    .setBackground(DASH_COLOR.INPUT);

  sheet.getRange(CASH_CONFIRM_LABEL).setValue('Last added').setFontWeight('bold');
  sheet.getRange(CASH_CONFIRM_CELL).setFontColor('#5f6368');

  sheet.getRange('A1').setNote(
    'Type one entry on the blue row. It goes into transactions as soon as it ' +
    'has an account and an amount, and the row empties itself.\n\n' +
    'Leave the date blank for today. Type the amount without a sign — a bare ' +
    'number is spending, and an Income or Transfer category flips it.\n\n' +
    'If the row does not clear, nothing is lost: the nightly sync drains it.');

  sheet.hideColumns(colIndex_(CASH_ENTRY_COLUMNS, 'processed'));
  sheet.setColumnWidth(colIndex_(CASH_ENTRY_COLUMNS, 'note'), 280);
  sheet.setColumnWidth(columnIndexOf_(CASH_CONFIRM_CELL.charAt(0)), 220);
}
