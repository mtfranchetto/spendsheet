/**
 * 09_sync.gs — the run that happens while you are asleep.
 *
 * Orchestration only. Fetching is 02_api's job, shaping a row is 07's,
 * identity is 08's, and anything to do with an account or a consent is 06's.
 * What is left here is the part that has to be decided rather than computed:
 * what to ask for, in what order, and what to do when one bank fails and the
 * others are fine.
 *
 * Three properties this file exists to hold:
 *
 *   **One bank failing must not stop the others.** Every account is fetched
 *   inside its own try/catch, the failure is written to that connection's
 *   `_status.last_error`, and the run is marked PARTIAL rather than FAIL. A
 *   sync that aborts on the first error is a sync that stops working the week
 *   one bank has an outage.
 *
 *   **`transactions` is append-only.** Nothing here rewrites or reorders an
 *   existing row, ever. Rows arrive at the bottom in the order they were
 *   inserted and stay there — which is what keeps every formula reference and
 *   every note you have written attached to the row it belongs to.
 *
 *   **A 429 is not retried.** Most ASPSPs cap unattended fetching at around
 *   four calls per account per day and answer an overrun with a penalty
 *   measured in hours. Retrying inside the run turns a delay into a lockout,
 *   so the account is left for tomorrow and said so out loud.
 */

/** Menu → Sync now. */
function syncNow() {
  var summary = syncAll({ trigger: RUN_TRIGGER.MANUAL });
  SpreadsheetApp.getActiveSpreadsheet().toast(summary.message, 'Sync ' + summary.result, 15);
  return summary;
}

/** Time-driven trigger entry point. Installed in phase 8. */
function syncScheduled() {
  return syncAll({ trigger: RUN_TRIGGER.SCHEDULED });
}

/**
 * A whole sync, under a lock.
 *
 * The lock matters because the nightly trigger and an impatient "Sync now"
 * can genuinely overlap, and two runs appending to the same tab at once is
 * how you get duplicates that no dedup can prevent — both read the same
 * "already seen" set before either has written.
 */
function syncAll(options) {
  options = options || {};
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(2000)) {
    throw new Error('A sync is already running. Wait for it to finish.');
  }
  try {
    return runSync_(options);
  } finally {
    lock.releaseLock();
  }
}

function runSync_(options) {
  var started = new Date();
  var config = readConfig_();
  var accounts = listSyncableAccounts_();

  var txSheet = sheetOrThrow_(TABS.TRANSACTIONS);
  var pendingSheet = sheetOrThrow_(TABS.PENDING);

  var existing = readExistingIndex_(txSheet);
  var totals = { fetched: 0, inserted: 0, duplicate: 0, ok: 0, skipped: 0 };
  var messages = [];
  var pendingRows = [];
  var refreshed = [];

  accounts.forEach(function (account) {
    var outcome = syncAccount_(account, {
      config: config,
      existing: existing,
      now: new Date(),
      backfill: !existing.accountsSeen[account.uid]
    });

    totals.fetched += outcome.fetched;
    totals.duplicate += outcome.duplicates;

    if (outcome.skipped) {
      // Deliberately not counted as a failure: nothing broke, we chose not
      // to call. Marking it FAIL would train you to ignore the alerts.
      totals.skipped++;
      messages.push(account.name + ' skipped — ' + outcome.skipped);
    } else if (outcome.error) {
      messages.push(account.name + ': ' + outcome.error);
      recordConnectionOutcome_(account.connectionId, outcome.error);
    } else {
      totals.ok++;
      recordConnectionOutcome_(account.connectionId, null, started);
    }

    if (outcome.fresh.length) {
      // Written per account rather than once at the end: a run that dies
      // halfway — timeout, quota, an unhandled shape — keeps what it had
      // already fetched instead of throwing all of it away.
      var rows = outcome.fresh.map(function (record) { return toRow_(TX_COLUMNS_CODE, record); });
      appendRows_(txSheet, 1, rows);
      totals.inserted += rows.length;

      // Keep the in-memory index honest, so a second account cannot re-insert
      // a uid the first one just wrote.
      outcome.fresh.forEach(function (record) {
        existing.byUid[record.uid] = { amount: record.amount, booking_date: record.booking_date };
      });
      existing.accountsSeen[account.uid] = true;
    }

    if (outcome.pendingRefreshed) {
      refreshed.push(account.uid);
      pendingRows = pendingRows.concat(
        outcome.pending.map(function (record) { return toRow_(PENDING_COLUMNS, record); }));
    }
  });

  rewritePending_(pendingSheet, refreshed, pendingRows);

  var attempted = accounts.length - totals.skipped;
  var result = !attempted ? RUN_RESULT.OK
    : totals.ok === attempted ? RUN_RESULT.OK
    : totals.ok === 0 ? RUN_RESULT.FAIL
    : RUN_RESULT.PARTIAL;

  var summary = {
    runId: Utilities.getUuid().slice(0, 8),
    started: started,
    durationMs: new Date().getTime() - started.getTime(),
    trigger: options.trigger || RUN_TRIGGER.MANUAL,
    attempted: attempted,
    skipped: totals.skipped,
    ok: totals.ok,
    fetched: totals.fetched,
    inserted: totals.inserted,
    duplicate: totals.duplicate,
    result: result,
    message: describeRun_(attempted, totals, messages)
  };

  recordRun_(summary, config);
  return summary;
}

function describeRun_(attempted, totals, messages) {
  if (!attempted && !totals.skipped) {
    return 'No bank accounts to sync. Connect a bank, or check `kind` and `active` on the accounts tab.';
  }
  var text = attempted
    ? totals.inserted + ' new, ' + totals.duplicate + ' already held, across ' +
      totals.ok + '/' + attempted + ' accounts.'
    : 'Nothing fetched.';
  return messages.length ? text + ' ' + messages.join(' | ') : text;
}

// ---------------------------------------------------------------------------
// One account
// ---------------------------------------------------------------------------

/**
 * Balances, booked transactions, and pending — in that order, because the
 * balance is the cheapest call and the one most likely to still work when
 * something else about the connection is broken.
 *
 * Returns rather than throws. The caller decides what a single account's
 * failure means for the run as a whole, which is the only place that decision
 * can be made correctly.
 */
function syncAccount_(account, context) {
  var outcome = {
    fetched: 0, duplicates: 0, fresh: [], pending: [],
    pendingRefreshed: false, error: null, skipped: null, calls: 0
  };

  var allowance = accountCallAllowance_(context.config);
  var used = callsUsedToday_(account.uid);
  var remaining = allowance - used;

  if (remaining <= 0) {
    outcome.skipped = used + ' of ' + allowance + ' daily calls already used';
    return outcome;
  }

  try {
    // Spent in order of what is worth having: transactions first, since they
    // are the thing that cannot be recovered later — a balance missed today
    // is simply tomorrow's balance, but a day's transactions falling out of
    // the rolling window are gone. So the balance call is only made when
    // there is room for it *and* for the fetch that follows.
    if (remaining > 1) {
      var balances = ebGetAccountBalances(account.uid);
      outcome.calls++;
      remaining--;
      updateAccountBalance_(account.row, balances);
    }

    var booked = fetchTransactions_(account, context, TX_STATUS.BOOKED);
    outcome.calls += booked.pages;
    remaining -= booked.pages;

    var mapped = mapTransactions(booked.transactions, account, context.now);
    reportMappingProblems_(account, mapped);

    var bookedRecords = mapped.records.filter(isBooked);
    outcome.fetched = bookedRecords.length;

    var partitioned = partitionByUid(assignUids(bookedRecords), context.existing.byUid);
    outcome.fresh = partitioned.fresh;
    outcome.duplicates = partitioned.duplicates.length;
    reportConflicts_(account, partitioned.conflicts);

    // Anything non-booked that arrived in the booked response is a pending
    // row the provider ignored the filter on. Free, so it is used rather than
    // discarded — and it is what makes `fetch_pending: no` cost nothing on
    // providers that do not filter.
    var strays = mapped.records.filter(function (record) { return !isBooked(record); });

    if (configFlag_(context.config, 'fetch_pending') && remaining > 0) {
      var pending = fetchTransactions_(account, context, TX_STATUS.PENDING);
      outcome.calls += pending.pages;
      strays = mapTransactions(pending.transactions, account, context.now).records
        .filter(function (record) { return !isBooked(record); });
    }

    // Reached the account, so whatever we now hold for it is the current
    // picture — including "nothing", when pending is switched off. Leaving
    // yesterday's holds on screen would be worse than showing none.
    outcome.pendingRefreshed = true;
    outcome.pending = assignUids(strays);
  } catch (err) {
    outcome.error = describeSyncError_(account, err);
  }

  recordCalls_(account.uid, outcome.calls);
  return outcome;
}

/**
 * One fetch of one status.
 *
 * `strategy: 'longest'` goes out only when this account has no history in the
 * sheet at all. Full history is reachable for roughly an hour after
 * authorisation and drops to a rolling ~90 days afterwards, so this is the one
 * chance to backfill — and asking for it costs exactly the same call as not
 * asking, which is why it needs no state to track and no decision from you.
 */
function fetchTransactions_(account, context, status) {
  var windowDays = configNumber_(context.config, 'sync_window_days');
  var result = ebGetAllTransactions(account.uid, {
    dateFrom: context.backfill ? undefined : isoDay_(context.now, -windowDays),
    status: status,
    strategy: context.backfill ? 'longest' : undefined
  });

  if (result.truncated) {
    logAnomaly_(ANOMALY_KIND.TRUNCATED, account.uid,
      'Stopped after ' + result.pages + ' pages of ' + status + ' transactions — there are more. ' +
      'Run Sync now again to continue.', '');
  }
  return result;
}

/** `YYYY-MM-DD`, offset by whole days. */
function isoDay_(now, offsetDays) {
  var date = new Date(now.getTime());
  date.setDate(date.getDate() + offsetDays);
  return dateKey(date);
}

function describeSyncError_(account, err) {
  if (err && err.code === EB_ERROR.ASPSP_RATE_LIMIT_EXCEEDED) {
    logAnomaly_(ANOMALY_KIND.RATE_LIMITED, account.uid,
      'Rate limited by the bank. Not retried — see 09_sync.', err.body || '');
    return 'rate limited by the bank, left for the next run';
  }
  if (err && err.code) {
    logAnomaly_(ANOMALY_KIND.FETCH_FAILED, account.uid,
      err.code + ': ' + err.message, err.body || '');
    return describeEbError(err.code);
  }
  logAnomaly_(ANOMALY_KIND.FETCH_FAILED, account.uid, String(err && err.message), '');
  return String(err && err.message);
}

// ---------------------------------------------------------------------------
// What we already hold
// ---------------------------------------------------------------------------

/**
 * uid → {amount, booking_date} for every row already in `transactions`.
 *
 * Reads only the columns identity depends on. The alternative — asking the
 * sheet per row — is a network round-trip each time and would put a nightly
 * sync into the six-minute limit somewhere around the second year.
 */
function readExistingIndex_(sheet) {
  var index = { byUid: {}, accountsSeen: {} };
  var last = lastRecordRow_(sheet, 1);
  if (last < 2) return index;

  var width = colIndex_(TX_COLUMNS_CODE, 'amount');
  var rows = sheet.getRange(2, 1, last - 1, width).getValues();
  var uidAt = colIndex_(TX_COLUMNS_CODE, 'uid') - 1;
  var accountAt = colIndex_(TX_COLUMNS_CODE, 'account_id') - 1;
  var dateAt = colIndex_(TX_COLUMNS_CODE, 'booking_date') - 1;
  var amountAt = width - 1;

  rows.forEach(function (row) {
    if (!row[uidAt]) return;
    index.byUid[String(row[uidAt])] = { amount: row[amountAt], booking_date: row[dateAt] };
    if (row[accountAt]) index.accountsSeen[String(row[accountAt])] = true;
  });
  return index;
}

// ---------------------------------------------------------------------------
// pending
// ---------------------------------------------------------------------------

/**
 * `pending` is rewritten, not merged.
 *
 * A pending authorisation has no stable identity — its amount, date and
 * description can all change on the way to settling, and `entry_reference` is
 * booked-only, so at most banks there is literally nothing to match it
 * against. Trying to track one through settlement means guessing; rewriting
 * the tab means the sheet always shows exactly what the bank currently says
 * is outstanding, and nothing more.
 *
 * Rows belonging to an account we did *not* reach this run are kept. Dropping
 * them would make a bank outage look like a bank clearing your holds.
 */
function rewritePending_(sheet, refreshedAccountIds, rows) {
  var kept = readRecords_(sheet, PENDING_COLUMNS)
    .filter(function (record) {
      return record.account_id && refreshedAccountIds.indexOf(String(record.account_id)) === -1;
    })
    .map(function (record) { return toRow_(PENDING_COLUMNS, record); });

  clearDataRows_(sheet, 1, PENDING_COLUMNS.length);
  appendRows_(sheet, 1, kept.concat(rows));
  return kept.length + rows.length;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function reportMappingProblems_(account, mapped) {
  if (mapped.skipped.length) {
    logAnomaly_(ANOMALY_KIND.UNPARSEABLE_AMOUNT, account.uid,
      mapped.skipped.length + ' transaction(s) had no readable amount and were not written.',
      mapped.skipped.slice(0, 20));
  }
  if (mapped.missingIndicator) {
    // Worth knowing per provider: without an indicator we are trusting the
    // sign the amount arrived with, which the spec does not promise.
    logAnomaly_(ANOMALY_KIND.UNMAPPED_COLUMN, account.uid,
      mapped.missingIndicator + ' transaction(s) had no credit_debit_indicator; ' +
      'the sign of the amount was used as-is.', '');
  }
}

function reportConflicts_(account, conflicts) {
  conflicts.forEach(function (conflict) {
    logAnomaly_(ANOMALY_KIND.DUP_ENTRY_REF, account.uid,
      'entry_reference "' + conflict.record.entry_reference + '" came back with a different ' +
      'amount or date. Held row: ' + amountKey(conflict.previous.amount) + ' on ' +
      dateKey(conflict.previous.booking_date) + '; now: ' + amountKey(conflict.record.amount) +
      ' on ' + dateKey(conflict.record.booking_date) + '. Not written — history is append-only.',
      conflict.record);
  });
}

/**
 * One row per run in `_runs`.
 *
 * This is the tab phase 8's monitoring reads, and the reason it exists is
 * failure mode four: a run that completes, reports success, and fetched
 * nothing. That is invisible unless the count of what it fetched is written
 * down somewhere every single time.
 */
function recordRun_(summary, config) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.RUNS);
  if (!sheet) return;

  appendRows_(sheet, 1, [toRow_(RUN_COLUMNS, {
    run_id: summary.runId,
    started_at: summary.started,
    duration_ms: summary.durationMs,
    trigger: summary.trigger,
    accounts_attempted: summary.attempted,
    accounts_ok: summary.ok,
    rows_fetched: summary.fetched,
    rows_inserted: summary.inserted,
    rows_duplicate: summary.duplicate,
    result: summary.result,
    message: String(summary.message).slice(0, 1000)
  })]);

  trimToLastRows_(sheet, 1, RUN_COLUMNS.length, configNumber_(config, 'runs_to_keep'));
}

// ---------------------------------------------------------------------------
// The daily call budget
// ---------------------------------------------------------------------------

/**
 * How many API calls this account has cost today.
 *
 * A full sync of one account is three calls — balances, booked, pending —
 * against a typical cap of four. That leaves exactly one spare, so a single
 * "Sync now" after the nightly run is enough to trip a limit whose penalty is
 * measured in hours. Counting is cheaper than explaining why the sheet stopped
 * updating until tomorrow afternoon.
 *
 * Kept in Script Properties rather than a tab: it is machinery with a one-day
 * lifespan, and nothing about it is worth a row you would have to look at.
 */
/**
 * How many calls an account gets today.
 *
 * The cap exists to avoid a *real bank's* rate-limit penalty, which is
 * measured in hours. Sandbox is a simulator: there is no ASPSP behind it to
 * offend and nothing to be locked out of, so applying the same budget there
 * throttles the one environment where you are deliberately syncing over and
 * over to see whether something works. That is friction bought with no safety.
 */
function accountCallAllowance_(config) {
  if (ebEnvironment() === EB_ENV.SANDBOX) return Infinity;
  return configNumber_(config, 'max_calls_per_account_per_day');
}

function callsUsedToday_(accountUid) {
  var budget = readCallBudget_();
  return budget.counts[accountUid] || 0;
}

function recordCalls_(accountUid, calls) {
  if (!calls) return;
  var budget = readCallBudget_();
  budget.counts[accountUid] = (budget.counts[accountUid] || 0) + calls;
  PropertiesService.getScriptProperties()
    .setProperty(SYNC_PROP.CALL_BUDGET, JSON.stringify(budget));
}

function readCallBudget_() {
  var today = dateKey(new Date());
  var raw = PropertiesService.getScriptProperties().getProperty(SYNC_PROP.CALL_BUDGET);
  var parsed = raw ? safeJsonParse(raw) : null;

  if (!parsed || parsed.date !== today) return { date: today, counts: {} };
  return { date: parsed.date, counts: parsed.counts || {} };
}
