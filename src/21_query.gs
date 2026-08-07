/**
 * 21_query.gs — the ledger, asked a question.
 *
 * The engine behind the mobile app's Records and Analytics pages. Everything
 * here is a plain function over plain rows: no formulas, and **no writes.**
 * That last one is the point of the whole file, and it is worth stating before
 * anything else. Two tabs are read — `transactions` and `accounts` — and
 * nothing on either is touched.
 *
 * ## Why not drive the `reports` tab
 *
 * There is already a filtering UI in this book — six dropdowns and one QUERY —
 * and the obvious implementation is to write the filters into `B3:B8`, call
 * `flush()`, and read the answer back. It was rejected on three counts, in
 * order of severity:
 *
 *   1. **It is a write.** Every filter change would mutate shared state. The
 *      desktop `reports` tab would shift under whoever was looking at it, and
 *      two devices could not both use the app. Read-only is a property worth
 *      protecting.
 *   2. **`flush()` is the slow part.** Recalculating fifty array formulas is
 *      not obviously cheaper than a JS loop, which is microseconds over 4,600
 *      rows.
 *   3. **Another derived tab is another set of anchors that can stop
 *      spilling** — the failure mode this project has spent whole sessions on.
 *
 * ## Why the aggregation happens on the server
 *
 * The rule is **precompute what is fixed, compute what is variable.** The
 * dashboard asks the same questions every time, so formulas already answer them
 * and the page just reads a block of cells. Analytics assembles its question at
 * runtime from date × account × label — an unbounded space no formula can be
 * waiting on.
 *
 * Shipping the whole ledger to the browser and filtering there works *today*:
 * a transaction compacted for charting is about 30 bytes, so 4,600 rows is
 * ~140KB. It is still the wrong design, because that number only grows. This
 * book accumulates forever, and 25,000 rows is 750KB re-downloaded on every
 * open. Aggregating here makes the payload the size of **the answer**, which
 * never grows: three totals, thirty category rows, and two series.
 *
 * It also deleted a whole mechanism. Filtering in the browser would have needed
 * a shared file the test harness could load too, since anything inside a page
 * is invisible to `node:vm`. On this side it is ordinary `.gs`, tested like
 * everything else — which is why almost every function below is pure.
 *
 * ## Dates do not survive the trip
 *
 * `google.script.run` serialises its return value, and a real `Date` does not
 * come out the other side as one. So every date leaving this file is a
 * `yyyy-MM-dd` string, produced once at the boundary by `dayKey_`. Inside, they
 * are day numbers — days since the epoch — because that is the only
 * representation in which "is this row in the window" and "which bucket is it
 * in" are both integer comparisons, with no timezone in the way.
 */

/** Rows a Records page hands back at a time. 4,600 DOM nodes was never an idea. */
var QUERY_PAGE_SIZE = 100;

/** Rows in a grouped block. A chart of 400 merchants is a smear. */
var QUERY_GROUP_LIMIT = 30;

/**
 * Above this many days, the cashflow series is monthly rather than daily.
 *
 * Two months of daily bars is readable on a phone; a year of them is 365 marks
 * on a 360-pixel screen, which is a texture rather than a chart. The threshold
 * is a property of the screen, not of the data, so it lives here rather than
 * being asked of the caller.
 */
var QUERY_DAILY_MAX_DAYS = 62;

var MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

/**
 * A date as a day number — whole days since 1970-01-01, in local terms.
 *
 * Built from the calendar fields rather than from `getTime() / MS_PER_DAY`,
 * because the second one is a UTC question. A booking date is midnight local,
 * and east of Greenwich in summer that is 22:00 the previous day in UTC —
 * which puts every transaction on the 1st of a month into the previous month,
 * silently, for exactly the people this book was written for.
 *
 * `Date.UTC` on the local fields is the standard way to say "I want the
 * calendar day, not the instant".
 */
function dayNumber_(value) {
  var date = toDate_(value);
  if (!date) return null;
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / MS_PER_DAY);
}

/** A day number back to a `yyyy-MM-dd` string, which is what crosses the wire. */
function dayKey_(day) {
  if (day === null || day === undefined) return '';
  var date = new Date(day * MS_PER_DAY);
  return date.getUTCFullYear() + '-' +
    pad2_(date.getUTCMonth() + 1) + '-' + pad2_(date.getUTCDate());
}

/** The `yyyy-MM` a day number falls in. */
function monthKey_(day) {
  return dayKey_(day).slice(0, 7);
}

function pad2_(n) {
  return n < 10 ? '0' + n : String(n);
}

/**
 * A cell that may hold a Date, a string, or nothing, as a Date or null.
 *
 * A cell is not a date just because it parses as one: `new Date('')` is Invalid
 * Date and `new Date(0)` is 1970, and both would otherwise become a real day
 * number and land a phantom transaction at one end of every window.
 */
function toDate_(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (isBlankCell_(value)) return null;

  var parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * A cell as a number, or null — never as zero.
 *
 * `Number('')` is 0 and `isFinite(0)` is true, so the obvious guard passes and
 * a blank `amount_base` — which is what a non-EUR row has, deliberately —
 * would count as a real zero-euro transaction in every total. This is the fifth
 * place in the project that rule has had to be written down.
 */
function cellNumber_(value) {
  if (isBlankCell_(value)) return null;
  var number = Number(value);
  return isFinite(number) ? number : null;
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/**
 * A period specification to a pair of day numbers, inclusive at both ends.
 *
 * Pure JS arithmetic rather than a lookup into `REPORT_PERIODS`, and the two
 * are not duplicates of each other: that table holds *Sheets expressions*
 * — `EOMONTH(TODAY(),-1)+1` — so the labels are reusable here and the
 * arithmetic is not. Sharing the labels is what keeps the phone and the
 * `reports` tab calling the same period by the same name.
 *
 * The kinds, and what each one is for:
 *
 *   `mtd`         this month so far. The default, and the only one that moves.
 *   `last_month`  the whole of the month before this one.
 *   `month`       a named month: `{year, month}`, with month 1-12.
 *   `year`        a named year: `{year}`.
 *   `last_12`     the twelve months ending today, for a trend.
 *   `custom`      `{from, to}`, whatever they say.
 *
 * An unrecognised kind resolves to `mtd` rather than throwing. This runs behind
 * a web request, where a throw is a blank screen and the honest fallback is the
 * default the page opened on.
 *
 * A custom range given backwards is **swapped**, not rejected. Two date pickers
 * on a phone produce that constantly, and an empty result that is really a
 * complaint about the order is the least useful thing this could return.
 */
function resolveWindow_(spec, now) {
  var today = dayNumber_(now);
  var request = spec || {};
  var kind = String(request.kind || 'mtd');

  if (kind === 'custom') {
    var from = dayNumber_(request.from);
    var to = dayNumber_(request.to);
    if (from === null && to === null) return monthToDate_(now, today);
    if (from === null) from = to;
    if (to === null) to = today;
    return from <= to
      ? { kind: kind, from: from, to: to }
      : { kind: kind, from: to, to: from };
  }

  if (kind === 'last_month') {
    var first = startOfMonth_(now.getFullYear(), now.getMonth());
    return { kind: kind, from: addMonths_(first, -1), to: first - 1 };
  }

  if (kind === 'month') {
    var year = Number(request.year) || now.getFullYear();
    var month = Number(request.month);
    if (!(month >= 1 && month <= 12)) month = now.getMonth() + 1;
    var start = startOfMonth_(year, month - 1);
    return { kind: kind, from: start, to: addMonths_(start, 1) - 1 };
  }

  if (kind === 'year') {
    var y = Number(request.year) || now.getFullYear();
    return { kind: kind, from: startOfMonth_(y, 0), to: startOfMonth_(y + 1, 0) - 1 };
  }

  if (kind === 'last_12') {
    var thisMonth = startOfMonth_(now.getFullYear(), now.getMonth());
    return { kind: kind, from: addMonths_(thisMonth, -11), to: today };
  }

  return monthToDate_(now, today);
}

function monthToDate_(now, today) {
  return { kind: 'mtd', from: startOfMonth_(now.getFullYear(), now.getMonth()), to: today };
}

/** The 1st of a month as a day number. `month` is 0-11, as `Date` has it. */
function startOfMonth_(year, month) {
  return Math.floor(Date.UTC(year, month, 1) / MS_PER_DAY);
}

/**
 * `offset` months from the 1st that `day` falls in.
 *
 * Month arithmetic done on the calendar rather than by adding 30 days, and it
 * always lands on a 1st, so there is no end-of-month clamping question to get
 * wrong: `addMonths_(31 January, 1)` is not asked here, because every caller
 * passes a month start.
 */
function addMonths_(day, offset) {
  var date = new Date(day * MS_PER_DAY);
  return startOfMonth_(date.getUTCFullYear(), date.getUTCMonth() + offset);
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Does this row belong in a spending answer for these filters?
 *
 * Four tests, and the fourth is the one that carries the most:
 *
 *   **`in_reports`** is the single column that decides what counts as
 *   spending. Every report in this book asks it and nothing re-derives the
 *   answer — that is the whole reason the column exists, after six dashboard
 *   blocks each re-deciding it and one of them getting it wrong. Read with
 *   `isTruthyCell_` rather than `=== true`, because a row this reaches through
 *   `readRecords_` may hold a real boolean or the text a formula spilled.
 *
 *   **The label** is `contains`, because `transactions.labels` holds
 *   `kids, travel` as often as it holds one value. Matched against the split
 *   parts rather than as a substring of the whole, so `travel` does not match
 *   `business-travel` — which is the caveat the `labels` tab carries and this
 *   is the one place it can be fixed rather than warned about.
 *
 * `account` is matched on `account_name` rather than `account_id`, because the
 * name is what a phone can offer you a list of. The names are unique in
 * practice and a duplicate would merge two accounts in a report — the same
 * exposure the `reports` tab already has, for the same reason.
 */
function matchesFilters_(row, filters) {
  var want = filters || {};

  if (!isTruthyCell_(row.in_reports)) return false;
  if (!matchesAccount_(row, want)) return false;

  var day = dayNumber_(row.booking_date);
  if (day === null) return false;
  if (want.window && (day < want.window.from || day > want.window.to)) return false;

  if (want.label && want.label !== 'All') {
    if (splitLabels_(row.labels).indexOf(String(want.label)) === -1) return false;
  }
  return true;
}

/** The account test on its own, because the balance trend is not a spending question. */
function matchesAccount_(row, filters) {
  var want = (filters || {}).account;
  if (!want || want === 'All') return true;
  return String(row.account_name || '') === String(want);
}

/** `kids, travel` as `['kids','travel']`, trimmed and without the empties. */
function splitLabels_(value) {
  if (isBlankCell_(value)) return [];
  return String(value).split(',').map(function (part) {
    return part.trim();
  }).filter(function (part) { return part.length > 0; });
}

// ---------------------------------------------------------------------------
// Aggregating
// ---------------------------------------------------------------------------

/**
 * Every block, from one pass over the matched rows.
 *
 * One pass and one return value, so that changing a filter costs a round trip
 * and toggling which blocks are *shown* costs nothing. That is the shape that
 * makes the page feel fast, and it is a decision about the response rather
 * than about the loop — the loop is free either way.
 *
 * **The sign is never in the amount.** `amount_base` is signed, so money out is
 * negative, and `expenses` is reported as a positive number because that is
 * what a bar chart and a sentence both want. The negation happens once, here,
 * rather than in each of the five places that would otherwise do it — the same
 * argument `categorySpendFormula` makes for its extra column.
 *
 * A row whose `amount_base` is blank contributes nothing rather than zero. That
 * is a non-EUR transaction with no rate, and `07_transactions.gs` leaves it
 * blank deliberately: refusing to add it is the honest answer, and
 * `unconvertible` is what says so out loud instead of leaving a total quietly
 * short.
 */
function aggregate_(rows, window) {
  var totals = { expenses: 0, income: 0, net: 0, count: 0, unconvertible: 0 };
  var byCategory = {};
  var bySubcategory = {};
  var childrenOf = {};
  var buckets = {};
  var monthly = window ? spansMoreThan_(window, QUERY_DAILY_MAX_DAYS) : false;

  (rows || []).forEach(function (row) {
    var amount = cellNumber_(row.amount_base);
    if (amount === null) {
      totals.unconvertible++;
      return;
    }

    totals.count++;
    totals.net += amount;
    if (amount < 0) totals.expenses += -amount;
    else totals.income += amount;

    // Only money out is grouped. A refund arriving under Groceries would
    // otherwise show as a category you earned money in, and the net figure is
    // where a refund belongs — the rule `monthByCategoryFormula` already
    // follows on the dashboard.
    if (amount < 0) {
      addTo_(byCategory, row.category, -amount);
      addTo_(bySubcategory, row.subcategory, -amount);
      addUnder_(childrenOf, row.category, row.subcategory, -amount);
    }

    var day = dayNumber_(row.booking_date);
    var key = monthly ? monthKey_(day) : dayKey_(day);
    if (!buckets[key]) buckets[key] = { key: key, expenses: 0, income: 0, net: 0 };
    buckets[key].net += amount;
    if (amount < 0) buckets[key].expenses += -amount;
    else buckets[key].income += amount;
  });

  // Rounded on the way out, like every other number here. The three totals
  // were the ones that escaped it: `expenses` accumulated over three hundred
  // rows is 1.4999999999999903, and the page has no rounding of its own — it
  // renders what it is given, so it rendered that.
  totals.expenses = round2_(totals.expenses);
  totals.income = round2_(totals.income);
  totals.net = round2_(totals.net);

  return {
    totals: totals,
    byCategory: nestedTotals_(byCategory, childrenOf),
    bySubcategory: rankedTotals_(bySubcategory),
    cashflow: filledBuckets_(buckets, window, monthly),
    bucketSize: monthly ? 'month' : 'day'
  };
}

function addTo_(target, name, amount) {
  var key = isBlankCell_(name) ? '(uncategorised)' : String(name);
  target[key] = (target[key] || 0) + amount;
}

/** The same tally, one level down: a subcategory total inside its own parent. */
function addUnder_(target, parent, child, amount) {
  var key = isBlankCell_(parent) ? '(uncategorised)' : String(parent);
  if (!target[key]) target[key] = {};
  addTo_(target[key], child, amount);
}

/**
 * Each category with its own subcategories under it.
 *
 * `byCategory` and `bySubcategory` are two independent groupings of the same
 * rows, which is honest and reads as a contradiction. A row categorised
 * `Food & Drink` with no subcategory counts under Food & Drink in one list and
 * under `(uncategorised)` in the other — so the flat subcategory list shows an
 * enormous uncategorised total sitting next to a small one, and nothing on
 * screen says they are counting different things.
 *
 * Nesting removes the question rather than answering it. `(uncategorised)`
 * appearing *inside* Food & Drink is self-explanatory: those are its rows with
 * no subcategory. The flat list stays for anything that wants a global ranking,
 * but nothing has to read the two side by side and reconcile them.
 *
 * Children are ranked and capped like their parents. A category with one
 * subcategory that is simply itself gets an empty list rather than a row
 * repeating the total above it.
 */
function nestedTotals_(byCategory, childrenOf) {
  return rankedTotals_(byCategory).map(function (entry) {
    var children = rankedTotals_(childrenOf[entry.name] || {});
    return {
      name: entry.name,
      total: entry.total,
      children: children.length === 1 && children[0].total === entry.total ? [] : children
    };
  });
}

/** Biggest first, capped, because a chart of 400 merchants is a smear. */
function rankedTotals_(totals) {
  return Object.keys(totals)
    .map(function (name) { return { name: name, total: round2_(totals[name]) }; })
    .sort(function (a, b) { return b.total - a.total; })
    .slice(0, QUERY_GROUP_LIMIT);
}

/**
 * Every bucket in the window, including the empty ones.
 *
 * A month you spent nothing in is a real answer, and leaving it out makes a
 * line chart join December to February as though January did not happen — the
 * same reason `spendByMonthFormula` emits twelve buckets rather than however
 * many had transactions in them.
 *
 * Bounded, because a `custom` window can be any width and a page that asks for
 * the year 1900 should get a short answer rather than a thousand marks.
 */
function filledBuckets_(buckets, window, monthly) {
  if (!window) return [];

  var out = [];
  var cursor = monthly ? startOfMonthDay_(window.from) : window.from;
  var guard = 0;

  while (cursor <= window.to && guard++ < 400) {
    var key = monthly ? monthKey_(cursor) : dayKey_(cursor);
    out.push(buckets[key] || { key: key, expenses: 0, income: 0, net: 0 });
    cursor = monthly ? addMonths_(cursor, 1) : cursor + 1;
  }

  return out.map(function (bucket) {
    return {
      key: bucket.key,
      expenses: round2_(bucket.expenses),
      income: round2_(bucket.income),
      net: round2_(bucket.net)
    };
  });
}

function startOfMonthDay_(day) {
  var date = new Date(day * MS_PER_DAY);
  return startOfMonth_(date.getUTCFullYear(), date.getUTCMonth());
}

function spansMoreThan_(window, days) {
  return (window.to - window.from) > days;
}

/**
 * Rounded at the boundary, not during the sum.
 *
 * Rounding each addend would drift by a cent per few hundred rows, and a total
 * that is a cent off the one on the dashboard is a total nobody believes again.
 */
function round2_(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// The balance trend
// ---------------------------------------------------------------------------

/**
 * Net worth on each day of the window, derived rather than remembered.
 *
 *   balance_at(d) = balance_now − Σ amount_base booked after d
 *
 * The method `trendValuesFormula` already uses on the dashboard, and it comes
 * with that function's three caveats intact: it is anchored to today, so a
 * missing transaction shifts the whole curve rather than showing a step;
 * non-EUR rows contribute nothing while their balance is in today's total, so
 * those accounts flat-line; and an `asset` balance only moves when you type a
 * new number into it.
 *
 * **This is the one function here that does not filter `in_reports`**, and that
 * is not an oversight. A transfer between your own accounts moves a balance, so
 * it belongs in a net worth series even though it is not spending; a row you
 * excluded from reports still left your account. Net worth is not a spending
 * question, and asking it the spending question is how the curve ends up
 * disagreeing with the number above it.
 *
 * For the same reason it takes **every** row rather than the windowed ones: the
 * sum for the first day of a window in the past needs every transaction between
 * that day and today, which are by definition outside the window.
 */
function balanceSeries_(rows, window, balanceNow) {
  if (!window) return [];

  var after = {};
  (rows || []).forEach(function (row) {
    var amount = cellNumber_(row.amount_base);
    if (amount === null) return;

    var day = dayNumber_(row.booking_date);
    if (day === null) return;
    after[day] = (after[day] || 0) + amount;
  });

  // Walked backwards from today, accumulating as it goes: the alternative is a
  // sum over the whole ledger for each of up to 365 days, which is the one
  // shape here that would actually be slow.
  var today = dayNumber_(new Date());
  var last = Math.min(window.to, today);
  var running = 0;
  var values = {};

  for (var day = last; day >= window.from; day--) {
    values[day] = balanceNow - running;
    running += (after[day] || 0);
  }

  var series = [];
  for (var d = window.from; d <= last; d++) {
    series.push({ key: dayKey_(d), value: round2_(values[d]) });
  }
  return series;
}

/**
 * What every included account is worth today, in the base currency.
 *
 * The same three conditions `netWorthFormula` applies, and the third is the one
 * that is easy to leave out: an account's balance is in **that account's**
 * currency, so adding a CHF pocket into a euro total produces a number that is
 * wrong by whatever the rate is while looking exactly like a right one.
 * `excluded` accounts and non-base ones are counted separately so the page can
 * say what it left out rather than being quietly short.
 */
function netWorthNow_(filters) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  var summary = { total: 0, counted: 0, skipped: 0, currency: baseCurrency_() };
  if (!sheet) return summary;

  readRecords_(sheet, ACCOUNT_COLUMNS).forEach(function (account) {
    if (isBlankCell_(account.account_id)) return;
    if (!isTruthyCell_(account.active)) return;
    if (!matchesAccount_({ account_name: account.name }, filters)) return;

    var balance = cellNumber_(account.balance);
    if (!isTruthyCell_(account.include_in_net_worth) ||
        String(account.currency || '') !== summary.currency ||
        balance === null) {
      summary.skipped++;
      return;
    }
    summary.total += balance;
    summary.counted++;
  });

  summary.total = round2_(summary.total);
  return summary;
}

function baseCurrency_() {
  return String(readConfig_().base_currency || 'EUR');
}

// ---------------------------------------------------------------------------
// The two things a page asks for
// ---------------------------------------------------------------------------

/**
 * Read `transactions` once.
 *
 * The whole cost of a query is this call — roughly 4,600 rows by thirty
 * columns. The loops over it are microseconds. Quotas were checked rather than
 * assumed: Apps Script meters *runtime*, not rows, and the Sheets REST API's
 * 60-reads-a-minute limit does not apply to `SpreadsheetApp`.
 *
 * If this ever stops being fast enough, the remedy is a read-through cache in
 * `CacheService` keyed on the transaction row count — written when a
 * measurement calls for it, not before. `describeQueryCost()` is what takes
 * that measurement.
 */
/**
 * Chunk size, comfortably under the 100KB a single cache key accepts.
 *
 * `putAll` does not fail loudly on an oversized value — it declines to store
 * it — so a chunk over the limit is a cache that silently never hits, which
 * reads as "the cache made no difference" rather than as a bug.
 */
var LEDGER_CACHE_CHUNK = 90000;

/**
 * How long a chunk lives, and why it is not the six-hour maximum.
 *
 * `dataVersion_` catches every write that goes through `appendRows_` or
 * `writeCell_`, which is every write this project makes. What it cannot catch
 * is somebody typing into the tab with the spreadsheet open — `onEdit` covers
 * the review columns, but a paste over a range, an undo, or an edit made from
 * the Sheets mobile app may not fire it.
 *
 * So the TTL is the backstop for the case the counter cannot see, and five
 * minutes is what it costs to be wrong: a desktop edit is invisible to the
 * phone for at most that long. It is also long enough for the win that
 * matters, which is within one sitting — open the app, look at Charts, look at
 * Records, and only the first of those pays for the read.
 */
var LEDGER_CACHE_SECONDS = 300;

/**
 * Read `transactions` once, and preferably not at all.
 *
 * The whole cost of a query is this call — 4,615 rows by thirty columns,
 * measured at **2,025ms** on the live book, against ~500ms for every loop that
 * follows it. Quotas were checked rather than assumed: Apps Script meters
 * runtime, not rows, and the Sheets REST API's 60-reads-a-minute limit does
 * not apply to `SpreadsheetApp`.
 *
 * The cache is a second copy of the ledger, which this project spent a long
 * time refusing to keep on a guess. It is no longer a guess: every screen paid
 * two seconds for the same rows, and `describeQueryCost` is what said so.
 *
 * **The uncached path returns the parse of what it just stored, deliberately.**
 * A cache hit comes back through JSON, where a `Date` is an ISO string; a miss
 * would otherwise hand back real `Date` objects. Two shapes for the same data
 * is the bug that shows up as "it works until it has been open five minutes",
 * so both paths go through the same round trip and there is only one shape.
 * The cost is ~100ms of stringify on a miss, which is the cheapest insurance
 * available against a whole class of bug.
 *
 * Every failure here falls through to reading the sheet. A cache that cannot
 * store, cannot read, or comes back with a hole in it is a slow app; a cache
 * that guesses is a wrong one.
 */
/**
 * Where the last `readLedger_` got its answer: `cache`, `sheet` or `missing`.
 *
 * A global rather than a return value, because every caller would otherwise
 * have to unwrap a pair to get at the rows — twenty call sites paying for one
 * diagnostic. An execution here is single-threaded and lives for one request,
 * so the only thing that can overwrite it is the same request reading again,
 * which is exactly what the diagnostic wants to see.
 *
 * It exists because "the cache made no difference" and "the cache never hits"
 * produce the identical symptom, and no amount of timing distinguishes them.
 */
var LEDGER_SOURCE = '';

function readLedger_() {
  var version = dataVersion_();

  var hit = cachedLedger_(version);
  if (hit) {
    LEDGER_SOURCE = 'cache';
    return hit;
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.TRANSACTIONS);
  if (!sheet) {
    LEDGER_SOURCE = 'missing';
    return [];
  }

  var text = JSON.stringify(readRecords_(sheet, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid')));
  cacheLedger_(version, text);
  LEDGER_SOURCE = 'sheet';
  return JSON.parse(text);
}

/** Chunk keys carry the version, so a bump orphans the old ones and they expire. */
function ledgerCacheKey_(version, part) {
  return 'ledger:' + version + ':' + part;
}

function cachedLedger_(version) {
  try {
    var cache = CacheService.getScriptCache();
    var count = Number(cache.get(ledgerCacheKey_(version, 'n')));
    if (!count || !isFinite(count)) return null;

    var keys = [];
    for (var i = 0; i < count; i++) keys.push(ledgerCacheKey_(version, i));

    var parts = cache.getAll(keys);
    var text = '';
    for (var j = 0; j < count; j++) {
      var part = parts[ledgerCacheKey_(version, j)];
      // Chunks expire independently, so a hole is possible and is a miss —
      // concatenating around one would parse into a shorter ledger that looks
      // entirely valid.
      if (part === null || part === undefined) return null;
      text += part;
    }
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

function cacheLedger_(version, text) {
  try {
    var values = {};
    var count = 0;
    for (var i = 0; i < text.length; i += LEDGER_CACHE_CHUNK) {
      values[ledgerCacheKey_(version, count)] = text.slice(i, i + LEDGER_CACHE_CHUNK);
      count++;
    }
    // Written before the count, so a partial store leaves no `n` to find and
    // the next read misses cleanly instead of chasing chunks that never landed.
    var cache = CacheService.getScriptCache();
    cache.putAll(values, LEDGER_CACHE_SECONDS);
    cache.put(ledgerCacheKey_(version, 'n'), String(count), LEDGER_CACHE_SECONDS);
  } catch (e) {
    // Nothing to do. The next read pays for the sheet, which is what it did
    // before this function existed.
  }
}

/** Drop the current version's chunks, so the next read goes to the sheet. */
function forgetLedgerCache_() {
  try {
    CacheService.getScriptCache().remove(ledgerCacheKey_(dataVersion_(), 'n'));
  } catch (e) {
    // A cache that will not forget still expires on its own.
  }
}

/**
 * Why there is no narrow read here, though there obviously should be.
 *
 * The dashboard draws two months and a short review queue — a few dozen rows
 * out of thousands — so it read four narrow columns to work out which rows it
 * needed and then read only those at full width. Cells transferred fell by
 * about twenty times.
 *
 * It was **93% slower**, measured on the live book at 4,615 rows:
 *
 *     one 30-column read ..................... 2,025ms
 *     four 1-column reads .................... 3,678ms
 *     plus the 20 rows it then wanted ........   238ms
 *
 * A `getValues` costs about the same whether it returns one column or thirty.
 * What it costs is the *call* — the round trip into the spreadsheet service —
 * and cells barely register beside it. Four calls is four times the price for
 * an eighth of the data, and no amount of narrowing wins against that.
 *
 * The rule this leaves: **read the tab once and filter in memory.** The loops
 * are ~500ms over 4,600 rows, which is the cheap half of every query here.
 * If this ever needs to be faster the answer is to not make the call at all —
 * see the cache note on `readLedger_` — never to make more, smaller ones.
 *
 * `git log -- src/21_query.gs` for `ledgerIndex_` and `readLedgerRows_`.
 */

/**
 * Everything the Analytics page draws, for one set of filters.
 *
 * Called from the page through `google.script.run`, so the return value has to
 * survive serialisation: no `Date`, no undefined, nothing but numbers, strings
 * and plain objects.
 */
function webAppAnalytics_(filters) {
  var now = new Date();
  var request = filters || {};
  var window = resolveWindow_(request.period, now);
  var scope = { account: request.account, label: request.label, window: window };

  var ledger = readLedger_();
  var matched = ledger.filter(function (row) { return matchesFilters_(row, scope); });

  var result = aggregate_(matched, window);
  var worth = netWorthNow_(scope);

  result.window = { kind: window.kind, from: dayKey_(window.from), to: dayKey_(window.to) };
  result.balance = balanceSeries_(
    ledger.filter(function (row) { return matchesAccount_(row, scope); }),
    window, worth.total);
  result.netWorth = worth;
  result.currency = worth.currency;
  return result;
}

/**
 * One page of the ledger, newest first.
 *
 * Filtered and paged **here** rather than in the browser, for the same reason
 * everything else in this file is: the page is a fixed size and the ledger is
 * not. `total` is sent alongside so the page can say "100 of 812" rather than
 * discovering the end by running out.
 *
 * Sorted by booking date descending, and by row descending within a day.
 * `transactions` is append-only and never sorted, so row order *is* insert
 * order — which for two transactions on the same day is the only thing that
 * distinguishes them, and reversing it puts the one you just typed at the top
 * where you are looking for it.
 */
function webAppRecords_(filters, offset) {
  var now = new Date();
  var request = filters || {};
  var window = resolveWindow_(request.period, now);
  var scope = { account: request.account, label: request.label, window: window };

  var matched = readLedger_()
    .filter(function (row) { return matchesRecordFilters_(row, scope, request); })
    .sort(function (a, b) {
      var byDate = dayNumber_(b.booking_date) - dayNumber_(a.booking_date);
      return byDate !== 0 ? byDate : b._row - a._row;
    });

  var start = Math.max(0, Math.floor(Number(offset) || 0));
  var page = matched.slice(start, start + QUERY_PAGE_SIZE);

  return {
    rows: page.map(recordForPage_),
    total: matched.length,
    offset: start,
    hasMore: start + page.length < matched.length,
    currency: baseCurrency_(),
    window: { kind: window.kind, from: dayKey_(window.from), to: dayKey_(window.to) }
  };
}

/**
 * The records list is the one place `in_reports` must **not** be the gate.
 *
 * Every other block here answers "what did I spend", where a transfer and an
 * excluded row are noise. This one answers "what is in my ledger", and a row
 * you cannot find in the list you use to look things up is a row you conclude
 * was never imported. `search` is what a phone actually reaches for, so it is
 * here rather than being a filter you have to set.
 */
function matchesRecordFilters_(row, scope, request) {
  if (!matchesAccount_(row, scope)) return false;

  var day = dayNumber_(row.booking_date);
  if (day === null) return false;
  if (day < scope.window.from || day > scope.window.to) return false;

  if (scope.label && scope.label !== 'All') {
    if (splitLabels_(row.labels).indexOf(String(scope.label)) === -1) return false;
  }

  if (request.unconfirmedOnly && isConfirmedRow_(row)) return false;

  var search = String(request.search || '').trim().toLowerCase();
  if (!search) return true;

  return [row.description, row.counterparty, row.category, row.subcategory, row.labels]
    .some(function (field) {
      return String(field == null ? '' : field).toLowerCase().indexOf(search) !== -1;
    });
}

/**
 * One row, compacted for the wire.
 *
 * `uid` is here because it is what a confirmation is addressed to — the same
 * pointer the `review` tab carries, and for the same reason: a list re-sorts
 * under you and a position does not survive that.
 */
function recordForPage_(row) {
  return {
    uid: String(row.uid || ''),
    date: dayKey_(dayNumber_(row.booking_date)),
    account: String(row.account_name || ''),
    description: String(row.description || row.counterparty || ''),
    amount: cellNumber_(row.amount_base),
    rawAmount: cellNumber_(row.amount),
    currency: String(row.currency || ''),
    category: String(row.category || ''),
    subcategory: String(row.subcategory || ''),
    labels: splitLabels_(row.labels),
    type: String(row.type || ''),
    source: String(row.category_source || ''),
    confirmed: isConfirmedRow_(row),
    inReports: isTruthyCell_(row.in_reports)
  };
}

// ---------------------------------------------------------------------------
// What it costs
// ---------------------------------------------------------------------------

/**
 * Time the read on the live book, rather than assuming it.
 *
 * The design above rests on one measurement — that reading the ledger is fast
 * enough to do on every filter change — and that measurement cannot be taken
 * in the harness, which has no spreadsheet behind it. So it is taken here, on
 * the book that matters, with the row count next to it so the answer means
 * something as the book grows.
 *
 * If `readMs` goes much past a second, the remedy is a read-through cache: the
 * compacted ledger in `CacheService`, chunked at 100KB a key and invalidated on
 * the row count, so only the first query after a sync pays for the read. Not
 * written yet, deliberately — it is a second copy of the ledger, and this
 * project does not keep one of those on a guess.
 */
function describeQueryCost() {
  var startedRead = Date.now();
  var ledger = readLedger_();
  var readMs = Date.now() - startedRead;

  var startedQuery = Date.now();
  var analytics = webAppAnalytics_({ period: { kind: 'mtd' } });
  var queryMs = Date.now() - startedQuery;

  // Where a cache miss actually goes.
  //
  // The miss got 4.6x more expensive than the plain read it replaced — 2,025ms
  // to 9,418ms — and "the cache write is slow" is not a finding, it is four
  // candidates wearing one number: reading the sheet, serialising 4,600
  // records, handing ~1.4MB to CacheService in chunks, and parsing it back.
  // Guessing which one has already cost this project two reverts, so each is
  // timed separately and the answer is read rather than assumed.
  var probe = 'probe-' + Date.now();
  var sheetStart = Date.now();
  var probeSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.TRANSACTIONS);
  var records = probeSheet
    ? readRecords_(probeSheet, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'))
    : [];
  var sheetMs = Date.now() - sheetStart;

  var serialiseStart = Date.now();
  var text = JSON.stringify(records);
  var serialiseMs = Date.now() - serialiseStart;

  var storeStart = Date.now();
  cacheLedger_(probe, text);
  var storeMs = Date.now() - storeStart;

  var parseStart = Date.now();
  JSON.parse(text);
  var parseMs = Date.now() - parseStart;

  var fetchStart = Date.now();
  cachedLedger_(probe);
  var fetchMs = Date.now() - fetchStart;

  var report = {
    rows: ledger.length,
    readMs: readMs,
    fullQueryMs: queryMs,
    matchedThisMonth: analytics.totals.count,
    unconvertible: analytics.totals.unconvertible,

    cachedBytes: text.length,
    chunks: Math.ceil(text.length / LEDGER_CACHE_CHUNK),
    sheetMs: sheetMs,
    serialiseMs: serialiseMs,
    storeMs: storeMs,
    parseMs: parseMs,
    fetchMs: fetchMs,
    missMs: sheetMs + serialiseMs + storeMs + parseMs,

    // What the cache costs to fill, against what the read costs anyway.
    cacheOverheadMs: serialiseMs + storeMs + parseMs,
    verdict: (serialiseMs + storeMs + parseMs) * 4 < sheetMs
      ? 'The cache earns its place: filling it costs a fraction of the read, ' +
        'and every read after it is a fetch.'
      : 'The cache costs a real share of the miss. Compare it against how many ' +
        'hits a session actually gets before the TTL expires.'
  };

  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'web app query cost', report);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    report.rows + ' rows read in ' + readMs + 'ms; a full month-to-date query took ' +
    queryMs + 'ms.\n\nA miss costs ' + report.missMs + 'ms: sheet ' + sheetMs +
    ', serialise ' + serialiseMs + ', store ' + storeMs + ', parse ' + parseMs +
    '.\nA hit costs ' + fetchMs + 'ms over ' + report.chunks + ' chunks (' +
    Math.round(text.length / 1024) + 'KB).', 'Query cost', 30);

  return report;
}
