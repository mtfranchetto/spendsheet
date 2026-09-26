/**
 * 15_duplicates.gs — one transaction, two rows, two sources.
 *
 * This is the cleanup for an overlap that already landed. The cutoff in
 * `_import_staged` stops an import restaging what the API already holds; it
 * cannot stop the reverse, and the reverse is the one that happens. Import a
 * history for an account the sync has not reached yet — a bank connected this
 * week, say — and every row is legitimately staged, because at that moment
 * there is nothing to be older than. The next nightly run then fetches its
 * ninety-day window and writes a second copy of every transaction the two
 * overlap on, under a hash uid that shares nothing with `csv:...#4332`.
 *
 * 09_sync suppresses that at the source *when the two rows agree on the day*,
 * so most of what follows is for the copies made before it did. The rest is for
 * the pairs it cannot see at all — see `pairNear_`.
 *
 * It lives apart from 13_import because that file is about reading an export:
 * the `_import_staged` formula builders and the commit. Duplicates would be a
 * third kind of thing in it, and the split is cheaper than the file. Nothing
 * here is reachable from a browser and nothing here runs unattended — every
 * entry point is a menu item that asks first.
 *
 * ## What is removed, and why it is not the obvious one
 *
 * **The imported row goes and the synced one stays.** That is the opposite of
 * what this file did when it was written, and the old argument was not wrong so
 * much as incomplete: an imported row carries the category you gave it in the
 * tool it came from, the tick that says you meant it, and its labels, while the
 * fetched row carries an `entry_reference` nothing downstream reads. All true.
 * What it left out is that only one of the two **regenerates**. A synced row
 * deleted inside `sync_window_days` is fetched again on the next run, under the
 * same uid, and for a near pair nothing suppresses it — so the deletion quietly
 * undoes itself and the duplicate is back by morning with nothing to say it
 * ever went. An import is a thing you do by hand; it does not come back on its
 * own.
 *
 * So the old argument is honoured by *copying* rather than by keeping: the
 * imported row's `category_override`, `subcategory_override`, `labels` and
 * `notes` are written onto the surviving synced row wherever that row is blank,
 * and then the imported row goes. Nothing you typed is lost, nothing you typed
 * is overwritten, and the survivor is the row the bank will keep agreeing with.
 *
 * One rule for both passes. A pair whose resolution depended on which pass
 * found it would be a rule nobody could hold in their head, and the two passes
 * differ only in how far apart the dates were allowed to be.
 *
 * `transactions` is append-only everywhere else in this project, and this is
 * the single exception. Every row it removes is copied to `_removed` first, it
 * refuses to touch row 2, and it re-baselines the row-loss detector afterwards
 * — which would otherwise block every future sync, correctly, having watched
 * the tab shrink.
 *
 * The copy goes to a tab rather than to Drive. `snapshotToDrive` was the
 * obvious choice and it is the wrong one: it reaches outside the book, for a
 * folder and then for a file, and everything out there can refuse. It did
 * refuse — for want of a Drive scope, on every run, for months — and had this
 * deletion leaned on it, an undo the user was promised would have been gone
 * with it. A tab in the same spreadsheet needs no scope at all, cannot fail for
 * a reason outside the sheet, and is a better artefact besides: the rows are
 * right there to read, and putting one back is a paste.
 */

/** How many near pairs the confirmation lists one by one before it gives up. */
var DUPLICATE_LIST_CAP = 25;

/** The columns copied from the imported row onto the survivor, blanks only. */
var DUPLICATE_MERGE_COLUMNS = ['category_override', 'subcategory_override', 'labels', 'notes'];

function removeSyncedDuplicates() {
  requireInteractive_();
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plan = planSyncedDuplicates_();

  if (plan.error) {
    ui.alert('Remove synced duplicates', plan.error, ui.ButtonSet.OK);
    return plan;
  }

  var answer = ui.alert('Remove synced duplicates', describeSyncedDuplicates_(plan), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    ss.toast('Nothing was removed.', 'Cancelled', 5);
    return plan;
  }

  var result = commitSyncedDuplicates_(plan);
  ss.toast(result.removed + ' rows removed, and copied to ' + TABS.REMOVED + ' first.',
    'Duplicates removed', 20);
  return result;
}

/**
 * Which imported rows duplicate a synced one.
 *
 * Two passes over one read, and the second only ever sees what the first did
 * not pair. Splitting them matters for more than tidiness: pass one is the same
 * rule the nightly sync applies, so anything it finds is an overlap the sync
 * would have suppressed had it run first, and anything pass two finds is a pair
 * the sync **cannot** see and will go on re-creating. The confirmation says so,
 * because they are different news.
 */
function planSyncedDuplicates_() {
  var tx = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.TRANSACTIONS);
  if (!tx) return { error: 'No ' + TABS.TRANSACTIONS + ' tab. Run Setup sheet first.' };

  var records = readRecords_(tx, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'));
  var imported = records.filter(function (row) { return isImportedSource_(row.source); });

  if (!imported.length) {
    return { error: 'Nothing here came from an import, so nothing can be a duplicate of one.' };
  }

  var fetched = records.filter(function (row) { return row.source === TX_SOURCE_API; });
  var found = pairAcrossSources_(imported, fetched,
    configNumber_(readConfig_(), 'duplicate_window_days'));
  var pairs = found.exact.concat(found.near);

  if (!pairs.length) {
    return {
      error: 'No imported row pairs with a synced one on account and amount, within ' +
        configNumber_(readConfig_(), 'duplicate_window_days') + ' days.\n\n' +
        records.length + ' rows checked — ' + imported.length + ' imported, ' +
        fetched.length + ' synced.'
    };
  }

  var doomed = pairs.map(function (pair) { return pair.imported; });

  return {
    sheet: tx,
    pairs: pairs,
    exact: found.exact,
    near: found.near,
    rows: doomed,
    total: records.length,
    imported: imported.length,
    fetched: fetched.length,
    accounts: countStagedBy_(doomed, 'account_name'),
    range: stagedDateRange_(doomed),
    protectsAnchor: doomed.some(function (row) { return row._row <= 2; })
  };
}

/**
 * Pair imported rows with synced ones. **Only ever across the two sources.**
 *
 * That constraint is not a detail of the implementation, it is what makes the
 * second pass safe at all. 08_dedup rejects a date window on the grounds that
 * it "would make every recurring €50 withdrawal a candidate for every other
 * one" — and it is right, about a window applied to one source's own history.
 * Two genuine €120 withdrawals a day apart are both *synced*; they are never
 * offered to each other here, because one side of every pair has to be a `csv:`
 * row and the other has to be `enablebanking`. A `manual` row or a
 * `transfer-leg` this project wrote for you is neither, and pairs with nothing.
 *
 * Returns `{exact, near}` rather than one list, because the two carry different
 * news — see `planSyncedDuplicates_`.
 */
function pairAcrossSources_(imported, fetched, windowDays) {
  var exact = pairExact_(imported, fetched);
  var near = pairNear_(exact.importedLeft, exact.fetchedLeft, windowDays);
  return { exact: exact.pairs, near: near };
}

/**
 * Pass one: account, booking date and amount, all three exact.
 *
 * The same rule as `partitionByImport`, and it has to stay the same rule — a
 * cleanup that disagreed with the suppression would undo what tonight's sync
 * is about to do. It is written here as a queue rather than as a count because
 * the pairing now has to be *named*: the survivor inherits the other row's
 * category and labels, so knowing that some imported row matched is no longer
 * enough. Shifting a queue consumes exactly what decrementing a count consumed,
 * so two imported €12 lunches on one day still account for two fetched ones and
 * a third stays.
 *
 * Fetched rows are walked in sheet order, so the *earliest* copy is the one
 * paired when a row somehow arrived three times.
 */
function pairExact_(imported, fetched) {
  var queues = {};
  var keyless = [];

  imported.forEach(function (row) {
    var key = crossSourceKey(row);
    if (!key) return keyless.push(row);
    if (!queues[key]) queues[key] = [];
    queues[key].push(row);
  });

  var pairs = [];
  var fetchedLeft = [];

  fetched.forEach(function (row) {
    var key = crossSourceKey(row);
    var queue = key ? queues[key] : null;
    if (queue && queue.length) {
      pairs.push({ kind: 'exact', gap: 0, imported: queue.shift(), synced: row });
      return;
    }
    fetchedLeft.push(row);
  });

  var importedLeft = keyless.slice();
  Object.keys(queues).forEach(function (key) {
    queues[key].forEach(function (row) { importedLeft.push(row); });
  });

  return { pairs: pairs, importedLeft: importedLeft, fetchedLeft: fetchedLeft };
}

/**
 * Pass two: the same account and the same amount, a few days apart.
 *
 * The date is the only thing relaxed, and it is relaxed because the exports
 * this was written against turned out not to agree with the bank after all.
 * BudgetBakers recorded an Amazon refund on the day it appeared and the bank
 * booked it the next morning — one day, and the two rows had nothing else
 * between them: same account, same €24.08, the same description verbatim.
 * 08_dedup's "the exports seen here agree with the bank to the day" was true of
 * the exports seen at the time and is not a property of exports.
 *
 * Ranking, in order: the smallest day gap, then how well the descriptions
 * agree, then sheet order. Description is a tiebreak and never a requirement —
 * an export says `Esselunga` where the bank says `PAGAMENTO POS 12/07 ESSELUNGA
 * SPA TORINO`, so requiring agreement would match nothing, which is the failure
 * 13_import predicted for cross-source matching generally. It earns its place
 * only where two candidates are otherwise indistinguishable.
 *
 * Each row on each side pairs at most once, as in pass one, and for the same
 * reason: three fetched €4 fares meeting two imported ones must leave one.
 */
function pairNear_(imported, fetched, windowDays) {
  var span = isFinite(windowDays) && windowDays > 0 ? windowDays : 0;
  if (!span) return [];

  var buckets = {};
  imported.forEach(function (row) {
    var key = duplicateAmountKey_(row);
    if (!key) return;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(row);
  });

  var pairs = [];

  fetched.forEach(function (row) {
    var key = duplicateAmountKey_(row);
    var candidates = key ? buckets[key] : null;
    if (!candidates || !candidates.length) return;

    var day = dupDayNumber_(row.booking_date);
    if (day === null) return;

    var bestAt = -1;
    var best = null;

    candidates.forEach(function (candidate, at) {
      var otherDay = dupDayNumber_(candidate.booking_date);
      if (otherDay === null) return;

      var gap = Math.abs(otherDay - day);
      if (gap > span) return;

      var score = { gap: gap, affinity: descriptionAffinity_(candidate.description, row.description) };
      if (best && !(score.gap < best.gap ||
        (score.gap === best.gap && score.affinity < best.affinity))) return;

      best = score;
      bestAt = at;
    });

    if (bestAt === -1) return;
    pairs.push({
      kind: 'near',
      gap: best.gap,
      imported: candidates.splice(bestAt, 1)[0],
      synced: row
    });
  });

  return pairs;
}

/**
 * Account and amount, without the date — pass two's bucket.
 *
 * `''` when either part is missing, exactly as `crossSourceKey` does and for
 * the identical reason: a row with no readable amount would otherwise bucket
 * with every other unreadable row on the account, and a pairing decided by
 * knowing nothing about either side is worse than no pairing.
 */
function duplicateAmountKey_(record) {
  var account = String(record.account_id === null || record.account_id === undefined
    ? '' : record.account_id);
  var amount = amountKey(record.amount);

  if (!account || !amount) return '';
  return [account, amount].join(UID_SEPARATOR);
}

/** Days since the epoch, or null. Local terms, via `dateKey`. */
function dupDayNumber_(value) {
  var key = dateKey(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;

  var parts = key.split('-');
  return Math.round(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])) / 86400000);
}

/**
 * How well two descriptions agree, smaller being better. Only ever a tiebreak.
 *
 * Three levels rather than a similarity score: identical, one contains the
 * other, neither. Containment is the level that matters, because it is the
 * shape the disagreement actually takes across sources — an export keeps the
 * merchant and the bank wraps it in POS noise. A blank on either side scores
 * the same as no agreement rather than disqualifying: plenty of rows have no
 * description, and their date and amount still say what they say.
 */
function descriptionAffinity_(a, b) {
  var left = normalizeDescription(a);
  var right = normalizeDescription(b);

  if (!left || !right) return 2;
  if (left === right) return 0;
  if (left.indexOf(right) !== -1 || right.indexOf(left) !== -1) return 1;
  return 2;
}

/**
 * The confirmation text.
 *
 * Exact pairs are a count and a breakdown: they are the overlap the sync would
 * have suppressed itself, there are usually hundreds, and reading them one by
 * one tells you nothing a total does not. Near pairs are listed **line by
 * line**, because a pair the machine had to relax a rule to find is one you
 * should look at before agreeing to it — and because there are rarely many.
 */
function describeSyncedDuplicates_(plan) {
  var lines = ['Remove ' + plan.rows.length + ' imported rows from ' + TABS.TRANSACTIONS + '.'];

  if (plan.range) {
    lines.push('Dates ' + dateKey(plan.range.from) + ' to ' + dateKey(plan.range.to) + '.');
  }

  lines.push('');
  Object.keys(plan.accounts).sort().forEach(function (name) {
    lines.push('  ' + name + ': ' + plan.accounts[name]);
  });

  lines.push('');
  lines.push('Each pairs with a synced row on account and amount. The synced row stays — ' +
    'it is the one the bank keeps sending, so removing it only lasts until the next ' +
    'sync — and it inherits the category, subcategory, labels and notes of the ' +
    'imported row wherever it has none of its own.');

  if (plan.exact.length) {
    lines.push('');
    lines.push(plan.exact.length + ' agree on the day. Those are the ordinary overlap: ' +
      'tonight’s sync would have suppressed them itself.');
  }

  if (plan.near.length) {
    lines.push('');
    lines.push(plan.near.length + ' are a few days apart, which the sync cannot see and will ' +
      'go on re-creating. Read these:');
    describeNearPairs_(plan.near).forEach(function (line) { lines.push(line); });
  }

  // A quarter of the sheet is not an overlap, it is a match that has gone
  // wrong, and the moment to notice is before the deletion rather than in a
  // total next month. Not a refusal: a genuinely double-imported history would
  // look exactly like this and would genuinely need clearing.
  if (plan.rows.length > plan.total / 4) {
    lines.push('');
    lines.push('⚠ That is ' + Math.round(100 * plan.rows.length / plan.total) + '% of the tab. ' +
      'Check a few of them before saying yes — an overlap is usually one sync window.');
  }

  lines.push('');
  lines.push('Every row is copied to ' + TABS.REMOVED + ' before it goes, with the same ' +
    'columns as ' + TABS.TRANSACTIONS + ' — so putting one back is a paste.');
  lines.push('');
  lines.push('Continue?');
  return lines.join('\n');
}

/**
 * One line per near pair: the gap, both dates, the amount, both descriptions.
 *
 * Capped, and the cap says so rather than trailing off. A dialog listing four
 * hundred pairs is a dialog nobody reads to the end, and one that silently
 * showed the first twenty-five would be worse than the count alone — you would
 * believe you had seen them all.
 */
function describeNearPairs_(pairs) {
  var lines = pairs.slice(0, DUPLICATE_LIST_CAP).map(function (pair) {
    return '  ' + pair.gap + 'd  ' +
      dateKey(pair.imported.booking_date) + ' → ' + dateKey(pair.synced.booking_date) + '  ' +
      amountKey(pair.imported.amount) + '  ' +
      shortenForDialog_(pair.imported.description) + ' / ' +
      shortenForDialog_(pair.synced.description);
  });

  if (pairs.length > DUPLICATE_LIST_CAP) {
    lines.push('  … and ' + (pairs.length - DUPLICATE_LIST_CAP) + ' more, not shown.');
  }
  return lines;
}

function shortenForDialog_(text) {
  var value = String(text === null || text === undefined ? '' : text).trim();
  if (!value) return '(no description)';
  return value.length > 40 ? value.slice(0, 39) + '…' : value;
}

/**
 * Merge, copy, delete — and in that order, because the last one renumbers.
 *
 * The merge writes to the surviving rows by row number, and deleting anything
 * above one of them moves it. Doing the merge first also means the one failure
 * that can strand this halfway leaves the *safe* half done: categories copied
 * onto rows whose duplicates are still there, which is visible and repairable,
 * rather than deletions whose inherited categories never arrived.
 *
 * Deletion is bottom-up, in contiguous runs. Bottom-up because deleting a row
 * renumbers everything under it, so working downwards would make every row
 * number after the first one wrong — the same failure as deleting from a list
 * while iterating it. Runs because one `deleteRows(start, n)` is one operation
 * against Sheets and a few hundred single-row deletes is a few hundred
 * round-trips.
 *
 * Row 2 is where every ARRAYFORMULA in P onward is anchored. Deleting it does
 * not move the formula, it destroys it, and the tab loses `amount_base` and
 * every category column at once — so this refuses rather than repairs.
 */
function commitSyncedDuplicates_(plan) {
  if (plan.protectsAnchor) {
    throw new Error('Refusing: row 2 is one of the duplicates, and it anchors every ' +
      'ARRAYFORMULA in ' + TABS.TRANSACTIONS + '. Delete that one row by hand, then ' +
      're-run this.');
  }

  var merged = mergeIntoSurvivors_(plan.sheet, plan.pairs);

  // Kept before anything is deleted, and appended rather than cleared, so a
  // second run does not overwrite the evidence from the first.
  var kept = appendRows_(sheetOrThrow_(TABS.REMOVED), 1,
    plan.rows.map(function (record) { return toRow_(TX_COLUMNS, record); }));

  var rows = plan.rows.map(function (row) { return row._row; })
    .sort(function (a, b) { return b - a; });

  var removed = 0;
  runsOfRows_(rows).forEach(function (run) {
    plan.sheet.deleteRows(run.start, run.count);
    removed += run.count;
  });

  // The row-loss detector has just watched the tab shrink, which it is right
  // to treat as a catastrophe — it would block every sync from here on. This
  // is the one shrink that was asked for, so the baseline moves with it.
  rememberRowCount_();

  return { removed: removed, merged: merged, kept: kept.count, keptAt: kept.row, plan: plan };
}

/**
 * Which overrides on a synced row this merge copied there: `{uid: {column: true}}`.
 *
 * Memory needs to know, and the row cannot say. A correction you typed decides
 * its merchant outright, and an imported category only votes (`deriveMemory_`)
 * — but the merge writes the imported category onto a row whose `source` is the
 * bank's, so by its source alone it reads as a correction. After an import that
 * overlapped ninety days of syncing, the most recent imported filing of every
 * merchant would decide it, or turn a merchant you had corrected since into a
 * mixed one that your old history outvotes.
 *
 * Nothing was recorded at the time, and a record kept from now on would miss
 * every book already merged. `_removed` holds the imported rows the merge
 * deleted, so the pairs are found again with the pairing that made them, and a
 * survivor's override is inherited where it equals its removed partner's.
 * Only synced rows carrying an override are offered — a merged survivor always
 * does, and a neighbour with the same amount that has none cannot take the pair
 * from it. A value you happened to type identically to the import reads as
 * inherited, which costs a vote rather than a decision: the safe direction.
 *
 * Pure. 14_categorize calls it, which is a lower file reaching a higher one at
 * run time — the only way to keep the pairing rule in the one place that owns
 * it rather than grow a second copy in the cascade.
 */
function inheritedOverrides_(records, removed, windowDays) {
  var fetched = (records || []).filter(function (row) {
    return row.source === TX_SOURCE_API && hasOverride_(row);
  });
  var gone = (removed || []).filter(function (row) { return isImportedSource_(row.source); });
  if (!fetched.length || !gone.length) return {};

  var found = pairAcrossSources_(gone, fetched, windowDays);
  var inherited = {};

  found.exact.concat(found.near).forEach(function (pair) {
    var copied = {};
    var any = false;
    ['category_override', 'subcategory_override'].forEach(function (name) {
      if (isBlankCell_(pair.synced[name])) return;
      if (cellText_(pair.synced[name]) !== cellText_(pair.imported[name])) return;
      copied[name] = true;
      any = true;
    });
    if (any) inherited[cellText_(pair.synced.uid)] = copied;
  });

  return inherited;
}

/**
 * Carry the imported row's opinions over to the row that is staying.
 *
 * **Blanks only.** The survivor may already have a category you set from the
 * phone, or labels the cascade learned; the imported row's copy is older
 * information about the same money, and older information does not get to win.
 * So this fills gaps and never overwrites — which also makes it safe to run
 * twice, since the second pass finds nothing blank to fill.
 *
 * `category_override` rather than `category`: U is a formula and T is the cell
 * a person types in. Writing the derived column would put a literal where an
 * ARRAYFORMULA belongs and cost the whole column its anchor.
 *
 * One `setValues` per column rather than a `writeCell_` per cell. An overlap is
 * hundreds of pairs and four columns each, which is a thousand round-trips and
 * most of the six-minute limit spent on the call rather than the cells. The
 * block read back and written whole is a *single* column, deliberately: T, Y,
 * AA and AD are stored columns, but X and AC sit between them and are
 * ARRAYFORMULA columns, so a bounding rectangle would write their spilled
 * values back as literals and cost the tab two anchors.
 *
 * `textSafe_` is applied to every cell in the block and not only the ones being
 * changed. Reading a value and writing it back is a fresh write, and Sheets
 * consumed the apostrophe on the way in — so a `notes` cell that genuinely
 * begins with `=` would come back as a live formula for the second time. It is
 * idempotent, so the cells being changed are not harmed by being covered twice.
 */
function mergeIntoSurvivors_(sheet, pairs) {
  var wanted = {};
  var filled = 0;

  pairs.forEach(function (pair) {
    DUPLICATE_MERGE_COLUMNS.forEach(function (name) {
      if (!isBlankCell_(pair.synced[name])) return;
      if (isBlankCell_(pair.imported[name])) return;

      if (!wanted[name]) wanted[name] = {};
      wanted[name][pair.synced._row] = pair.imported[name];
      filled++;
    });
  });

  Object.keys(wanted).forEach(function (name) {
    var rows = Object.keys(wanted[name]).map(Number);
    var from = Math.min.apply(null, rows);
    var to = Math.max.apply(null, rows);

    var range = sheet.getRange(from, colIndex_(TX_COLUMNS, name), to - from + 1, 1);
    var block = range.getValues();

    rows.forEach(function (row) { block[row - from][0] = wanted[name][row]; });
    range.setValues(block.map(function (cells) { return [textSafe_(cells[0])]; }));
  });

  if (filled) {
    forgetReadCache_();
    bumpDataVersion_();
  }

  return filled;
}

/**
 * Descending row numbers as `{start, count}` blocks, still descending.
 *
 * Kept separate from the deleting so the grouping is testable without a
 * spreadsheet — it is the part with an off-by-one in it.
 */
function runsOfRows_(descending) {
  var runs = [];

  descending.forEach(function (row) {
    var last = runs[runs.length - 1];
    if (last && row === last.start - 1) {
      last.start = row;
      last.count++;
      return;
    }
    runs.push({ start: row, count: 1 });
  });

  return runs;
}
