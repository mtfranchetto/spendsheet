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
 *
 * **`known` is a membership test, not the sync's index.** Every uid already in
 * the ledger, mapped to anything truthy. The sync hands over the `byUid` it
 * built for the banks; the immediate path hands over `readUidIndex_`, which
 * fetches one column instead of thirteen because that is the whole question
 * being asked. `partitionByUid` answers a richer one — which duplicates
 * conflict on their facts — and this has never read that half of its answer.
 *
 * **`categories` is optional and is an already-paid-for read.** The immediate
 * path reads that tab to refuse a category this book does not have, moments
 * before this runs; reading it again here is the same three round trips for the
 * same rows within one request. Nothing on this path writes to `categories`,
 * so there is no version of it that could have gone stale in between.
 *
 * Returns `stamped` — every row on the tab now carrying a `processed` mark,
 * including any left behind by an earlier drain whose clear did not land. It is
 * what `clearDrainedCashRows_` would otherwise go back and re-read the tab for.
 */
function drainCashEntries_(known, now, categories) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CASH_ENTRY);
  if (!sheet) return { inserted: 0, incomplete: 0, stamped: [] };

  // ANY_COLUMN: on a phone you may fill these cells in any order, and a row
  // whose date you have not typed yet must not be invisible.
  var all = readRecords_(sheet, CASH_ENTRY_COLUMNS, ANY_COLUMN);
  var stamped = all
    .filter(function (entry) { return entry.processed; })
    .map(function (entry) { return entry._row; });

  var entries = all.filter(function (entry) { return !entry.processed; });
  if (!entries.length) return { inserted: 0, incomplete: 0, stamped: stamped };

  var names = cashAccountNames_();
  var kinds = (categories || categoryIndex_()).kinds;
  var currency = readConfig_().base_currency || 'EUR';
  var incomplete = 0;
  var records = [];
  var rows = [];

  entries.forEach(function (entry) {
    if (!isCompleteCashEntry(entry)) {
      incomplete++;
      return;
    }

    var account = resolveCashAccount_(entry.account, names);
    var record = {
      account_id: account.id,
      account_name: account.name,
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

    // What you picked is an override, not a guess, so it goes in the columns
    // the cascade is forbidden from touching.
    record._categoryOverride = entry.category || '';
    record._subcategoryOverride = entry.subcategory || '';
    record._labels = entry.labels || '';
    record._row = entry._row;
    records.push(record);
  });

  // Membership, and it doubles as the within-batch guard `partitionByUid`
  // keeps its own map for: a uid written into `known` is a uid the next record
  // in this same batch will be refused for.
  var fresh = records.filter(function (record) {
    if (known[record.uid]) return false;
    known[record.uid] = { amount: record.amount, booking_date: record.booking_date };
    return true;
  });

  fresh.forEach(function (record) { rows.push(toRow_(TX_COLUMNS_CODE, record)); });

  if (rows.length) {
    var written = appendRows_(sheetOrThrow_(TABS.TRANSACTIONS), 1, rows);
    writeCashOverrides_(written.row, fresh);
  }

  // Marked only after the append has gone in, so a failure halfway leaves the
  // entry unprocessed and it is retried rather than lost.
  records.forEach(function (record) {
    writeCell_(sheet, record._row, CASH_ENTRY_COLUMNS, 'processed', now);
    stamped.push(record._row);
  });

  return { inserted: rows.length, incomplete: incomplete, stamped: stamped };
}

/**
 * Write what you picked into the columns the cascade never touches.
 *
 * Separate writes because these land in T, AD and AA — on the far side of the
 * formulas. The block append covers A–O only, and reaching across it would
 * overwrite `amount_base` with a blank.
 *
 * Cell by cell rather than one `setValues`, and that is the exception to the
 * bulk-write rule rather than a lapse from it: these are three non-adjacent
 * columns, so a single rectangular write would span every formula between them.
 * The volume is one row per entry typed, which is nothing.
 */
function writeCashOverrides_(firstRow, records) {
  var sheet = sheetOrThrow_(TABS.TRANSACTIONS);
  var fields = [
    ['_categoryOverride', 'category_override'],
    ['_subcategoryOverride', 'subcategory_override'],
    ['_labels', 'labels']
  ];

  records.forEach(function (record, i) {
    fields.forEach(function (pair) {
      if (!record[pair[0]]) return;
      sheet.getRange(firstRow + i, colIndex_(TX_COLUMNS, pair[1]))
        .setValue(record[pair[0]]);
    });
  });
}

/**
 * account_id → the name you gave it, and the name back to the id.
 *
 * The dropdown on `cash_entry.account` offers **names**, because the ids it
 * used to offer are provider UUIDs — a list of those is not something anyone
 * picks a wallet from on a phone. The stored value is still an id, so the name
 * has to resolve back.
 *
 * Both directions live in one map rather than two. A name and an id cannot
 * collide in a way that matters: `byId` is consulted first, so an id always
 * wins, and a *name* identical to some other account's id is the only losing
 * case — which requires naming an account after a UUID.
 */
function cashAccountNames_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  var map = { byId: {}, byName: {} };
  if (!sheet) return map;

  readRecords_(sheet, ACCOUNT_COLUMNS).forEach(function (row) {
    if (!row.account_id) return;

    var id = String(row.account_id);
    var name = row.name ? String(row.name) : id;
    map.byId[id] = name;
    if (!map.byName[name]) map.byName[name] = id;
  });
  return map;
}

/**
 * What you typed into `cash_entry.account`, as an id and a name.
 *
 * Accepts either, because the column has held ids since it existed and a book
 * that predates the dropdown is full of them. An unknown value is kept as
 * both, which is what makes a hand-typed account survive: it lands in
 * `transactions` as itself rather than as an empty cell.
 */
function resolveCashAccount_(value, accounts) {
  var typed = String(value);

  if (accounts.byId[typed]) return { id: typed, name: accounts.byId[typed] };
  if (accounts.byName[typed]) return { id: accounts.byName[typed], name: typed };
  return { id: typed, name: typed };
}

/**
 * `categories`, in the three shapes the cash path asks it about, from one read.
 *
 * `kinds` decides the direction of an entry; the two name sets decide whether
 * this book has the category you picked at all. Both questions get asked inside
 * one `appAddCash`, a few lines apart, and `readRecords_` is three round trips
 * every time it is called — so asking them separately was the same tab fetched
 * twice in a request somebody is waiting on.
 *
 * `present` is not the same as "has any rows", and the difference is the reason
 * it is here: a book with no `categories` tab can say nothing about whether a
 * name is known, and a caller that read absence as "unknown" would refuse every
 * category in the book. A tab that exists and is empty genuinely knows none.
 */
function categoryIndex_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CATEGORIES);
  var index = { present: false, kinds: {}, categories: {}, subcategories: {} };
  if (!sheet) return index;

  index.present = true;
  readRecords_(sheet, CATEGORY_COLUMNS).forEach(function (row) {
    if (row.category && !index.kinds[row.category]) index.kinds[row.category] = row.kind;

    var category = String(row.category || '').trim();
    var subcategory = String(row.subcategory || '').trim();
    if (category) index.categories[category] = true;
    if (subcategory) index.subcategories[subcategory] = true;
  });
  return index;
}

/** category → kind, which is what decides the direction of a cash entry. */
function categoryKinds_() {
  return categoryIndex_().kinds;
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
// Deliberately past the last schema column with a blank column between, so
// that appending one more field to the form cannot land its header on this
// label — which is exactly what happened when `subcategory` and `labels` were
// added and `processed` moved into H.
var CASH_CONFIRM_CELL = 'J2';
var CASH_CONFIRM_LABEL = 'J1';

function onCashEntryEdit_(sheet, range) {
  // Row 1 is the header and column H is where this function's own confirmation
  // goes — writing there must not retrigger it.
  if (range.getRow() < 2) return;
  if (range.getColumn() >= columnIndexOf_(CASH_CONFIRM_CELL.charAt(0))) return;

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;

  try {
    var now = new Date();
    var result = drainCashEntries_(readUidIndex_(sheetOrThrow_(TABS.TRANSACTIONS)), now);
    if (!result.inserted) return;

    clearDrainedCashRows_(sheet, result.stamped);
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
 * `rows` comes from the drain, which read the whole tab moments ago and knows
 * every stamp on it — including one left by an earlier drain whose clear did
 * not land, which is why that list is built before the unprocessed rows are
 * filtered out rather than from the records this run wrote. Going back to the
 * sheet for the same column would be two more round trips inside a request the
 * page is waiting on. Absent, the tab is read for them, which is what a caller
 * that did not run the drain has to do.
 *
 * A processed row does not stay on the tab as a record of what you entered.
 * That record is `transactions`, and an empty tab ready to type into is what
 * the clear buys.
 */
function clearDrainedCashRows_(sheet, rows) {
  var stamped = rows || stampedCashRows_(sheet);
  stamped.forEach(function (row) {
    sheet.getRange(row, 1, 1, CASH_ENTRY_COLUMNS.length).clearContent();
  });

  seedCashEntryDate_(sheet);
}

/** Which rows carry a `processed` stamp, asked of the sheet rather than the drain. */
function stampedCashRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var column = colIndex_(CASH_ENTRY_COLUMNS, 'processed');
  var stamps = sheet.getRange(2, column, last - 1, 1).getValues();

  var rows = [];
  for (var i = 0; i < stamps.length; i++) {
    if (!isBlankCell_(stamps[i][0])) rows.push(i + 2);
  }
  return rows;
}

/**
 * Put `=TODAY()` back in the date cell.
 *
 * A formula rather than a written-in date, so a tab you opened on Monday and
 * typed into on Tuesday records Tuesday. `drainCashEntries_` reads it through
 * `getValues`, which returns the computed date, so nothing downstream knows the
 * difference.
 *
 * Re-seeded after every clear because `clearContent` destroys the formula along
 * with everything else — which is correct, and means the refill belongs here
 * rather than only in the builder that runs at setup.
 */
function seedCashEntryDate_(sheet) {
  sheet.getRange(colOf(CASH_ENTRY_COLUMNS, 'date') + '2').setFormula('=TODAY()');
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

  // Only when the row is empty. A date you deliberately backdated, on a row you
  // are still typing, must survive a `setup()` run.
  if (isBlankCell_(sheet.getRange(colOf(CASH_ENTRY_COLUMNS, 'date') + '2').getValue())) {
    seedCashEntryDate_(sheet);
  }

  sheet.getRange(CASH_CONFIRM_LABEL).setValue('Last added').setFontWeight('bold');
  sheet.getRange(CASH_CONFIRM_CELL).setFontColor('#5f6368');

  sheet.getRange('A1').setNote(
    'Type one entry on the blue row. It goes into transactions as soon as it ' +
    'has an account and an amount, and the row empties itself.\n\n' +
    'The date is already today; overwrite it to backdate one. Type the amount ' +
    'without a sign — a bare number is spending, and an Income or Transfer ' +
    'category flips it.\n\n' +
    'If the row does not clear, nothing is lost: the nightly sync drains it.');

  sheet.hideColumns(colIndex_(CASH_ENTRY_COLUMNS, 'processed'));
  sheet.setColumnWidth(colIndex_(CASH_ENTRY_COLUMNS, 'note'), 280);
  sheet.setColumnWidth(columnIndexOf_(CASH_CONFIRM_CELL.charAt(0)), 220);
}
