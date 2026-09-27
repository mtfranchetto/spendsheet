/**
 * 17_review.gs — the unconfirmed backlog, and the one thing you can act on
 * from a phone.
 *
 * Loads after 17_analytics.gs (filename order, `a` before `r`) and before the
 * diagnostics. It shares the layer rather than the file because it is a
 * different kind of thing: analytics reads, this one writes back.
 *
 * ## Why a tab that is filled by code rather than by a QUERY
 *
 * A `QUERY` of the unconfirmed rows would refill itself, need no run, and work
 * on the phone — and it would be a trap. The rows a QUERY produces *move* when
 * the underlying data changes: confirm the third row and every row below it
 * shifts up by one. The tick you were about to put on row 8 would land on a
 * different transaction, and nothing anywhere would say so.
 *
 * So the queue is a snapshot with a `uid` in it, written by a run. `uid` is
 * what makes the write-back safe: a review row is a *pointer*, and a pointer
 * survives the tab being thrown away and rebuilt.
 *
 * ## Why `onEdit`, when 00_config argues against it
 *
 * The `confirmed` comment in 00_config.gs rejects an `onEdit` trigger as "no
 * extra information", and that reasoning is exactly right where it was made: a
 * row carrying a `category_override` already tells you everything a tick
 * would, so requiring both would be ceremony.
 *
 * It does not extend to here. On this tab the tick **is** the only signal
 * there is, and the alternative is no phone workflow at all — custom menus,
 * sidebars and dialogs do not exist in the Sheets mobile app, and `onEdit` is
 * the only mechanism that fires from it. Reopened deliberately, not by
 * accident.
 *
 * ## A simple trigger, not an installed one
 *
 * `onEdit` here is the *simple* trigger — a function of that name, no
 * installation step. That is a deviation from the plan, which called for an
 * installable one, and the argument for it is that the installable version
 * buys nothing this needs and costs something real:
 *
 *   - Everything it does is a read and a write **within the active
 *     spreadsheet**, which is precisely what a simple trigger is allowed. It
 *     calls no service that needs authorisation.
 *   - It requires no `installTriggers()` run, so it works on a fresh copy of
 *     the sheet the moment the code lands — and a review queue that silently
 *     does nothing until you remember a menu item is worse than not having one.
 *   - A project that defines `onEdit` gets the simple trigger whether it wants
 *     it or not. Installing a second trigger on the same function would fire
 *     the write-back twice per edit.
 *
 * What it costs, up front and unmitigated:
 *
 *   - It runs on **every** edit to the spreadsheet, so the first thing it does
 *     is compare the sheet name and return.
 *   - It fails **silently** — no toast survives, no alert fires, and on a
 *     phone there is nowhere for an error to appear at all. That is why the
 *     tab has a `status` column: the trigger writes what happened into the row
 *     it happened to, which is feedback a phone can actually see.
 *   - It has no lock. Two edits a second apart could interleave with a running
 *     sync. The sync only ever *appends* to `transactions` and this only ever
 *     rewrites two cells of an existing row, so the two cannot fight over the
 *     same cell — which is the reason this is acceptable rather than the
 *     reason it is safe.
 */

/** Filled by `setup()`; the schema itself comes from `buildTable_`. */
function buildReviewTab_(ss, report) {
  var sheet = ss.getSheetByName(TABS.REVIEW);
  if (!sheet) return;

  var categories = categoryListRange_(ss);
  var column = function (name) { return colOf(REVIEW_COLUMNS, name); };
  var whole = function (name) { return column(name) + '2:' + column(name); };

  sheet.getRange(whole('confirmed'))
    .setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());

  if (categories) {
    sheet.getRange(whole('category_override')).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInRange(categories, true)
        .setAllowInvalid(true).build());
  }

  var subcategories = subcategoryListRange_(ss);
  if (subcategories) {
    sheet.getRange(whole('subcategory_override')).setDataValidation(
      SpreadsheetApp.newDataValidation()
        .requireValueInRange(subcategories, true)
        .setAllowInvalid(true).build());
  }

  sheet.getRange(column('subcategory_override') + '1').setNote(
    'The one to reach for. Pick a subcategory and the category follows — ' +
    'Groceries means Food & Drink, and you do not set both.\n\n' +
    'Counts as confirmed on its own, exactly like the category next to it.');

  sheet.getRange(column('category_override') + '1').setNote(
    'Only when no subcategory fits — this sets the parent and leaves the ' +
    'subcategory blank. Normally use the column to the right instead.\n\n' +
    'Choose Transfer to mark a move between your own accounts — a transfer ' +
    'counts towards net worth but never towards spending.');

  formatColumn_(sheet, column('booking_date'), 'yyyy-mm-dd');
  formatColumn_(sheet, column('amount_base'),
    currencyFormat_(readConfig_().base_currency || 'EUR'));

  // Written where a phone will show it: tapping a header cell in mobile Sheets
  // reveals its note.
  sheet.getRange(column('confirmed') + '1').setNote(
    'Tick to confirm the guess to its left.\n\n' +
    'Or pick a different category first — an override is a stronger statement ' +
    'than a tick and counts as confirmed on its own.\n\n' +
    'Either one writes straight back to transactions, and the status column ' +
    'says whether it landed. The list itself is refilled by a run.\n\n' +
    'A row you have done goes grey and stays put. It leaves when the queue is ' +
    'next refilled — by the nightly sync, or by Spendsheet → Refresh review ' +
    'queue.');

  markReviewInputs_(sheet);

  if (!report || report.created.indexOf(TABS.REVIEW) === -1) return;

  sheet.hideColumns(colIndex_(REVIEW_COLUMNS, 'uid'));
  sheet.setColumnWidth(colIndex_(REVIEW_COLUMNS, 'description'), 320);
}

/**
 * Which cells are yours, and which rows you have already dealt with.
 *
 * A row you tick **stays on the tab** until the queue is next refilled, and
 * that is the design rather than a bug: the queue is a snapshot keyed by a
 * hidden `uid`, because a self-refilling `QUERY` would move its rows the
 * instant you confirmed one and land your next tick on a different
 * transaction. See the file header.
 *
 * But "correct and confusing" is still confusing. Nothing on the tab
 * distinguished a row you had done from one you had not, so the honest
 * complaint is that ten ticked rows look exactly like ten waiting ones. Grey
 * and struck through is what a done row should look like, and it costs one
 * rule.
 *
 * The condition is `=$H2=TRUE`, with **no comma**, and both halves of that are
 * load-bearing.
 *
 * `localizeFormula` translates the formulas written into *cells*, at the one
 * boundary they all cross. `setConditionalFormatRules` is not that boundary:
 * the rule reaches Sheets as authored, so a comma in one is a parse failure in
 * a decimal-comma locale with no cell to show `#ERROR!` in — the rule never
 * fires and the thing it was watching goes on looking fine. That rules out
 * `AND`, `IF`, `OR` and `VLOOKUP`, every one of which needs a separator.
 *
 * And the comparison is written against `TRUE` rather than as a bare cell
 * reference, because Sheets will not coerce across types: a condition yielding
 * `1` is not `TRUE` there, however obviously it is in Excel. `confirmed` is a
 * real checkbox holding a real boolean, so `=$H2=TRUE` needs no coercion and
 * says so explicitly.
 *
 * This used to defer the whole argument to `flagDashboardStates_`, which went
 * with `16_dashboard.gs` — leaving the reasoning for one of this project's
 * hardest-won invariants pointing at a name that greps to nothing, which is
 * strictly worse than no pointer at all. `git log -- src/16_dashboard.gs` has
 * the original. `tests/locale.test.mjs` now holds every rule in the book to
 * both halves, which is where this belonged in the first place.
 */
function markReviewInputs_(sheet) {
  var column = function (name) { return colOf(REVIEW_COLUMNS, name); };
  var first = colIndex_(REVIEW_COLUMNS, 'confirmed');
  var width = colIndex_(REVIEW_COLUMNS, 'subcategory_override') - first + 1;

  sheet.getRange(2, first, Math.max(sheet.getMaxRows() - 1, 1), width)
    .setBackground(DASH_COLOR.INPUT);

  var done = SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$' + column('confirmed') + '2=TRUE')
    .setFontColor('#9aa0a6')
    .setStrikethrough(true)
    .setRanges([sheet.getRange('A2:' + column('status'))])
    .build();

  sheet.setConditionalFormatRules([done]);
}

// ---------------------------------------------------------------------------
// Filling the queue
// ---------------------------------------------------------------------------

/**
 * Menu → Refresh review queue.
 *
 * Refilling needs a run, so this is desktop. The phone can clear a queue and
 * cannot refill one — that is the mobile constraint biting, and it is worth
 * stating rather than papering over. In practice it does not bite often: the
 * nightly sync refills the queue too, so the list you find in the morning is
 * already current.
 */
function refreshReviewQueue() {
  requireInteractive_();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var result = fillReviewQueue_(ss);

  if (result.error) {
    SpreadsheetApp.getUi().alert('Review queue', result.error,
      SpreadsheetApp.getUi().ButtonSet.OK);
    return result;
  }

  ss.toast(describeQueue_(result), 'Review queue', 15);
  return result;
}

/**
 * The same thing, from the sync, without a toast or an alert.
 *
 * Wrapped rather than allowed to throw: a queue that failed to refill is a
 * cosmetic problem, and a sync that reported FAIL because of one would send an
 * alert about the wrong thing entirely.
 */
function refreshReviewQueueQuietly_() {
  try {
    return fillReviewQueue_(SpreadsheetApp.getActiveSpreadsheet());
  } catch (e) {
    Logger.log('refreshReviewQueueQuietly_: ' + e.message);
    return { error: e.message };
  }
}

/**
 * Rewrite the tab from the unconfirmed rows, oldest first.
 *
 * Oldest first because a backlog is cleared from the far end: the rows you
 * have not looked at for three weeks are the ones a queue exists to surface,
 * and the ones from this morning will still be there tomorrow.
 *
 * Capped at `review_queue_size`. The backlog is expected to be under thirty,
 * so the cap is not really a limit — it is a guard for the first run on an
 * imported history, where the honest answer is four thousand rows and writing
 * them all would produce a tab nobody can face rather than a queue.
 */
function fillReviewQueue_(ss) {
  var sheet = ss.getSheetByName(TABS.REVIEW);
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  if (!sheet || !tx) {
    return { error: 'No ' + TABS.REVIEW + ' tab. Run Spendsheet → Setup sheet first.' };
  }

  var records = readRecords_(tx, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'));
  var pending = records.filter(function (record) { return !isConfirmedRow_(record); });

  pending.sort(function (a, b) { return dateOrder_(a.booking_date) - dateOrder_(b.booking_date); });

  var limit = queueSize_();
  var shown = pending.slice(0, limit);

  clearDataRows_(sheet, colIndex_(REVIEW_COLUMNS, 'uid'), REVIEW_COLUMNS.length);
  if (shown.length) {
    appendRows_(sheet, colIndex_(REVIEW_COLUMNS, 'uid'),
      shown.map(function (record) { return toRow_(REVIEW_COLUMNS, reviewRow_(record)); }));
  }

  return { shown: shown.length, pending: pending.length, limit: limit };
}

function reviewRow_(record) {
  return {
    uid: record.uid,
    booking_date: record.booking_date,
    account_name: record.account_name,
    description: record.description || record.counterparty,
    amount_base: record.amount_base,
    guess: record.category,
    why: record.category_source,
    confirmed: false,
    category_override: '',
    subcategory_override: '',
    status: ''
  };
}

/** A sortable number from a cell that may hold a Date, a string, or nothing. */
function dateOrder_(value) {
  if (value instanceof Date) return value.getTime();
  if (isBlankCell_(value)) return Infinity;

  var parsed = new Date(value);
  var time = parsed.getTime();
  return isNaN(time) ? Infinity : time;
}

function queueSize_() {
  var size = configNumber_(readConfig_(), 'review_queue_size');
  return size >= 1 ? Math.floor(size) : 50;
}

function describeQueue_(result) {
  if (!result.shown) return 'Nothing to review — every transaction is confirmed.';

  var text = result.shown + ' row(s) to review, oldest first.';
  if (result.pending > result.shown) {
    text += '\n\n' + result.pending + ' are unconfirmed in total; this shows the oldest ' +
      result.limit + '. Clear these and run it again for the next batch.';
  }
  return text;
}

// ---------------------------------------------------------------------------
// Writing back
// ---------------------------------------------------------------------------

/**
 * Runs on every edit anywhere in the book, which is why the guard is the first
 * thing and the cheapest thing.
 *
 * Never throws. An exception here has nowhere to go — a simple trigger has no
 * UI and, on a phone, no log you would ever look at — so a failure is written
 * to `_anomalies`, which is the one place in this project that a silent
 * failure is still findable from.
 *
 * `onEdit` is a public name Google reserves, so Door 1 lets anyone call it too.
 * A caller there can only send JSON, and JSON cannot hold a function. So a
 * `range` with no `getSheet` returns here, before the `catch` below would write
 * that stranger's call into `_anomalies`, once per call.
 */
function onEdit(e) {
  try {
    if (!e || !e.range || typeof e.range.getSheet !== 'function') return;

    var sheet = e.range.getSheet();
    if (!sheet) return;

    // Two tabs now, dispatched by name. Both return immediately on every other
    // edit in the book, which is the first thing a simple trigger must do —
    // this runs on every keystroke-sized change anyone makes to any tab.
    if (sheet.getName() === TABS.REVIEW) {
      applyReviewEdit_(sheet, e.range);
      return;
    }

    if (sheet.getName() === TABS.CASH_ENTRY && functionExists_('onCashEntryEdit_')) {
      onCashEntryEdit_(sheet, e.range);
    }
  } catch (err) {
    logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'onEdit write-back failed: ' + err.message, '');
  }
}

/** Whether an edited range covers one of the two columns that are yours. */
function reviewEditTouches_(range, name) {
  var first = range.getColumn();
  var last = first + range.getNumColumns() - 1;
  var column = colIndex_(REVIEW_COLUMNS, name);
  return column >= first && column <= last;
}

/**
 * Push the edited rows back into `transactions`.
 *
 * The uid index is built once per edit rather than once per row: a paste down
 * the checkbox column is a normal desktop gesture, and re-reading five
 * thousand uids for each of thirty rows is how a trigger hits the limit it has
 * no way to report hitting.
 *
 * `MAX_REVIEW_WRITE` is not a performance guard. It is there because the only
 * way to edit hundreds of review rows at once is a paste that went somewhere
 * unintended, and confirming four thousand transactions is the one thing this
 * flag is supposed to make impossible.
 */
var MAX_REVIEW_WRITE = 100;

function applyReviewEdit_(sheet, range) {
  var touched = {
    confirmed: reviewEditTouches_(range, 'confirmed'),
    override: reviewEditTouches_(range, 'category_override'),
    subcategory: reviewEditTouches_(range, 'subcategory_override')
  };
  if (!touched.confirmed && !touched.override && !touched.subcategory) return 0;

  // Clamped at both ends rather than just the start. Taking `max(row, 2)` on
  // its own turns an edit to the *header* into a write against row 2 — the
  // top row of the queue, which is the oldest thing in the backlog and the
  // last row you would want confirmed by accident.
  var first = Math.max(range.getRow(), 2);
  var last = range.getRow() + range.getNumRows() - 1;
  if (last < first) return 0;

  var count = Math.min(last - first + 1, MAX_REVIEW_WRITE);
  var tx = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.TRANSACTIONS);
  if (!tx) return 0;

  var index = uidIndex_(tx);
  var written = 0;

  for (var i = 0; i < count; i++) {
    if (writeReviewRow_(sheet, tx, index, first + i, touched)) written++;
  }
  return written;
}

/**
 * `confirmed` is written only when the tick itself was the edit.
 *
 * Not for tidiness: writing it unconditionally would mean that typing a
 * category into a row you had already ticked sends `FALSE` back and quietly
 * un-confirms it. The tick and the override are two independent statements and
 * each one travels on its own edit.
 *
 * An override travelling alone is enough on its own — either one, category or
 * subcategory: `isConfirmedRow_` counts a row carrying one as confirmed, for
 * the reason 00_config.gs gives: typing the category is a stronger statement
 * than ticking a box next to it.
 */
function writeReviewRow_(sheet, tx, index, row, touched) {
  var values = sheet.getRange(row, 1, 1, REVIEW_COLUMNS.length).getValues()[0];
  var at = function (name) { return values[colIndex_(REVIEW_COLUMNS, name) - 1]; };

  var uid = String(at('uid') || '');
  if (!uid) return false;

  var target = index[uid];
  if (!target) {
    setStatus_(sheet, row, 'not in ' + TABS.TRANSACTIONS + ' — refresh the queue');
    return false;
  }

  if (touched.override && !isBlankCell_(at('category_override'))) {
    writeCell_(tx, target, TX_COLUMNS, 'category_override', at('category_override'));
  }
  if (touched.subcategory && !isBlankCell_(at('subcategory_override'))) {
    writeCell_(tx, target, TX_COLUMNS, 'subcategory_override', at('subcategory_override'));
  }
  if (touched.confirmed) {
    writeCell_(tx, target, TX_COLUMNS, 'confirmed', isTruthyCell_(at('confirmed')));
  }

  setStatus_(sheet, row, 'saved ' + Utilities.formatDate(
    new Date(), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(),
    'yyyy-MM-dd HH:mm'));
  return true;
}

function setStatus_(sheet, row, text) {
  writeCell_(sheet, row, REVIEW_COLUMNS, 'status', text);
}

/**
 * uid → row, read in one `getValues`.
 *
 * The first occurrence wins. A duplicate uid is not supposed to exist — that
 * is what `08_dedup.gs` is for — and picking a later one would make the
 * write-back depend on which copy of a bug you happened to have.
 */
function uidIndex_(tx) {
  var column = colIndex_(TX_COLUMNS, 'uid');
  var last = lastRecordRow_(tx, column);
  var index = {};
  if (last < 2) return index;

  tx.getRange(2, column, last - 1, 1).getValues().forEach(function (row, i) {
    var uid = String(row[0] || '');
    if (uid && !index[uid]) index[uid] = i + 2;
  });
  return index;
}
