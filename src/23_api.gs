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
 * The top of the dashboard, and nothing that needs the ledger.
 *
 * ## Why the screen is two calls rather than one
 *
 * Total server time went from ~6,200ms to ~2,400ms, and the app still did not
 * feel fast — because a spinner held the whole screen until the last number
 * arrived. **What a person experiences is when the first real content appears,
 * not when the last does**, and every measurement taken here so far was of the
 * wrong end of that.
 *
 * Net worth and the account tiles — the top of the screen, and what you open
 * the app to see — need `accounts`, `_status` and `_config`, about 800ms.
 * Everything else on the dashboard needs the ledger, which is the other
 * 1,600ms. Bundled together, the cheap half waited for the expensive half for
 * no reason at all.
 *
 * So the page fires this and `appOverview` **at the same time** and draws each
 * as it lands. Wall-clock total goes up by ~500ms, because both calls read
 * `accounts` and `_config` for themselves and neither can share a cache with
 * the other. That is the trade and it is the right way round: 500ms of total
 * for 1,600ms of first paint.
 *
 * ## Why the health banner is not here
 *
 * It looks like it belongs — it is the top of the screen. But `runChecks_`
 * ends in `checkRowLoss_`, which scans 4,615 rows of the `transactions` key
 * column unless it is handed a count, and the only thing holding that count is
 * the ledger. Putting health in the fast call would have put a two-second scan
 * in it. It goes with the ledger, where the count is free.
 */
function appOpen() {
  return withReadCache_(function () {
    requireOwner_();
    return appOpenData_();
  });
}

/**
 * The first screen, serialised into the page instead of fetched from it.
 *
 * ## Why this exists
 *
 * Profiled from outside the sandboxed iframe: `appOpen` does ~800ms of work on
 * the server and costs the browser **~3,500ms**, twice in a row within 10ms of
 * itself. The other ~2,700ms is a whole Apps Script execution being spun up to
 * answer one call, and it is fixed — no amount of work removed from `appOpen`
 * touches it.
 *
 * `doGet` is already an execution, already paying that startup, already ~3,350ms
 * in before the page exists. Doing the same work *there* costs only the work.
 * So the top of the dashboard arrives with the document and draws the instant
 * the page parses, and the first `google.script.run` round trip disappears —
 * about 2,000ms off an open, which is more than every server-side fix that
 * preceded it put together.
 *
 * ## Why a string and not an object
 *
 * The caller drops this into a `<script type="application/json">` element, so
 * the escaping has to happen once, here, next to the reason for it — rather
 * than at a template boundary where the next person to interpolate something
 * gets it wrong. `htmlSafeJson_` is the whole of that rule.
 *
 * ## Why only the top half
 *
 * The lower half was inlined here too, gated on the ledger already being
 * cached so the cost would be ~700ms rather than ~4,700. **Measured on the
 * live app, it made the document three to seven times slower** — the `/exec`
 * response went from 3,116/3,351/3,686ms to 5,875/7,030/**23,928**ms, and
 * first paint with it. Everything the overview does lands in front of the
 * document, where there is nothing else to look at.
 *
 * The asymmetry is the point and it is worth stating: work belongs here only
 * if it is **bounded and small**. `appOpenData_` reads three tabs and is
 * ~800ms whatever the ledger holds, and it disappeared into the noise.
 * `appOverviewData_` touches the ledger, and even warm it did not.
 *
 * So the lower half stays a round trip — which costs ~3,300ms but costs it
 * *after* the balances are on screen, where waiting is survivable.
 *
 * ## Why it may return `null`
 *
 * Any failure returns the string `'null'` and the page falls back to fetching
 * both halves exactly as before. A dashboard that loads slowly beats one that
 * does not load, and this runs inside `doGet` where a throw is a blank page.
 */
function appInlineBoot_() {
  try {
    return withReadCache_(function () {
      return htmlSafeJson_({ open: appOpenData_() });
    });
  } catch (e) {
    Logger.log('inline boot failed, falling back to a fetch: ' + e.message);
    return 'null';
  }
}

/*
  `htmlSafeJson_` used to live here, next to its first caller, and it now has
  two: this payload and the view on the URL, which is built by `webAppHtml_` in
  20. A second copy of an escaping rule is the way an escaping rule gets fixed
  in one place only, so it moved **down** to 20_webapp.gs — the file that owns
  the page it is escaping for, and the one both callers can reach without
  `functionExists_`. Nothing higher may be depended on; 20 is lower, so this is
  the legal direction and the only one available.
*/

/**
 * The filters each screen opens on, defined once and on the server.
 *
 * The page used to hold these. Now that `appOverview` ships the first view of
 * Records and Charts, two copies would decide what "the first view" means and
 * the prefetched payload would silently be for a different slice than the one
 * drawn — a screen that looks loaded and is answering a question nobody asked.
 *
 * They differ on purpose. Charts asks "how is this month going", so it opens on
 * this month. Records is the screen you go to *to find something*, and a ledger
 * that searches only the last few days is not a ledger.
 *
 * Records opens on the **year to date** rather than the trailing twelve months.
 * Both are reaches wide enough to find things in, and the difference is that one
 * of them has an edge you can name: "this year" is the period a person is
 * already thinking in, and a total over it means something. `last_12` is a
 * window that moves under you — the same search run in January and in February
 * covers different months, and neither is a period anyone has an opinion about.
 *
 * Records carries the drill filters at their off values rather than omitting
 * them. Nothing here sets them — they arrive by tapping a number on Charts —
 * but `applyOverview` assigns this object *over* `state.filters.records`
 * wholesale, so a shape short of a key is a shape that can silently drop one.
 */
function appDefaultFilters_() {
  return {
    analytics: { period: { kind: 'mtd' }, account: 'All', label: 'All' },
    records: { period: { kind: 'ytd' }, account: 'All', label: 'All',
      search: '', unconfirmedOnly: false,
      spendOnly: false, incomeOnly: false, category: 'All', subcategory: 'All' }
  };
}

/** Everything on the dashboard that needs the ledger, plus the slower lists. */
function appOverview() {
  return withReadCache_(function () {
    requireOwner_();
    return appOverviewData_();
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
 * The dashboard on its own — for a pull-to-refresh, and after every write.
 *
 * `fresh` is the difference between those two callers and it is not a
 * micro-optimisation. A pull-to-refresh means "I do not believe what is on
 * screen": serving it from a cache would answer a request for fresh data with
 * the same stale answer, and there is no second thing to try, because this *is*
 * the retry. So it passes `true` and the cache goes.
 *
 * A write means nothing of the kind, and this call forgetting the cache on that
 * path was a real bug with a confusing symptom. Confirming a transaction
 * threw away the compacted ledger and rebuilt it from four and a half thousand
 * sheet rows — and confirming three in a row queued three multi-second
 * executions behind each other, which the client bridge eventually gives up on
 * with `http connection failure 0`, an error about the transport that says
 * nothing about the cause. **A write already bumps `transactions_version`**
 * through `writeCell_` and `appendRows_`, which invalidates the cache by
 * construction and cannot be forgotten by a caller. The forget was never doing
 * anything on that path except the expensive part.
 */
function appDashboard(fresh) {
  return withReadCache_(function () {
    requireOwner_();
    if (fresh) forgetLedgerCache_();
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

/**
 * Mark a transaction as a transfer and say which account received the money.
 *
 * The one write in this file that *appends* to `transactions` rather than
 * touching the columns past O — see `webAppLinkTransfer_` for why a cash
 * withdrawal has no other honest answer.
 */
function appMarkTransfer(request) {
  requireOwner_();
  return webAppLinkTransfer_(request);
}

/**
 * Add a categorisation rule, built from a transaction you were looking at.
 *
 * The result says plainly that **nothing already in the book moves**, because
 * the alternative is a feature that reads as broken: you make a rule for a
 * merchant you have seen ten times, go back to the list, and all ten are
 * exactly as they were. The cascade runs on sync, and `frozenVerdict_` holds a
 * confirmed row to whatever it was confirmed with — both deliberate, and
 * neither discoverable from the app.
 */
function appAddRule(rule) {
  requireOwner_();

  var result = webAppAddRule_(rule);
  result.message = 'Rule saved. It applies to new transactions from the next ' +
    'sync — rows already in the book keep the category they have.';
  return result;
}

/**
 * Delete one cash transaction.
 *
 * The only endpoint here that destroys anything, and the message says where the
 * copy went rather than just reporting success. `_removed` is a tab in the same
 * book, so "gone" is recoverable by hand and the person tapping delete on a
 * phone is the one who most needs to know that.
 *
 * No `withReadCache_`, like the other writes: that memo exists to share reads
 * across one read-only request, and sharing it across a write is how a caller
 * gets a stale answer to the question it just changed.
 */
function appDeleteRecord(request) {
  requireOwner_();

  var result = webAppDeleteRecord_(request);
  result.message = 'Deleted. A copy is on the _removed tab.';
  return result;
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
  var open = appOpenData_();
  var overview = appOverviewData_();

  return {
    month: overview.month,
    accounts: open.accounts,
    netWorth: open.netWorth,
    health: overview.health,
    review: overview.review,

    // Computed by the call above whether or not this one passes it on, so
    // leaving it out bought nothing and cost the chart: this payload *replaces*
    // the overview on the page, so every field it omits is a block that was on
    // the screen and now is not. The trend was drawn from the boot and gone
    // after the first confirmation — a chart deleted by the act of ticking a
    // row, with every number around it correct, which reads as a rendering bug
    // three screens away from the code that caused it.
    //
    // Same shape as the `assetAccounts` note below, and the second time this
    // exact omission has been made here. The rule both point at: **a refresh
    // owes the screen every field the first paint gave it**, and a hand-written
    // subset of another payload is where that promise gets quietly broken.
    trend: overview.trend,
    // Pulling to refresh is very often *about* the holds — you tap it because a
    // card payment has not shown up yet. A dashboard that redrew every number
    // except the one you pulled for would be the worst version of this.
    pending: overview.pending,

    // The lists that are made *from* `accounts`, because one of them carries a
    // balance and that balance has just moved.
    //
    // `appOpenData_` has always computed these and this call has always thrown
    // them away, on the reasoning that names change monthly and a refresh is
    // about numbers. True of `accounts` and `cashAccounts`, which are names.
    // False of `assetAccounts`, which carries the balance the "Update balance"
    // screen shows as *currently* and now pre-fills the input with — so after
    // recording 3,000 → 4,500 the tile said 4,500 and the screen you had just
    // come from went on offering 3,000, which reads as the write having done
    // nothing. A list of names and a list of values are different things and
    // only one of them was safe to hold on to.
    lists: open.lists,
    currency: open.currency
  };
}

/**
 * The half that needs no ledger: net worth, the tiles, and the two lists made
 * from the same tab.
 *
 * Reads `accounts`, `_status` and `_config` — about 800ms, against the ~1,600
 * the other half costs. That split is the entire reason the screen is two
 * calls; see `appOpen`.
 */
function appOpenData_() {
  return {
    currency: baseCurrency_(),
    netWorth: netWorthNow_({}),
    accounts: appAccounts_(),
    // Both derived from `accounts`, which this half has already read, so they
    // are free here and would cost a tab read in the other one.
    //
    // **"Accounts" here means the names, and nothing else.** Worth saying
    // because the lists are otherwise stable enough to cache and the tab they
    // come from is not: `accounts` also holds every balance, rewritten on
    // every sync. Reading "the lists change monthly" as "the accounts tab is
    // stable" is how you end up showing last night's net worth as today's.
    lists: {
      accounts: accountNames_(),
      cashAccounts: cashAccountList_(),
      // Carries balances, unlike the other two — see `assetAccountList_`.
      assetAccounts: assetAccountList_()
    },
    generatedAt: dayKey_(dayNumber_(new Date()))
  };
}

/**
 * The half that needs the ledger: the month, the queue, the health banner.
 *
 * One read of the whole tab, which is not what it looks like. This screen
 * draws two months and a short queue, so it briefly read exactly those rows:
 * four narrow columns to decide which they were, then only those rows at full
 * width. The arithmetic was cells transferred — four columns against thirty —
 * and the arithmetic was the wrong model.
 *
 * Measured on the live book at 4,615 rows: the full thirty-column read takes
 * **2,025ms**, and the four single-column reads that were supposed to replace
 * it take **3,678ms between them**. A `getValues` costs roughly the same
 * whether it returns one column or thirty; what it costs is the *call*. Four
 * calls is four times the price for an eighth of the data.
 */
function appOverviewData_() {
  var ledger = readLedger_();
  var now = new Date();
  var window = resolveWindow_({ kind: 'mtd' }, now);
  var previous = lastMonthToDate_(now);

  var month = aggregate_(ledger.filter(function (row) {
    return matchesFilters_(row, { window: window });
  }), window);

  var lastMonth = aggregate_(ledger.filter(function (row) {
    return matchesFilters_(row, { window: previous });
  }), previous);

  var defaults = appDefaultFilters_();
  var records = webAppRecords_(defaults.records, 0);

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

    /*
      Thirty days of net worth, drawn under the total it ends at.

      **In this half and not the other one, because it needs the ledger.** The
      top of the dashboard is the half that reads no transactions — that split
      is what lets net worth and the tiles draw ~1,600ms before the rest — and
      a trend is every row in the book by definition. Sent here, it lands with
      the month and the queue and draws in the same paint.

      It does cost this half one tab read it was not making: `netWorthNow_`
      goes to `accounts`, which nothing else on the overview path touches
      (`runChecks_` reads `_status`, the queue and the records read
      `transactions` and `pending`). The project's own measured figure for a
      read is ~175ms and `withReadCache_` cannot save it, there being nothing
      to share it with. `describeDashboardCost` prices the parts in bootstrap
      order if this ever needs settling rather than estimating.

      **The number under the chart and the number above it are read twice**,
      once here and once in `appOpen`, in two executions running side by side.
      They agree unless a sync lands between them, which is a cosmetic
      disagreement for one refresh — and the alternative was to have the page
      add up the deltas itself against the total it already holds, which buys
      that consistency by moving arithmetic into the one file no test runs.
    */
    trend: {
      days: DASHBOARD_TREND_DAYS,
      series: recentBalanceTrend_(ledger, now, netWorthNow_({}).total)
    },

    // The ledger's length is `lastRecordRow_ - 1` on `transactions`, which is
    // exactly what `checkRowLoss_` would scan the tab to work out. Handing it
    // over takes ~1,900ms off every dashboard — see the note on `runChecks_`.
    health: appHealth_(ledger.length),

    // The holds, for the dashboard, and **a second reference to the same rows
    // rather than a second read** — `webAppRecords_` above has already been to
    // the `pending` tab, and this costs the bytes of a handful of rows.
    //
    // It is sent at the top level and not read off `screens.records` for a
    // reason that only shows up later: `screens` seeds the Records screen, and
    // Records has filters. Filter it to one account and `state.records.pending`
    // becomes that account's holds — correct there, and silently wrong on a
    // dashboard that has no filters and never asked for any. Two consumers with
    // different scopes need two fields, even when today they hold the same rows.
    pending: records.pending,
    review: appReviewQueue_(ledger),
    lists: {
      labels: labelNames_(),
      categories: categoryChoices_(),
      // Handed the rows this function already holds, so naming the years costs
      // one more pass over memory rather than another read of the tab.
      periods: appPeriods_(ledger)
    },

    // The first view of the other two screens, and why the prefetch is back.
    //
    // `appBootstrap` used to carry these and the note above its replacement
    // says why it stopped: each screen called `readLedger_` for itself, so a
    // boot read 4,600 rows three times, twice for screens you might never
    // open. **That reasoning is sound and both of its premises have since
    // stopped being true**, so the conclusion flips — which is worth writing
    // down rather than quietly reversing.
    //
    // The reads are no longer three. `withReadCache_` and the ledger cache
    // mean this function already holds the rows, so a second and third pass
    // over them is aggregation, measured at ~10ms.
    //
    // And the discarded half of that argument — "the cost here is not round
    // trips" — has been measured and is false. A `google.script.run` call
    // costs **~3,300ms before any of our code runs**: `appOpen` returns 1.1KB
    // after ~800ms of work and takes 3,503ms, and once took 8,692ms. Round
    // trips are very nearly the *only* cost.
    //
    // **Records only, and that was measured rather than assumed.** The first
    // version carried Charts too, on an estimate of "~10ms for both" that was
    // wrong by two orders of magnitude. Timed against the live app, best of
    // two, with `appOpen` as the fixed round-trip floor:
    //
    //     appOpen ......... 2,981ms ...  1KB ... the floor
    //     appRecords ...... 2,225ms ... 33KB ... below it — free
    //     appAnalytics .... 3,045ms ...  2KB ... ~800ms of work
    //
    // Records is a filter, a sort and a slice over rows already in memory.
    // Charts is `balanceSeries_` walking the whole ledger, and it would cost
    // that ~800ms on *every* open to save a trip on a screen that is not
    // opened every time — which is the owner's own account of how this is
    // used: the dashboard always, the charts sometimes.
    //
    // A filter change still fetches, on both screens. That is the case that
    // genuinely needs a trip.
    screens: {
      filters: defaults,
      records: records
    }
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
    .sort(function (a, b) {
      var byKind = accountKindRank_(a.kind) - accountKindRank_(b.kind);
      return byKind || (b.balance || 0) - (a.balance || 0);
    });
}

/**
 * Where an account's kind sits in the dashboard's list: bank, then cash, then
 * assets, and balance decides the order inside each group.
 *
 * Grouped rather than one balance ranking because the three kinds answer
 * different questions — what the banks say, what I counted, what I estimated —
 * and interleaving them by size puts a flat asset valuation between two current
 * accounts, which reads as a sync having lost one of them.
 *
 * The order comes from `ACCOUNT_KINDS` rather than a list written out here, so
 * the vocabulary and its ranking cannot become two lists. A kind that is not in
 * it sorts last: `indexOf` gives -1, and this maps that to the end rather than
 * to the front, where an empty `kind` cell would otherwise land above the banks.
 */
function accountKindRank_(kind) {
  var rank = ACCOUNT_KINDS.indexOf(String(kind || ''));
  return rank === -1 ? ACCOUNT_KINDS.length : rank;
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
  var peers = transferPeers_(ledger);

  return ledger
    .filter(function (row) { return !isConfirmedRow_(row); })
    .sort(function (a, b) {
      return dateOrder_(a.booking_date) - dateOrder_(b.booking_date);
    })
    .slice(0, queueSize_())
    .map(function (row) { return recordForPage_(row, peers); });
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

  // The boolean test is the same one `splitLabels_` makes and for the same
  // reason — see the note there. It is spelled out rather than delegated
  // because that function splits on commas, and a label is one name: routing
  // through it would quietly truncate `Bills, utilities` to `Bills`, trading a
  // visible bug for an invisible one.
  return readRecords_(sheet, LABEL_COLUMNS)
    .filter(function (row) {
      return !isBlankCell_(row.label) && typeof row.label !== 'boolean';
    })
    .map(function (row) { return String(row.label); });
}

// ---------------------------------------------------------------------------
// What the first screen costs
// ---------------------------------------------------------------------------

/**
 * Where the seconds go when the app opens, measured part by part in one run.
 *
 * **Timing the ledger read alone cannot answer this**, and it is the tempting
 * thing to time because it is the biggest single read. The dashboard reads
 * `transactions` once and then reads `_config`, `accounts`, `_status`, `_runs`,
 * `categories` and `labels` a dozen more times between them, and none of those
 * go through the ledger cache. A cache that works perfectly and a dashboard
 * that is still slow are entirely compatible, and telling them apart needs the
 * parts named.
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

  // Before anything is dropped: was a ledger still cached from the last time
  // the app was opened? Everything below this line destroys the evidence, so
  // it is the first thing measured. Run this, use the app, come back to it ten
  // minutes later — `cacheWarmOnEntry` is the only number that says whether
  // the six-hour TTL is doing what it was raised to do.
  var onEntry = ledgerCacheState_();

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

    // Was it warm before this ran? `ledgerFirst` cannot say — it is forced.
    cacheWarmOnEntry: onEntry.cached,
    cacheChunksOnEntry: onEntry.chunks,
    cacheChunksPresent: onEntry.present,
    dataVersion: onEntry.version,

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

    // The two calls the page makes, warm. They run in parallel in the browser,
    // so what the screen waits for is `openMs` for its top and `overviewMs`
    // for the rest — not the sum, which is what a sequential reading of this
    // would suggest and what the old single number actually was.
    openMs: at(appOpen),
    overviewMs: at(appOverview)
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
  report.bootstrapMs = report.openMs + report.overviewMs;
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
    'Cache on entry: ' + (onEntry.cached
      ? onEntry.present + ' of ' + onEntry.chunks + ' chunks, version ' + onEntry.version
      : 'cold, version ' + onEntry.version) +
    '.\nLedger: ' + coldMs + 'ms from ' + coldSource + ', then ' + warmMs + 'ms from ' +
    warmSource + '.\nFirst paint waits ' + report.openMs + 'ms; the rest lands at ' +
    report.overviewMs + 'ms.\nBoth halves total ' + report.bootstrapMs + 'ms, against ' +
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
 *
 * **Every entry carries an `id`, and that is not decoration.** The page used to
 * send `{kind: <the option's value>}` and compare options on `kind` alone,
 * which works only while every entry has a distinct kind. The named years below
 * are all `kind: 'year'` and differ by their `year`, so the old arrangement
 * would have marked all of them selected at once and sent a spec with no year
 * in it. The `id` is the option's identity; the rest of the entry is the spec.
 *
 * **The years come from the ledger** rather than from a count backwards from
 * today, so the list never offers a year with nothing in it — the one thing a
 * period picker must not do, because an empty result from a period you chose is
 * indistinguishable from a filter bug. Newest first, and the current year is
 * skipped: `ytd` already covers it and covers it more honestly.
 */
function appPeriods_(ledger) {
  var periods = [
    { id: 'week', kind: 'week', label: 'This week' },
    { id: 'mtd', kind: 'mtd', label: 'This month' },
    { id: 'last_month', kind: 'last_month', label: 'Last month' },
    // One entry for twelve answers, and that asymmetry is the point. The named
    // years below need one option each because they are the whole choice; a
    // month is *two* choices, and spelling out the product of them would put
    // upwards of a hundred entries in a picker you scroll with a thumb. So this
    // entry says only "a month", and the page draws the twelve — which it can
    // do as a row of chips, side by side and one tap each, where a dropdown
    // costs an open, a scroll and a close. `resolveWindow_` has understood
    // `{kind: 'month', year, month}` since it was written.
    //
    // The label carried an ellipsis, the convention for "this opens something
    // further" — which it does, and which the chips make visible the instant
    // the option is chosen. In a list where every other entry names a period
    // outright it read as an unfinished word rather than as a promise.
    { id: 'month', kind: 'month', label: 'A month' },
    { id: 'ytd', kind: 'ytd', label: 'Year to date' },
    { id: 'last_12', kind: 'last_12', label: 'Last 12 months' }
  ];

  ledgerYears_(ledger).forEach(function (year) {
    periods.push({ id: 'year:' + year, kind: 'year', year: year, label: String(year) });
  });

  periods.push({ id: 'custom', kind: 'custom', label: 'Custom' });
  return periods;
}

/**
 * The calendar years the ledger has rows in, newest first, this one excluded.
 *
 * Reads `booking_date` through `dayNumber_` rather than trusting the cell to be
 * a `Date`: a ledger arriving from the cache has been through JSON and holds
 * ISO strings, and `new Date(...).getFullYear()` on a blank cell is `NaN`,
 * which would put an `id` of `year:NaN` in the picker.
 *
 * Capped, because the list is a dropdown on a phone. Ten years of history is
 * more than this project can have — it cannot see further back than the bank
 * will export — but a corrupt date reading as 1899 is entirely possible, and
 * without a cap one bad cell adds a hundred entries.
 */
function ledgerYears_(ledger) {
  var thisYear = new Date().getFullYear();
  var seen = [];

  (ledger || []).forEach(function (row) {
    var day = dayNumber_(row.booking_date);
    if (day === null) return;

    var year = Number(dayKey_(day).slice(0, 4));
    if (!year || year >= thisYear) return;
    if (seen.indexOf(year) === -1) seen.push(year);
  });

  return seen.sort(function (a, b) { return b - a; }).slice(0, 10);
}
