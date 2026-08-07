/**
 * 23_api.gs — everything the page is allowed to call, and nothing else.
 *
 * ## Why this file exists at all, rather than the page calling 21 and 22
 *
 * **`google.script.run` cannot call a function whose name ends in `_`.** That
 * is the Apps Script convention for a private function and it is enforced, not
 * decorative — so `webAppAnalytics_` is unreachable from a page by
 * construction. Every entry point therefore has to be a public name, and the
 * moment there is a set of public names it is worth them being *this* set,
 * written down in one place, rather than a scattering of functions that happen
 * not to have an underscore.
 *
 * This is not the project's whole public surface — every menu item is a public
 * function too, and always was. What it is, is the set the *app* reaches, and
 * therefore the set that has to answer the question the menu never has to:
 * a menu item runs for someone who already has edit access to the Sheet, and
 * these run for whoever loaded a page.
 *
 * ## Why the gate is checked again on every call
 *
 * The page is only served to the owner — `webAppPage_` sees to that — so a
 * request arriving here has, in the normal case, already been through the lock.
 * Checking again costs one `_config` read and buys the property that the gate
 * is not load-bearing on *how the caller got the page*. These functions return
 * bank balances and write to the ledger; "you can only reach this if you were
 * served the page" is a claim about a whole system, and `requireOwner_` makes
 * it a claim about one line.
 *
 * It also fails the same way the page does — a plain refusal, saying nothing
 * about why — so probing the API tells a stranger no more than probing the URL.
 *
 * The corollary is the rule for adding to this file: **a new function here is a
 * new endpoint, and it needs `requireOwner_()` on its first line.** That is not
 * left to memory — `tests/app.test.mjs` derives the list by reading this file
 * and fails on one that forgot.
 *
 * ## Why every one of them returns a plain object
 *
 * `google.script.run` serialises. A `Date` does not survive, an `undefined`
 * silently becomes nothing, and a thrown `Error` reaches the page as a message
 * and no more. So dates leave as `yyyy-MM-dd` strings, every field is present
 * even when empty, and a failure is a message written to be read by a person on
 * a phone rather than a stack trace.
 */

/**
 * The gate, on the server side of a page call.
 *
 * Throws rather than returning a refusal object, because every caller here
 * would otherwise have to remember to check — and the one that forgets is the
 * one that returns the balances. A throw reaches the page through
 * `withFailureHandler`, which is where a refusal belongs.
 */
function requireOwner_() {
  var decision = webAppAccessDecision_(webAppOwner_(), activeUserEmail_());
  if (!decision.ok) {
    Logger.log('api refused: ' + decision.reason);
    throw new Error('Not available.');
  }
}

/**
 * Everything the app needs to draw its *first* screen, in one call.
 *
 * This used to prefetch Charts and Records too, so that every screen was
 * instant once the page had opened. The argument was one round trip rather
 * than four, and it was measured against the wrong thing: the cost here is not
 * round trips, it is reading `transactions`. Each of those three screens
 * called `readLedger_` for itself, so opening the app read 4,600 rows by
 * thirty columns **three times** — and two of those reads were for screens you
 * might never visit that session.
 *
 * So the bootstrap is now the dashboard and the lists, and the dashboard reads
 * only the rows it draws. Charts and Records fetch on first navigation, which
 * `go()` in the page has always been able to do; the prefetch was pre-empting
 * it. They pay a full read when you open them, once, and they are the screens
 * that genuinely need one.
 *
 * The lists — accounts, labels, categories — still come along. They change
 * about once a month, they are what every filter on every screen is built
 * from, and they are small. Fetching them per screen would be the round-trip
 * argument applied where it actually holds.
 */
function appBootstrap() {
  // The gate runs inside the read cache, not before it, and the order still
  // holds: opening the cache sets a variable and reads nothing, so a refusal
  // throws before a single cell is touched. What it buys is that
  // `requireOwner_`'s own `_config` read — which every endpoint makes — is the
  // same read the screen then wants, rather than a second one.
  return withReadCache_(function () {
    requireOwner_();

    return {
      dashboard: appDashboardData_(),
      lists: {
        accounts: accountNames_(),
        cashAccounts: cashAccountList_(),
        labels: labelNames_(),
        categories: categoryChoices_(),
        periods: appPeriods_()
      },
      currency: baseCurrency_(),
      generatedAt: dayKey_(dayNumber_(new Date()))
    };
  });
}

/** The Analytics screen, for one set of filters. */
function appAnalytics(filters) {
  return withReadCache_(function () {
    requireOwner_();
    return webAppAnalytics_(filters);
  });
}

/** One page of the ledger. */
function appRecords(filters, offset) {
  return withReadCache_(function () {
    requireOwner_();
    return webAppRecords_(filters, offset);
  });
}

/**
 * The dashboard on its own, for a pull-to-refresh.
 *
 * Forgets the cache first, because this is the one call whose entire meaning is
 * "I do not believe what is on screen". Serving it from a cache would answer a
 * request for fresh data with the same stale answer, and there would be no
 * second thing to try — this *is* the retry.
 */
function appDashboard() {
  return withReadCache_(function () {
    requireOwner_();
    forgetLedgerCache_();
    return appDashboardData_();
  });
}

/**
 * Confirm or re-categorise a batch of rows.
 *
 * Batched rather than one call per tap, because a page that fires a request per
 * checkbox on a train produces a queue of requests that resolve out of order,
 * and the last one to land wins. One call per gesture is a weaker promise and a
 * much easier one to keep.
 */
function appConfirm(decisions) {
  requireOwner_();
  return applyReviewDecisions_(decisions);
}

/** Add a cash transaction. */
function appAddCash(entry) {
  requireOwner_();
  return webAppAddCash_(entry);
}

// ---------------------------------------------------------------------------
// The dashboard screen
// ---------------------------------------------------------------------------

/**
 * The dashboard, computed rather than read off the `dashboard` tab.
 *
 * The tab is right there and already holds every one of these numbers, so
 * reading `dashboard!A1:S130` and picking cells out of it is the obvious
 * implementation. It was rejected: those coordinates are `DASH`'s business and
 * `DASH` moves. This project has already spent a session on a column that
 * shifted one place right, and the symptom then was three unrelated failures
 * with nothing connecting them — a page reading cells by address would have
 * been a fourth, showing a consent expiry where a balance belongs.
 *
 * Computing it costs one more pass over rows already in memory, and buys two
 * things: the app cannot disagree with itself, because every screen is fed by
 * the same aggregation; and `16_dashboard.gs` stays free to rearrange the tab
 * without breaking the phone.
 *
 * It does **not** re-derive the health checks. `runChecks_` is the six failure
 * detectors and there must be exactly one of those — a second opinion about
 * whether the sync is stale is precisely the thing that ends up disagreeing.
 */
function appDashboardData_() {
  var now = new Date();
  var window = resolveWindow_({ kind: 'mtd' }, now);
  var previous = lastMonthToDate_(now);

  // One read of the whole tab, which is not what it looks like.
  //
  // This screen draws two months and a short queue, so it briefly read exactly
  // those rows: four narrow columns to decide which they were, then only those
  // rows at full width. The arithmetic was cells transferred — four columns
  // against thirty — and the arithmetic was the wrong model.
  //
  // Measured on the live book at 4,615 rows: the full thirty-column read takes
  // **2,025ms**, and the four single-column reads that were supposed to replace
  // it take **3,678ms between them**. A `getValues` costs roughly the same
  // whether it returns one column or thirty; what it costs is the *call*. Four
  // calls is four times the price for an eighth of the data.
  //
  // So the narrow path made the screen it was written for 93% slower, and
  // `describeQueryCost` is what said so. The saving that remains — and it is
  // the real one — is that the bootstrap no longer fetches Charts and Records,
  // which is three of these reads down to one.
  var ledger = readLedger_();

  var month = aggregate_(ledger.filter(function (row) {
    return matchesFilters_(row, { window: window });
  }), window);

  var lastMonth = aggregate_(ledger.filter(function (row) {
    return matchesFilters_(row, { window: previous });
  }), previous);

  return {
    month: {
      from: dayKey_(window.from),
      to: dayKey_(window.to),
      expenses: month.totals.expenses,
      income: month.totals.income,
      net: month.totals.net,
      // Month-to-date against month-to-date, never against a whole month. A
      // comparison that flatters you on the 3rd and alarms you on the 30th is
      // worse than none, because it is wrong in a way that feels informative.
      lastMonthToDate: lastMonth.totals.expenses,
      byCategory: month.byCategory
    },
    accounts: appAccounts_(),
    netWorth: netWorthNow_({}),
    // The ledger's length is `lastRecordRow_ - 1` on `transactions`, which is
    // exactly what `checkRowLoss_` would scan the tab to work out. Handing it
    // over takes ~1,900ms off every dashboard — see the note on `runChecks_`.
    health: appHealth_(ledger.length),
    review: appReviewQueue_(ledger),
    currency: baseCurrency_()
  };
}

/**
 * The same stretch of last month, so the comparison is like for like.
 *
 * `EDATE`'s clamping in JS terms: a run on the 31st compares against the last
 * day of a thirty-day month rather than silently reaching into this one.
 */
function lastMonthToDate_(now) {
  var start = startOfMonth_(now.getFullYear(), now.getMonth() - 1);
  var lastDay = addMonths_(start, 1) - 1;
  var sameDay = start + (now.getDate() - 1);
  return { kind: 'last_month_to_date', from: start, to: Math.min(sameDay, lastDay) };
}

/**
 * Every active account, with the one sentence that says whether it is working.
 *
 * The sentence is the same vocabulary `accountSyncFormula` uses on the tab, and
 * for the same reason: the colour tells you *that* something is wrong and the
 * words tell you *what*, without a second screen. A non-bank account reads as
 * having nothing to sync rather than as failing to — a cash tin has no consent
 * to expire, and marking it as a problem every day is how a whole column stops
 * being read.
 */
function appAccounts_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TABS.ACCOUNTS);
  if (!sheet) return [];

  var consent = consentDaysByConnection_(ss);
  var warnAt = configNumber_(readConfig_(), 'consent_warning_days');
  var staleAfter = configNumber_(readConfig_(), 'stale_balance_days');
  var today = dayNumber_(new Date());

  return readRecords_(sheet, ACCOUNT_COLUMNS)
    .filter(function (account) {
      return account.account_id && isTruthyCell_(account.active);
    })
    .map(function (account) {
      var days = consent[String(account.connection_id || '')];
      var updated = dayNumber_(account.balance_updated_at);
      var state = accountState_(account, days, updated, today, warnAt, staleAfter);

      return {
        name: String(account.name || account.account_id),
        kind: String(account.kind || ''),
        currency: String(account.currency || ''),
        balance: cellNumber_(account.balance),
        updated: updated === null ? '' : dayKey_(updated),
        inNetWorth: isTruthyCell_(account.include_in_net_worth),
        severity: state.severity,
        sync: state.sync
      };
    })
    .sort(function (a, b) { return (b.balance || 0) - (a.balance || 0); });
}

/**
 * How bad this account's state is, as one number and one sentence.
 *
 * Folded into a single severity rather than three independent flags, exactly as
 * `accountSeverityFormula` does: a row is marked once, for the worst thing true
 * of it. Three overlapping marks paint the same row three times and leave you
 * reading colours instead of words.
 *
 * A stale balance is a **warning**, not a failure. A weekend, a bank holiday
 * and a quiet current account all produce one, and colouring those red is how
 * red stops meaning anything.
 */
function accountState_(account, days, updated, today, warnAt, staleAfter) {
  if (String(account.kind || '') !== ACCOUNT_KIND.BANK) {
    return { severity: 0, sync: '—' };
  }
  if (days === null || days === undefined) {
    return { severity: 2, sync: 'reconnect — no consent' };
  }
  if (days <= 0) return { severity: 2, sync: 'reconnect — consent expired' };
  if (days <= warnAt) return { severity: 1, sync: 'expires in ' + days + ' days' };
  if (updated !== null && today - updated > staleAfter) {
    return { severity: 1, sync: 'balance ' + (today - updated) + ' days old' };
  }
  return { severity: 0, sync: 'ok' };
}

/** connection_id → days left, which is the two-hop join the dashboard does with VLOOKUPs. */
function consentDaysByConnection_(ss) {
  var sheet = ss.getSheetByName(TABS.STATUS);
  var days = {};
  if (!sheet) return days;

  readRecords_(sheet, STATUS_COLUMNS).forEach(function (row) {
    if (isBlankCell_(row.connection_id)) return;
    days[String(row.connection_id)] = cellNumber_(row.days_left);
  });
  return days;
}

/**
 * The health banner: the six failure detectors, unchanged.
 *
 * `runChecks_` rather than a phone-shaped reimplementation, because a second
 * opinion about whether the sync has stopped is exactly the thing that ends up
 * disagreeing with the first — and the one you would believe is whichever you
 * happened to be looking at.
 *
 * Wrapped, because a detector that throws must not take the whole screen with
 * it. A dashboard that will not load is worse than one saying it could not
 * check.
 */
function appHealth_(rowCount) {
  try {
    return runChecks_(new Date(), rowCount).map(function (alert) {
      return {
        kind: String(alert.kind || ''),
        subject: String(alert.subject || ''),
        detail: String(alert.detail || '')
      };
    });
  } catch (e) {
    return [{ kind: 'check_failed', subject: 'Could not run the health checks',
      detail: e.message }];
  }
}

/**
 * The backlog, straight off `transactions` rather than off the `review` tab.
 *
 * The tab is a **snapshot** refilled by a run, and refilling one needs a run —
 * which is the one thing a phone cannot do. Reading the tab would mean the app
 * showed you a queue that was correct this morning, and confirming a row on the
 * phone would leave it sitting there until the nightly sync cleared it.
 *
 * The argument that made `review` a snapshot does not apply here: it exists
 * because a `QUERY`'s rows *move* when you confirm one, and a tick lands on
 * whatever row slid into position 3. This list carries a `uid` per row, so a
 * position is never what an action is addressed to, and the list is free to be
 * live.
 */
function appReviewQueue_(ledger) {
  return ledger
    .filter(function (row) { return !isConfirmedRow_(row); })
    .sort(function (a, b) {
      return dateOrder_(a.booking_date) - dateOrder_(b.booking_date);
    })
    .slice(0, queueSize_())
    .map(recordForPage_);
}

// ---------------------------------------------------------------------------
// The lists a filter is built from
// ---------------------------------------------------------------------------

/** Active account names, which is what every account filter offers. */
function accountNames_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  if (!sheet) return [];

  return readRecords_(sheet, ACCOUNT_COLUMNS)
    .filter(function (account) {
      return account.account_id && isTruthyCell_(account.active) && account.name;
    })
    .map(function (account) { return String(account.name); });
}

/** Every label you have defined, from the tab that is the known set. */
function labelNames_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.LABELS);
  if (!sheet) return [];

  return readRecords_(sheet, LABEL_COLUMNS)
    .filter(function (row) { return !isBlankCell_(row.label); })
    .map(function (row) { return String(row.label); });
}

// ---------------------------------------------------------------------------
// What the first screen costs
// ---------------------------------------------------------------------------

/**
 * Where the seconds go when the app opens, measured part by part in one run.
 *
 * `describeQueryCost` answered a different question — what one *ledger read*
 * costs — and answered it well enough that the cache got built on it. It cannot
 * answer this one: the dashboard reads `transactions` once and then reads
 * `_config`, `accounts`, `_status`, `_runs`, `categories` and `labels` a dozen
 * more times between them, and none of those go through the ledger cache. A
 * cache that works perfectly and a dashboard that is still slow are entirely
 * compatible, and telling them apart needs the parts named.
 *
 * Two rules are baked into the shape of this:
 *
 * **Both ledger reads happen here, back to back.** The cache is dropped first
 * so the first read is a guaranteed miss and the second is the case the user
 * actually experiences — opening the app twice. `ledgerSecond` reporting
 * `sheet` rather than `cache` means the cache is never hitting, which is a
 * different bug from it hitting and not helping, and no timing distinguishes
 * the two.
 *
 * **Every part is timed inside one execution.** A spreadsheet read on this book
 * has been seen to vary from 2,025ms to 9,418ms within an hour, so a number
 * from this run compared against a number from the last one proves nothing.
 * Compare the parts against each other, here, where they saw the same weather.
 *
 * `configMs` is the one to read first: it is the price of a single `_config`
 * read, and the dashboard path takes about eight of them.
 */
function describeDashboardCost() {
  requireOwner_();

  var at = function (fn) {
    var started = Date.now();
    fn();
    return Date.now() - started;
  };

  // A guaranteed miss, then the read the second page load actually makes.
  forgetLedgerCache_();
  var coldMs = at(readLedger_);
  var coldSource = LEDGER_SOURCE;
  var warmMs = at(readLedger_);
  var warmSource = LEDGER_SOURCE;

  var ledger = readLedger_();
  var now = new Date();
  var window = resolveWindow_({ kind: 'mtd' }, now);
  var previous = lastMonthToDate_(now);

  var report = {
    rows: ledger.length,

    // Does the second load hit? This is the whole question.
    ledgerFirstMs: coldMs,
    ledgerFirst: coldSource,
    ledgerSecondMs: warmMs,
    ledgerSecond: warmSource,

    // One `_config` read, which several of the parts below do more than once.
    configMs: at(readConfig_),

    // The dashboard, with the ledger already cached.
    accountsMs: at(appAccounts_),
    netWorthMs: at(function () { return netWorthNow_({}); }),
    healthMs: at(appHealth_),
    reviewMs: at(function () { return appReviewQueue_(ledger); }),
    aggregateMs: at(function () {
      aggregate_(ledger.filter(function (row) {
        return matchesFilters_(row, { window: window });
      }), window);
      aggregate_(ledger.filter(function (row) {
        return matchesFilters_(row, { window: previous });
      }), previous);
    }),

    // The lists the bootstrap carries alongside it.
    listsMs: at(function () {
      accountNames_();
      cashAccountList_();
      labelNames_();
      categoryChoices_();
    }),

    // The whole call the page makes, warm — what the user is timing.
    bootstrapMs: at(appBootstrap)
  };

  // What sharing the reads is worth, measured inside this one run.
  //
  // Every part above is timed *unwrapped*, so each pays full price for the
  // tabs it fetches for itself — which is exactly what the bootstrap used to
  // do. `bootstrapMs` runs the same work through `withReadCache_`. The
  // difference between them is the duplication, and both numbers saw the same
  // weather, which is the only way a comparison means anything on this book.
  report.partsMs = report.ledgerSecondMs + report.accountsMs + report.netWorthMs +
    report.healthMs + report.reviewMs + report.aggregateMs + report.listsMs;
  report.sharedReadsSavedMs = report.partsMs - report.bootstrapMs;

  // The same parts again, this time sharing one cache, in bootstrap order.
  //
  // Sharing halved the round trips and about twenty remain, where seven tabs
  // should cost fourteen. Timing the parts separately cannot find the rest:
  // each one pays for the tabs nobody fetched before it, so the *first* part
  // in the order looks expensive and the rest look free, whoever they are.
  //
  // Run in order, what is left is legible: a part that still costs real time
  // once its tabs are warm is reading something the cache does not cover.
  // `checkRowLoss_` is the known one — it scans the `transactions` key column
  // directly rather than through `readRecords_`, so 4,615 rows are fetched on
  // every dashboard even when the ledger itself came from the cache.
  //
  // Divide any of these by `configMs` to get round trips. That ratio is the
  // only number here that survives the read variance, because both halves of
  // it were measured in the same run.
  report.shared = withReadCache_(function () {
    return {
      accountsMs: at(appAccounts_),
      netWorthMs: at(function () { return netWorthNow_({}); }),
      healthMs: at(function () { return appHealth_(ledger.length); }),
      listsMs: at(function () {
        accountNames_();
        cashAccountList_();
        labelNames_();
        categoryChoices_();
      }),
      rowLossMs: at(checkRowLoss_)
    };
  });

  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'app dashboard cost', report);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Ledger: ' + coldMs + 'ms from ' + coldSource + ', then ' + warmMs + 'ms from ' +
    warmSource + '.\nWarm bootstrap ' + report.bootstrapMs + 'ms, against ' +
    report.partsMs + 'ms of parts fetching their own tabs — sharing the reads ' +
    'saves ' + report.sharedReadsSavedMs + 'ms.\nSharing one cache, in order: ' +
    'accounts ' + report.shared.accountsMs + ', net worth ' +
    report.shared.netWorthMs + ', health ' + report.shared.healthMs +
    ', lists ' + report.shared.listsMs + ', row-loss scan ' +
    report.shared.rowLossMs + '.\nOne _config read costs ' +
    report.configMs + 'ms.',
    'Dashboard cost', 30);

  return report;
}

/**
 * The periods the app offers, named the same as on the `reports` tab.
 *
 * The labels come from `REPORT_PERIODS` where they match, so that "Last month"
 * means the same thing on the phone as it does on the desktop and neither can
 * drift into meaning something else. What it cannot share is the arithmetic —
 * that table holds Sheets expressions, and `resolveWindow_` holds the JS.
 *
 * `Custom` carries no dates here: the page sends them, and the two cells the
 * `reports` tab uses for that are a desktop thing.
 */
function appPeriods_() {
  return [
    { kind: 'mtd', label: 'This month' },
    { kind: 'last_month', label: 'Last month' },
    { kind: 'last_12', label: 'Last 12 months' },
    { kind: 'year', label: 'This year' },
    { kind: 'custom', label: 'Custom' }
  ];
}
