/**
 * 22_actions.gs — the two things the app writes.
 *
 * Reading is 21_query.gs and it is careful to write nothing at all. This file
 * is the other half: confirming a guess, and adding a cash transaction. Both
 * existed already as spreadsheet gestures — a checkbox on `review`, a row on
 * `cash_entry` — and neither of those gestures is reachable from a web page.
 *
 * ## Why the existing write-backs could not simply be called
 *
 * The review write-back is `onEdit`-shaped end to end. `applyReviewEdit_` takes
 * a `Range`; `writeReviewRow_` takes a row number **on the review tab** and
 * reads the values back out of it. A page has neither: it has a uid and a
 * decision. So the rules move rather than the mechanism — the three rules in
 * `writeReviewRow_` are reproduced here against a different input, and the
 * comment on each says which one it is, because two implementations of a rule
 * are two places for it to be wrong.
 *
 * Cash is the opposite: `drainCashEntries_` is already exactly the right thing
 * and is reused whole, lock and all. What this adds is the row, which on the
 * Sheets side you type. Reusing the drain rather than writing a second, faster
 * path to `transactions` is deliberate — uid generation, sign logic, dedup and
 * override placement are all in there, and a second copy of any of them is a
 * second thing to get wrong.
 *
 * ## Column ownership is a convention, and this file is where it is honoured
 *
 * `applyProtection_` sets **warning-only** protections, which do not block a
 * script write at all — they are a hint to a person, not a lock on the code.
 * So the rule that code owns `transactions` A–O and you own P onward is kept
 * here by being kept: the only columns written below are `confirmed`,
 * `category_override` and `subcategory_override`. A write to A–O from a page
 * would land silently and break row identity for ever.
 */

/**
 * How many rows one confirmation call may write.
 *
 * The same number and the same argument as `MAX_REVIEW_WRITE`: the only way to
 * confirm hundreds of rows in one gesture is something that went wrong, and
 * confirming four thousand transactions is what the flag exists to make
 * impossible. It is a separate constant because the two arrive from different
 * places — a paste on a desktop, a request from a browser — and a request is
 * the one that can be repeated.
 */
var MAX_APP_DECISIONS = 100;

/**
 * Push a batch of decisions from the app back into `transactions`.
 *
 * A decision is `{uid, confirmed?, category_override?, subcategory_override?}`,
 * and the uid is the whole of the addressing. The same choice `17_review.gs`
 * makes and for the same reason: a list on a phone re-sorts as you act on it,
 * so a position is not a thing you can send back.
 *
 * The three rules, each one taken from `writeReviewRow_`:
 *
 *   **A blank override is not an override.** Sending `category_override: ''`
 *   means "I did not touch this", not "clear it". Clearing a category you had
 *   typed, because a form serialised an empty input, is the shape of data loss
 *   that is discovered months later.
 *
 *   **`confirmed` is written only when it was supplied.** Writing it every time
 *   means that correcting a category on a row you had already ticked sends
 *   `false` back and quietly un-confirms it. The tick and the override are two
 *   independent statements.
 *
 *   **An override travelling alone is confirmation enough**, so nothing here
 *   needs to send both. `isConfirmedRow_` counts a row carrying one as
 *   confirmed — typing the category is a stronger statement than ticking a box
 *   next to it.
 *
 * The uid index is built once for the batch rather than once per decision:
 * re-reading five thousand uids for each of thirty rows is how a request runs
 * out of time with nothing written.
 *
 * Reports per decision rather than throwing on the first bad one. A batch that
 * half worked has to say which half, because the page is going to redraw from
 * it — and a uid that is not in `transactions` is a stale list rather than an
 * error, which is a different thing to tell someone.
 */
function applyReviewDecisions_(decisions) {
  // Coerced rather than trusted. This is reached from a browser, so "it will
  // be an array" is a hope about a caller rather than a fact about a value,
  // and `.slice` on an object is a TypeError with no useful message in it.
  var list = Array.isArray(decisions) ? decisions : [];
  var requested = list.slice(0, MAX_APP_DECISIONS);
  var result = { written: 0, skipped: 0, results: [],
    capped: list.length > MAX_APP_DECISIONS };
  if (!requested.length) return result;

  var tx = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.TRANSACTIONS);
  if (!tx) throw new Error('No "' + TABS.TRANSACTIONS + '" tab. Run Spendsheet → Setup sheet first.');

  var index = uidIndex_(tx);

  requested.forEach(function (decision) {
    var uid = String((decision && decision.uid) || '');
    var row = uid ? index[uid] : null;

    if (!row) {
      result.skipped++;
      result.results.push({ uid: uid, ok: false, reason: 'not in ' + TABS.TRANSACTIONS });
      return;
    }

    var wrote = [];

    if (!isBlankCell_(decision.category_override)) {
      writeCell_(tx, row, TX_COLUMNS, 'category_override', decision.category_override);
      wrote.push('category_override');
    }
    if (!isBlankCell_(decision.subcategory_override)) {
      writeCell_(tx, row, TX_COLUMNS, 'subcategory_override', decision.subcategory_override);
      wrote.push('subcategory_override');
    }
    // `!== undefined` rather than a truthiness test, because `false` is a value
    // someone deliberately sent: un-ticking is the whole point of a checkbox.
    if (decision.confirmed !== undefined && decision.confirmed !== null) {
      writeCell_(tx, row, TX_COLUMNS, 'confirmed', isTruthyCell_(decision.confirmed));
      wrote.push('confirmed');
    }

    if (!wrote.length) {
      result.skipped++;
      result.results.push({ uid: uid, ok: false, reason: 'nothing to write' });
      return;
    }

    result.written++;
    result.results.push({ uid: uid, ok: true, wrote: wrote });
  });

  return result;
}

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

/**
 * A cash transaction, typed on a phone and landing straight away.
 *
 * Appends a row to `cash_entry` and then drains it, which is exactly what
 * `onCashEntryEdit_` does when you type into the tab — the same lock, the same
 * drain, the same clear. The page is a nicer way to fill in the row, not a
 * second way to reach `transactions`.
 *
 * **The lock is taken and given up rather than waited on**, for the reason
 * `onCashEntryEdit_` gives: giving up leaves the row for the nightly sync,
 * which is about to append it anyway. But the row is written *first* and
 * outside the lock, so a failure to take it loses nothing — the entry is on the
 * tab and the sync will drain it. The page is told that plainly rather than
 * being told it failed.
 *
 * **`inserted` is not necessarily your row.** `drainCashEntries_` drains every
 * unprocessed complete row, so a row you started typing on the Sheets tab this
 * morning goes in with yours. The result says how many landed and the page must
 * not claim otherwise — the honest sentence is "2 added", not "added".
 */
function webAppAddCash_(entry) {
  var request = entry || {};
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CASH_ENTRY);
  if (!sheet) throw new Error('No "' + TABS.CASH_ENTRY + '" tab. Run Spendsheet → Setup sheet first.');

  var problem = cashEntryProblem_(request);
  if (problem) throw new Error(problem);

  // Placed by `lastFilledRow_` rather than through `appendRows_`, because that
  // one needs a key column and this tab has none: it is filled in whatever
  // order you type, which is exactly why `drainCashEntries_` reads it with
  // ANY_COLUMN. Row 2 normally holds a lone `=TODAY()` — the form row waiting
  // to be typed into — so it counts as filled and this lands below it, where
  // an incomplete row is left alone rather than overwritten.
  var at = lastFilledRow_(sheet, CASH_ENTRY_COLUMNS.length) + 1;
  sheet.getRange(at, 1, 1, CASH_ENTRY_COLUMNS.length).setValues([toRow_(CASH_ENTRY_COLUMNS, {
    date: cashEntryDate_(request.date),
    account: String(request.account),
    amount: Number(request.amount),
    category: String(request.category || ''),
    subcategory: String(request.subcategory || ''),
    note: String(request.note || ''),
    labels: String(request.labels || ''),
    processed: ''
  })]);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return { inserted: 0, queued: true,
      message: 'Saved. A sync is running, so it will land with the next one.' };
  }

  try {
    var now = new Date();
    var drained = drainCashEntries_(readExistingIndex_(sheetOrThrow_(TABS.TRANSACTIONS)), now);
    if (drained.inserted) clearDrainedCashRows_(sheet);

    return {
      inserted: drained.inserted,
      queued: drained.inserted === 0,
      message: drained.inserted
        ? drained.inserted + ' added'
        : 'Saved. It will land with the next sync.'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * What is wrong with this entry, in words, or null.
 *
 * Pure, and refuses rather than guessing. `isCompleteCashEntry` is the same
 * test the drain applies — a row without an account and an amount is someone
 * mid-typing and is left alone — but a page that silently accepted such a
 * request would leave a permanent half-row on `cash_entry` that the drain
 * politely skips for ever.
 *
 * The amount check is `isBlankCell_` before `Number`, which is the rule this
 * project has now had to write down five times: `Number('')` is 0 and
 * `isFinite(0)` is true, so a blank amount passes the obvious guard and becomes
 * a €0 transaction that happened.
 */
function cashEntryProblem_(entry) {
  var request = entry || {};

  if (isBlankCell_(request.account)) return 'Pick an account.';
  if (isBlankCell_(request.amount)) return 'Type an amount.';

  var amount = Number(request.amount);
  if (!isFinite(amount)) return 'That amount is not a number.';
  if (amount === 0) return 'A zero-euro transaction is not a transaction.';

  if (request.date !== undefined && request.date !== '' && !toDate_(request.date)) {
    return 'That date cannot be read.';
  }
  return null;
}

/**
 * The date to store, defaulting to today.
 *
 * A real `Date` rather than the `yyyy-MM-dd` string the page sends, because
 * `drainCashEntries_` copies this cell straight into `booking_date` and every
 * comparison downstream is a date comparison. A string there sorts and filters
 * as text, which is the failure that reads as "my cash entries are all at the
 * bottom" long after anyone would connect it to this line.
 */
function cashEntryDate_(value) {
  var parsed = toDate_(value);
  return parsed || new Date();
}

/**
 * The accounts a cash entry can name.
 *
 * Cash only. The whole point of this tab is money no API knows about, and
 * offering a bank account would invite typing in a transaction the sync is
 * about to fetch — a duplicate that dedup cannot catch, because a hand-typed
 * row has no `entry_reference` and a different amount key.
 *
 * Names rather than ids, because the ids are provider UUIDs and a list of
 * those is not something anyone picks a wallet from on a phone.
 * `resolveCashAccount_` is what turns the name back into an id.
 */
function cashAccountList_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  if (!sheet) return [];

  return readRecords_(sheet, ACCOUNT_COLUMNS)
    .filter(function (account) {
      return account.account_id &&
        String(account.kind || '') === ACCOUNT_KIND.CASH &&
        isTruthyCell_(account.active);
    })
    .map(function (account) { return String(account.name || account.account_id); });
}

/**
 * The taxonomy, as a phone needs it: a subcategory, its parent, and an icon.
 *
 * Flat rather than nested, because picking a subcategory names its parent on
 * its own — `Groceries` means Food & Drink — and that is the one choice the
 * whole `child_key`/`child_parent` pair on `categories` exists to make
 * possible. A nested picker would be two taps for what the data says is one.
 *
 * `categories.icon` is carried through, so the emoji beside a category costs
 * nothing and stays yours to change on the tab.
 */
function categoryChoices_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CATEGORIES);
  if (!sheet) return { parents: [], children: [] };

  var rows = readRecords_(sheet, CATEGORY_COLUMNS)
    .filter(function (row) { return row.category && row.subcategory; });

  var parents = [];
  var iconFor = {};
  rows.forEach(function (row) {
    var name = String(row.category);
    if (parents.indexOf(name) === -1) parents.push(name);
    if (!iconFor[name] && row.icon) iconFor[name] = String(row.icon);
  });

  return {
    parents: parents.map(function (name) {
      return { name: name, icon: iconFor[name] || '' };
    }),
    children: rows.map(function (row) {
      return {
        name: String(row.subcategory),
        parent: String(row.category),
        icon: String(row.icon || ''),
        kind: String(row.kind || '')
      };
    })
  };
}
