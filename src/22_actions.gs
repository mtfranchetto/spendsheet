/**
 * 22_actions.gs — the three things the app writes.
 *
 * Reading is 21_query.gs and it is careful to write nothing at all. This file
 * is the other half: confirming a guess, adding a cash transaction, and adding
 * a rule. All three existed already as spreadsheet gestures — a checkbox on
 * `review`, a row on `cash_entry`, a row on `rules` — and none of them is
 * reachable from a web page.
 *
 * The third arrived last and is the one with no existing mechanism to reuse.
 * Confirming had `writeReviewRow_`'s three rules to reproduce and cash had
 * `drainCashEntries_` to call outright; `rules` had only "type a row on the
 * tab", which is why `webAppAddRule_` carries its own validation rather than
 * borrowing any.
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
 * A decision is `{uid, confirmed?, category_override?, subcategory_override?,
 * labels?}`, and the uid is the whole of the addressing. The same choice
 * `17_review.gs` makes and for the same reason: a list on a phone re-sorts as
 * you act on it, so a position is not a thing you can send back.
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
 * **`labels` deliberately does not follow the first rule, and the difference is
 * in where the two values come from.** An override arrives from a picker whose
 * first option is "Leave as it is", so blank genuinely means untouched and
 * there is no gesture that means "clear". Labels arrive from a set of chips the
 * page rendered *holding the row's current value* — un-ticking the last one is
 * a deliberate act with an empty string as its result, and reading that as
 * "untouched" would make the labels column additive for ever. So it takes the
 * `confirmed` test instead: written when the key was supplied at all, absent
 * when it was not. `labels` never affects a total, which is what makes this the
 * safe direction to differ in; getting it wrong on `category_override` would
 * silently erase a categorisation.
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
    // Same test as `confirmed` and not the one the overrides use — see the
    // header. An empty string here is "I removed the last label", which is a
    // thing a person does and has to be able to do.
    if (decision.labels !== undefined && decision.labels !== null) {
      writeCell_(tx, row, TX_COLUMNS, 'labels', normalizeLabels_(decision.labels));
      wrote.push('labels');
    }

    /*
      The description, and **the only write here that can be refused.**

      It is also the only one that touches A–O, the half of `transactions` the
      code owns — every other cell above is an override column, which exists
      precisely so that your opinion and the bank's can both be on the row. A
      description has no override column, so changing it means changing the
      stored value.

      That is fine for a row nothing will ever fetch again and not fine for one
      a bank might: without an `entry_reference`, `computeUid` hashes the
      description, so a rewritten one can stop a future sync recognising a
      transaction it already holds. `descriptionIsEditable_` is that rule, and
      it is re-asked *here* rather than trusted from the page — the page decides
      what to show, and this decides what is true. A blank is refused too: a
      row has to say something, and "" would leave the list showing
      `(no description)` with no way back.
    */
    if (decision.description !== undefined && decision.description !== null) {
      var wanted = String(decision.description).trim();

      if (!descriptionIsEditable_(readCell_(tx, row, TX_COLUMNS, 'source'))) {
        result.skipped++;
        result.results.push({ uid: uid, ok: false,
          reason: 'that description came from your bank and is what identifies the row' });
        return;
      }
      if (!wanted) {
        result.skipped++;
        result.results.push({ uid: uid, ok: false, reason: 'a description cannot be empty' });
        return;
      }

      writeCell_(tx, row, TX_COLUMNS, 'description', wanted);
      wrote.push('description');
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

/**
 * Whatever the page sent, as the one string the `labels` column holds.
 *
 * Accepts an array — which is the shape `recordForPage_` sends *out*, so it is
 * the shape a page naturally sends back — or a string, which is what typing
 * into the tab produces. Both land as `kids, travel`, with the comma and the
 * space, because `splitLabels_` is what reads this column: it splits on commas
 * and trims the parts, and a value written any other way filters correctly by
 * luck rather than by construction.
 *
 * Blanks dropped and duplicates removed, because both are reachable by
 * accident: un-ticking every chip yields `['']` if you are not careful, which
 * would write a lone comma, and a label that is already on the row and also in
 * the known set would otherwise be stored twice. `indexOf` rather than a lookup
 * object on purpose — a label called `constructor` is a perfectly ordinary
 * thing to type, and it is truthy on every plain object in JavaScript.
 */
function normalizeLabels_(value) {
  var parts = Array.isArray(value) ? value : splitLabels_(value);
  var kept = [];

  parts.forEach(function (part) {
    var label = String(part == null ? '' : part).trim();
    if (label && kept.indexOf(label) === -1) kept.push(label);
  });

  return kept.join(', ');
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

/**
 * What the page sends when a transfer went somewhere this book does not track.
 *
 * A sentinel rather than a blank, because blank is what an unanswered form
 * field looks like and the two mean opposite things: "I have not said where
 * this went" must not silently become "it left my accounts".
 */
var TRANSFER_OUTSIDE = '__outside__';

/**
 * Mark a transaction as a transfer, and say where the money went.
 *
 * ## The bug this exists to fix
 *
 * A cash withdrawal is **one row**. The bank debits you €100; nothing credits
 * your wallet, because a wallet has no API to report with. Marking it
 * `Transfer` — which the seed rules already do for `PRELIEVO` — keeps it out of
 * spending, correctly, and leaves the arithmetic wrong in a way nothing shows
 * you: `accountBalanceFormula` sums transactions per account, so the wallet
 * never gains the €100, and net worth drops by money that is in your pocket.
 *
 * So a transfer needs a destination, and a destination means writing the leg
 * the bank never will.
 *
 * ## Only untracked-by-API accounts may be a destination
 *
 * `cash` and `asset` only — never `bank`. A bank destination reports its own
 * credit on its own next sync, and `detectTransfers_` pairs the two by amount
 * and date without help. Writing a leg there would double the money: one row
 * from us, one from the bank, and dedup cannot catch it because ours has no
 * `entry_reference` and a different uid by construction. Refused rather than
 * quietly skipped — a destination you picked and that did nothing is worse
 * than being told it is not on the list.
 *
 * ## `TRANSFER_OUTSIDE` writes no leg, deliberately
 *
 * Money moved to an account this book does not follow: another bank, someone
 * else's. There is nothing to credit, so this only excludes the row from
 * spending, which is what marking a transfer has always done. Worth being clear
 * that net worth **does** fall in that case, and correctly — net worth here is
 * the sum of accounts you track, and the money has left them.
 *
 * ## Idempotent by uid
 *
 * The leg's uid is a hash of the source uid and the destination, so marking the
 * same row twice finds the leg already there and writes nothing. Without that,
 * a double tap on a slow connection credits your wallet twice.
 */
function webAppLinkTransfer_(request) {
  var want = request || {};
  var uid = String(want.uid || '');
  var destination = String(want.destination || '');

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  if (!tx) throw new Error('No "' + TABS.TRANSACTIONS + '" tab. Run Spendsheet → Setup sheet first.');
  if (!uid) throw new Error('No transaction to mark.');
  if (!destination) throw new Error('Say where the money went.');

  var index = uidIndex_(tx);
  var row = index[uid];
  if (!row) throw new Error('That transaction is no longer in ' + TABS.TRANSACTIONS + '.');

  var source = readRecords_(tx, TX_COLUMNS).filter(function (record) {
    return String(record.uid) === uid;
  })[0];
  if (!source) throw new Error('That transaction is no longer in ' + TABS.TRANSACTIONS + '.');

  var outside = destination === TRANSFER_OUTSIDE;
  var target = outside ? null : transferDestination_(destination);

  if (!outside && !target) {
    throw new Error('"' + destination + '" is not an account this can move money into. ' +
      'Only cash and asset accounts, because a bank reports its own side.');
  }
  if (target && String(target.account_id) === String(source.account_id)) {
    throw new Error('That is the same account the transaction is already on.');
  }

  // The category is how this book stores transfer-ness — `type` is a formula
  // over it — so this is the same write `applyReviewDecisions_` would make.
  writeCell_(tx, row, TX_COLUMNS, 'category_override', TRANSFER_CATEGORY_NAME);
  writeCell_(tx, row, TX_COLUMNS, 'subcategory_override',
    transferSubcategoryFor_(target, source));
  writeCell_(tx, row, TX_COLUMNS, 'confirmed', true);

  // Labels, when the page sent them — which it does whenever the sheet was
  // open, because the chips always show the row's current set.
  //
  // The alternative was two round trips, `appConfirm` for the labels and then
  // this. At ~2,700ms of fixed overhead each that is a five-second wait to save
  // the word `travel`, and the sheet closes between them so a failure on the
  // second has nothing left to report against. The same rule as
  // `applyReviewDecisions_`: present-and-empty is a deliberate clear, absent is
  // untouched — which is why this tests the key rather than the value.
  if (want.labels !== undefined && want.labels !== null) {
    writeCell_(tx, row, TX_COLUMNS, 'labels', normalizeLabels_(want.labels));
  }

  // Same rule as `applyReviewDecisions_`, asked here rather than shared through
  // it, because these are two entry points and only one of them can be reached
  // per press. A synced row is refused outright: this one has no per-field
  // result to report a partial failure through, so it fails the whole call
  // rather than marking the transfer and silently dropping the rename.
  if (want.description !== undefined && want.description !== null) {
    var renamed = String(want.description).trim();
    if (!renamed) throw new Error('A description cannot be empty.');
    if (!descriptionIsEditable_(source.source)) {
      throw new Error('That description came from your bank and is what identifies the row.');
    }
    writeCell_(tx, row, TX_COLUMNS, 'description', renamed);
  }

  if (!target) {
    return { linked: false, outside: true,
      message: 'Marked as a transfer out of your tracked accounts.' };
  }

  var legUid = transferLegUid_(uid, target.account_id);
  if (index[legUid]) {
    return { linked: false, already: true,
      message: 'That transfer was already recorded on ' + target.name + '.' };
  }

  var amount = -Number(source.amount);
  var written = appendRows_(tx, 1, [toRow_(TX_COLUMNS_CODE, {
    uid: legUid,
    account_id: target.account_id,
    account_name: target.name,
    booking_date: source.booking_date,
    value_date: source.value_date || source.booking_date,
    transaction_date: source.transaction_date || source.booking_date,
    amount: amount,
    currency: source.currency,
    description: (amount > 0 ? 'Transfer from ' : 'Transfer to ') +
      String(source.account_name || ''),
    counterparty: String(source.account_name || ''),
    entry_reference: '',
    bank_transaction_code: '',
    mcc: '',
    source: TX_SOURCE_TRANSFER_LEG,
    imported_at: new Date()
  })]);

  // The leg is a transfer too, or it lands in your spending as income.
  writeCell_(tx, written.row, TX_COLUMNS, 'category_override', TRANSFER_CATEGORY_NAME);
  writeCell_(tx, written.row, TX_COLUMNS, 'subcategory_override',
    transferSubcategoryFor_(target, source));
  writeCell_(tx, written.row, TX_COLUMNS, 'confirmed', true);

  // Both sides carry the group now rather than waiting for the next sync.
  // `detectTransfers_` would derive exactly this pair on its own — same amount,
  // opposite sign, different accounts, same day — and it computes the id from
  // the *debit's* uid, so this matches what the re-run will write rather than
  // being overwritten by it.
  var group = 'tr:' + (Number(source.amount) < 0 ? uid : legUid);
  writeCell_(tx, row, TX_COLUMNS, 'transfer_group', group);
  writeCell_(tx, written.row, TX_COLUMNS, 'transfer_group', group);

  return {
    linked: true,
    account: target.name,
    amount: amount,
    message: (amount > 0 ? 'Added ' : 'Took ') + Math.abs(amount).toFixed(2) +
      (amount > 0 ? ' to ' : ' from ') + target.name + '.'
  };
}

/** The category name transfer-ness is stored as. Must exist on `categories`. */
var TRANSFER_CATEGORY_NAME = 'Transfer';

/**
 * An account money can actually be moved *into*, by name — or null.
 *
 * Cash and asset only, and the reason is dedup rather than taxonomy: a bank
 * account reports its own side of the transfer on its next sync, and a leg
 * written here would be a second copy of it that nothing can match.
 */
function transferDestination_(name) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  if (!sheet) return null;

  return readRecords_(sheet, ACCOUNT_COLUMNS).filter(function (account) {
    return account.account_id &&
      isTruthyCell_(account.active) &&
      String(account.name || '') === String(name) &&
      (String(account.kind) === ACCOUNT_KIND.CASH ||
       String(account.kind) === ACCOUNT_KIND.ASSET);
  })[0] || null;
}

/**
 * `Cash withdrawal` when cash is involved, `Between accounts` otherwise.
 *
 * Both are seeded subcategories of `Transfer`, so both resolve to `kind:
 * transfer` and neither counts anywhere. The distinction is only for reading
 * the ledger later — and it matches what the seed rules already write for
 * `PRELIEVO` and MCC 6011, so a withdrawal the cascade found and one you
 * marked by hand are filed identically.
 */
function transferSubcategoryFor_(target, source) {
  if (target && String(target.kind) === ACCOUNT_KIND.CASH && Number(source.amount) < 0) {
    return 'Cash withdrawal';
  }
  return 'Between accounts';
}

/**
 * The leg's uid: a hash of what it is a leg *of*.
 *
 * Deterministic on purpose — it is the whole of the idempotency. Marking the
 * same row twice computes the same uid, finds it in the index, and writes
 * nothing; without it, a double tap on a slow connection credits the wallet
 * twice and there is no later signal that it happened.
 */
function transferLegUid_(sourceUid, destinationId) {
  return sha256Hex([TX_SOURCE_TRANSFER_LEG, sourceUid, String(destinationId)]
    .join(UID_SEPARATOR));
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * Append one row to `rules`, built from a transaction you were looking at.
 *
 * `rules` is the user-owned escape hatch — `14_categorize.gs` says so plainly:
 * a categorisation you want to *impose* goes here, because this tab is never
 * rewritten, where `_memory` is derived and rebuilt wholesale on every run. Up
 * to now the only way to add one was to type a row on the tab, which is not a
 * thing anyone does standing in a shop having just seen the same merchant
 * miscategorised for the fourth time. That is the gesture this exists for.
 *
 * **Placed with `lastFilledRow_` rather than `appendRows_`.** That helper wants
 * a key column to find the last *record*, and `rules` has none — `priority` is
 * column A and repeats freely. The tab also carries no ARRAYFORMULA, so the
 * `getLastRow()` trap `appendRows_` exists to dodge does not apply here. Same
 * placement `webAppAddCash_` uses on `cash_entry`, for the same reasons.
 *
 * **Everything is validated against the enums rather than trusted.** This is
 * reached from a browser, and the failure mode of a bad `field` or `match_type`
 * is silence: `ruleField_` returns null for a name it does not know and
 * `matchesPattern_` returns false for a match type it does not know, so the
 * rule sits on the tab looking correct and matching nothing, for ever.
 *
 * A new rule **does not recategorise anything already in the book.** The
 * cascade runs on sync, and `frozenVerdict_` holds a confirmed row to what it
 * was confirmed with. The caller has to say so — see `appAddRule`.
 */
function webAppAddRule_(rule) {
  var request = rule || {};
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.RULES);
  if (!sheet) throw new Error('No "' + TABS.RULES + '" tab. Run Spendsheet → Setup sheet first.');

  var problem = ruleProblem_(request, sheet);
  if (problem) throw new Error(problem);

  var at = lastFilledRow_(sheet, RULE_COLUMNS.length) + 1;
  var priority = nextRulePriority_(sheet);

  sheet.getRange(at, 1, 1, RULE_COLUMNS.length).setValues([toRow_(RULE_COLUMNS, {
    priority: priority,
    field: String(request.field),
    match_type: String(request.match_type),
    pattern: String(request.pattern).trim(),
    account_filter: String(request.account_filter || ''),
    category: String(request.category),
    subcategory: String(request.subcategory || ''),
    // Not read by the cascade — a row's type comes from its category's `kind`
    // — but the column exists and a blank in it reads as an unfinished row.
    type: String(request.type || ''),
    enabled: true
  })]);

  return { added: true, row: at, priority: priority };
}

/**
 * What is wrong with this rule, in words, or null.
 *
 * The category is checked against the `categories` tab rather than merely for
 * being non-blank, because a rule naming a category that does not exist is the
 * quietest failure available: it matches, it writes a category, `typeFormula`'s
 * VLOOKUP finds nothing, `type` comes back empty and `in_reports` excludes the
 * row from every report without saying why.
 */
function ruleProblem_(rule, sheet) {
  var request = rule || {};

  if (isBlankCell_(request.pattern)) return 'Type something for the rule to match.';
  if (String(request.pattern).trim().length < 2) {
    return 'That pattern is too short to be a rule.';
  }
  if (RULE_FIELDS.indexOf(String(request.field)) === -1) {
    return 'A rule can only match on ' + RULE_FIELDS.join(', ') + '.';
  }
  if (RULE_MATCH_TYPES.indexOf(String(request.match_type)) === -1) {
    return 'A rule can only match by ' + RULE_MATCH_TYPES.join(', ') + '.';
  }
  if (isBlankCell_(request.category)) return 'Pick a category for the rule to set.';

  var known = categoryChoices_();
  var parents = known.parents.map(function (entry) { return entry.name; });
  if (parents.indexOf(String(request.category)) === -1) {
    return 'There is no category called "' + request.category + '".';
  }
  if (!isBlankCell_(request.subcategory)) {
    var fits = known.children.some(function (entry) {
      return entry.name === String(request.subcategory) &&
        entry.parent === String(request.category);
    });
    if (!fits) {
      return '"' + request.subcategory + '" is not under ' + request.category + '.';
    }
  }

  // A regex that will not compile matches nothing, silently, for ever.
  if (String(request.match_type) === 'regex') {
    try {
      new RegExp(String(request.pattern));
    } catch (e) {
      return 'That is not a pattern this can read: ' + e.message;
    }
  }
  return null;
}

/**
 * One step past the highest priority on the tab.
 *
 * Rules are sorted ascending and the first match wins, so a rule added from the
 * app goes **last** — it is a correction to what the seed rules already do, and
 * the seed is what it is correcting. Ten at a time so there is room to slot one
 * in by hand between two of them without renumbering.
 */
function nextRulePriority_(sheet) {
  var highest = 0;
  readRecords_(sheet, RULE_COLUMNS, ANY_COLUMN).forEach(function (row) {
    var value = Number(row.priority);
    if (isFinite(value) && value > highest) highest = value;
  });
  return highest + 10;
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

  var problem = cashEntryProblem_(request) || unknownCategoryProblem_(request);
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
 * A category this book does not have, named in words rather than accepted.
 *
 * Separate from `cashEntryProblem_` so that one can stay pure — it is the test
 * the drain applies and it reads no tab. This one has to read `categories`,
 * which is exactly why it is worth having: an entry naming a category that is
 * not there does not fail. It is stored, `category_override` holds a name the
 * `type` VLOOKUP cannot resolve, `type` comes back blank, and the row lands in
 * the ledger belonging to nothing.
 *
 * **The case this was written for is a book that has not had `setup()` run
 * since the category was added.** Every category the page offers comes from
 * `categoryChoices_` and is real by construction — except the two the "Update
 * balance" screen names as literals, because it is *stating* what an asset
 * revaluation is rather than asking. A book missing `Transfer › Valuation
 * change` therefore took the write, reported success, and moved no balance:
 * the transaction was there, and nothing that adds up an account counted it.
 * Silent, plausible, and indistinguishable from the app being broken.
 *
 * A blank category is not unknown. `renderAdd` offers "Uncategorised" and the
 * cascade is what fills those in — refusing them would be refusing the default.
 */
function unknownCategoryProblem_(entry) {
  var request = entry || {};
  var category = String(request.category || '').trim();
  var subcategory = String(request.subcategory || '').trim();
  if (!category && !subcategory) return null;

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CATEGORIES);
  if (!sheet) return null;

  var rows = readRecords_(sheet, CATEGORY_COLUMNS);
  var missing = function (want, column) {
    if (!want) return false;
    return !rows.some(function (row) { return String(row[column] || '').trim() === want; });
  };

  if (missing(category, 'category') || missing(subcategory, 'subcategory')) {
    return 'This book has no "' + (missing(category, 'category') ? category : subcategory) +
      '" category. Run Spendsheet → Setup sheet to add the ones that ship with it.';
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
 * The accounts whose value you set rather than sync — with the value.
 *
 * The balance comes too, which is the difference between this and
 * `cashAccountList_`. Setting an asset's value is a *difference* — you type
 * 14,500 where it said 13,000 and a €1,500 transaction is written — so the
 * screen has to know what it currently says before you can answer. Sending it
 * with the list rather than fetching it per account keeps that screen at zero
 * round trips, which on this platform is ~2,700ms each.
 *
 * `cashEntryProblem_` never checks an account's kind and `resolveCashAccount_`
 * resolves any name, so the write path needs no change at all: an asset
 * adjustment goes through `webAppAddCash_` exactly as a cash entry does. This
 * list exists to decide what the *app* offers, not what the server accepts.
 */
function assetAccountList_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  if (!sheet) return [];

  return readRecords_(sheet, ACCOUNT_COLUMNS)
    .filter(function (account) {
      return account.account_id &&
        String(account.kind || '') === ACCOUNT_KIND.ASSET &&
        isTruthyCell_(account.active);
    })
    .map(function (account) {
      return {
        name: String(account.name || account.account_id),
        balance: cellNumber_(account.balance),
        currency: String(account.currency || '')
      };
    });
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
 *
 * So is `kind`, on both halves, and that is what lets the page stop offering
 * `Groceries` on a salary. It was already on `children` and not on `parents`,
 * which is the sort of asymmetry that reads as deliberate and was not: the two
 * lists feed the same two pickers in the same sheet.
 *
 * A parent's kind is taken from its **first** row, because `kind` describes the
 * parent — `typeFormula()` resolves a transaction's type by looking the parent
 * up in `categories!A:C`, so a parent whose children disagreed would already be
 * resolving to whichever row `VLOOKUP` reached first. Reading the first row
 * here means the page and the formula are wrong in the same direction, which is
 * the only kind of agreement available without validating the tab.
 */
function categoryChoices_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.CATEGORIES);
  if (!sheet) return { parents: [], children: [] };

  var rows = readRecords_(sheet, CATEGORY_COLUMNS)
    .filter(function (row) { return row.category && row.subcategory; });

  var parents = [];
  var iconFor = {};
  var kindFor = {};
  rows.forEach(function (row) {
    var name = String(row.category);
    if (parents.indexOf(name) === -1) parents.push(name);
    if (!iconFor[name] && row.icon) iconFor[name] = String(row.icon);
    if (!kindFor[name] && row.kind) kindFor[name] = String(row.kind);
  });

  return {
    parents: parents.map(function (name) {
      return { name: name, icon: iconFor[name] || '', kind: kindFor[name] || '' };
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
