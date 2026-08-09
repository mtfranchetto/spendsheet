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
 *   `week`        this week so far, Monday to today.
 *   `mtd`         this month so far. The default, and the only one that moves.
 *   `last_month`  the whole of the month before this one.
 *   `month`       a named month: `{year, month}`, with month 1-12.
 *   `ytd`         1 January to today.
 *   `year`        a named year: `{year}` — the whole of it, ending 31 December.
 *   `last_12`     the twelve months ending today, for a trend.
 *   `custom`      `{from, to}`, whatever they say.
 *
 * **`ytd` and `year` are not the same question and that is why both exist.**
 * `year` runs to 31 December, so asking it about *this* year includes months
 * that have not happened. For an aggregate that is harmless — there are no rows
 * in the future — but the label is a lie, and it stops being harmless the
 * moment anything divides by the length of the window. `ytd` is the one the
 * picker offers for the current year; `year` is what the named years use.
 *
 * The week starts on **Monday**, which is the ISO week and the one this book's
 * owner lives in. `getDay()` counts from Sunday, so the conversion is
 * `(day + 6) % 7` rather than a subtraction that reads more obviously and is
 * wrong every Sunday.
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

  if (kind === 'week') {
    // Monday of the week `today` falls in. `getDay()` is 0 for Sunday, so
    // `(d + 6) % 7` maps Monday→0 … Sunday→6 without a special case.
    return { kind: kind, from: today - ((now.getDay() + 6) % 7), to: today };
  }

  if (kind === 'ytd') {
    return { kind: kind, from: startOfMonth_(now.getFullYear(), 0), to: today };
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

/**
 * The account test on its own, because the balance trend is not a spending
 * question.
 *
 * Takes **either a name or a list of them**, and the list is what the phone
 * sends: `<select multiple>` is unusable on a touch screen, so the filter is a
 * row of chips and several can be on at once. The single-string form is kept
 * rather than migrated because `netWorthNow_` and `balanceSeries_` pass filter
 * objects straight through, and a signature that quietly stopped accepting a
 * string would fail as "the net worth chart is empty" a long way from here.
 *
 * An empty list means the same as `All`. It is what you get by turning the last
 * chip off, and the honest reading of that gesture is "stop filtering" — the
 * alternative is a screen that goes blank and looks broken.
 */
function matchesAccount_(row, filters) {
  var want = (filters || {}).account;
  if (!want || want === 'All') return true;

  var name = String(row.account_name || '');
  if (!Array.isArray(want)) return name === String(want);
  if (!want.length || want.indexOf('All') !== -1) return true;

  return want.some(function (entry) { return String(entry) === name; });
}

/**
 * `kids, travel` as `['kids','travel']`, trimmed and without the empties.
 *
 * **A boolean is not a label, and `isBlankCell_` will not tell you that.** That
 * helper is deliberate about `false` — a cleared checkbox is a real answer, and
 * a column of them must not read as unanswered — but this column has no
 * checkboxes in it, so a boolean here is a cell that came from somewhere else:
 * an import mapping an absent CSV field, a formula returning FALSE rather than
 * `""`. `String(false)` is `'false'`, which is five characters and a perfectly
 * good label as far as everything downstream is concerned.
 *
 * It showed up as a fourth chip called **false**, already selected, in a sheet
 * offering three real labels — and it was not only cosmetic. `normalizeLabels_`
 * calls this on the way *in*, so confirming that row would have written the
 * word back into the cell, turning a stray boolean into a real label that the
 * `labels` tab would then count and total. The same rule as blank amounts, one
 * type over: test the input, because the output is indistinguishable from a
 * legitimate one.
 */
function splitLabels_(value) {
  if (isBlankCell_(value) || typeof value === 'boolean') return [];
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

/**
 * The name a category or subcategory is tallied under, blanks included.
 *
 * A helper rather than the ternary it replaces, because this string is now an
 * *address* as well as a label: `matchesRecordFilters_` takes a group name back
 * from the page and has to find the same rows the tally counted. Two copies of
 * the rule would agree until one of them changed, and the failure is silent —
 * drilling into `(uncategorised)` would return an empty list, which is exactly
 * what a category with nothing in it looks like.
 */
function groupKey_(name) {
  return isBlankCell_(name) ? '(uncategorised)' : String(name);
}

function addTo_(target, name, amount) {
  var key = groupKey_(name);
  target[key] = (target[key] || 0) + amount;
}

/** The same tally, one level down: a subcategory total inside its own parent. */
function addUnder_(target, parent, child, amount) {
  var key = groupKey_(parent);
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
 * How long a chunk lives, and why it is now the six-hour maximum.
 *
 * **This was 300, and the reasoning that set it there was sound and still
 * produced the wrong number.** It ran: `dataVersion_` catches every write
 * through `appendRows_` or `writeCell_`, which is every write this project
 * makes; what it cannot catch is somebody typing into `transactions` with the
 * sheet open; so let the TTL be the backstop, and five minutes is a cheap
 * amount to be wrong by.
 *
 * What that missed is how the app is used. A hit needs two opens **inside five
 * minutes**, and nobody opens their finances twice in five minutes — so the
 * measured reality was `ledgerFirst: "sheet"` on run after run, a 4.3-second
 * read on effectively every open, and a cache that was only ever exercised by
 * navigating between screens in one sitting. The backstop was doing the work
 * of the invalidation, and it cost the whole benefit.
 *
 * So the hole got closed at the source instead: `onEdit` now bumps the version
 * on any edit to `transactions`, so a typed category invalidates the cache the
 * same way a synced row does. What is left is only what a simple trigger does
 * not see at all — a script outside this project, or a client that does not
 * fire `onEdit` — and for that the answer is not a short TTL but the refresh
 * the app already has: `appDashboard()` forgets the cache, because its whole
 * meaning is "I do not believe what is on screen".
 *
 * Six hours is `CacheService`'s maximum. It is also longer than the interval
 * between opening this app and opening it again, which is the entire point.
 */
var LEDGER_CACHE_SECONDS = 21600;

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

/**
 * Drop a version's chunks, so the next read goes to the sheet.
 *
 * **Removes the chunks, not just the count.** Dropping only `:n` used to be
 * enough on the grounds that orphaned chunks expire by themselves — true at a
 * five-minute TTL and false at six hours, where 3.7MB of unreachable ledger
 * now sits in a cache that evicts under pressure. The thing it would evict is
 * the ledger that is still being used.
 *
 * `:n` goes first regardless, so a reader arriving mid-removal misses cleanly
 * rather than finding a count and then a hole.
 */
function forgetLedgerCache_(version) {
  try {
    var cache = CacheService.getScriptCache();
    var key = version === undefined ? dataVersion_() : version;
    var count = Number(cache.get(ledgerCacheKey_(key, 'n')));

    cache.remove(ledgerCacheKey_(key, 'n'));
    if (!count || !isFinite(count)) return;

    var keys = [];
    for (var i = 0; i < count; i++) keys.push(ledgerCacheKey_(key, i));
    cache.removeAll(keys);
  } catch (e) {
    // A cache that will not forget still expires on its own.
  }
}

/**
 * Whether a ledger is cached right now, without fetching one.
 *
 * The diagnostic drops the cache before it measures, so `ledgerFirst` is a
 * guaranteed miss by construction and can never answer "was it still there
 * from my last open" — which is the only question a TTL change raises. This
 * answers it, and reports enough to tell the three failure modes apart:
 *
 * - `cached: false` with an unchanged `version` — it expired or was evicted.
 * - `cached: false` with a *changed* `version` — something wrote to
 *   `transactions` between the two opens and correctly invalidated it.
 * - `cached: true` but `present < chunks` — chunks expire independently, so
 *   the ledger is unreadable and every read is a miss that looks like a hit.
 *
 * That third one is why this counts rather than trusting `:n`. At 4,615 rows
 * the ledger is 3.7MB over 42 keys, and `CacheService` evicts under pressure.
 */
function ledgerCacheState_() {
  try {
    var cache = CacheService.getScriptCache();
    var version = dataVersion_();
    var count = Number(cache.get(ledgerCacheKey_(version, 'n')));
    if (!count || !isFinite(count)) {
      return { version: version, cached: false, chunks: 0, present: 0 };
    }

    var keys = [];
    for (var i = 0; i < count; i++) keys.push(ledgerCacheKey_(version, i));

    var parts = cache.getAll(keys);
    var present = 0;
    keys.forEach(function (key) {
      if (parts[key] !== null && parts[key] !== undefined) present++;
    });

    return { version: version, cached: true, chunks: count, present: present };
  } catch (e) {
    return { version: 'unreadable', cached: false, chunks: 0, present: 0 };
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

  var ledger = readLedger_();
  var matched = ledger
    .filter(function (row) { return matchesRecordFilters_(row, scope, request); })
    .sort(function (a, b) {
      var byDate = dayNumber_(b.booking_date) - dayNumber_(a.booking_date);
      return byDate !== 0 ? byDate : b._row - a._row;
    });

  var start = Math.max(0, Math.floor(Number(offset) || 0));
  var page = matched.slice(start, start + QUERY_PAGE_SIZE);

  // Built from the **whole** ledger and not from `matched`. The other leg of a
  // transfer is on a different account by definition, so an account filter is
  // exactly the case that would hide it — and "moved to somewhere" is the one
  // answer this must not give when it knows the name.
  var peers = transferPeers_(ledger);

  return {
    rows: page.map(function (row) { return recordForPage_(row, peers); }),
    total: matched.length,
    offset: start,
    hasMore: start + page.length < matched.length,
    // A separate list, deliberately. See `pendingForPage_`.
    //
    // Dropped entirely on a drill, and that is the one case where these rows
    // would mislead rather than inform. `pending` carries `TX_COLUMNS_CODE`
    // only — no `category`, no `amount_base`, no `in_reports` — so a hold can
    // never be one of the rows a tapped total was made of. Drawn above a list
    // whose whole promise is that it adds up, it is the row that breaks it.
    pending: start === 0 && !isDrilled_(request) ? pendingForPage_(scope, request) : [],
    currency: baseCurrency_(),
    window: { kind: window.kind, from: dayKey_(window.from), to: dayKey_(window.to) }
  };
}

/**
 * The holds a bank has placed but not settled, for the top of the records list.
 *
 * These live on their own tab and always have. `pending` carries
 * `TX_COLUMNS_CODE` only — A–O, no `amount_base`, no `category`, no
 * `in_reports`, no `confirmed` — because a pending authorisation has no stable
 * identity: the amount, the date and the description all change on the way to
 * being booked, and `entry_reference` is booked-only. `rewritePending_` throws
 * the tab away and rewrites it on every sync for exactly that reason.
 *
 * **Returned beside `rows` rather than merged into them**, which is the whole
 * shape of this. `total`, `offset` and `hasMore` are paging arithmetic over the
 * ledger; interleaving rows that are not in the ledger would make the count
 * disagree with the list and the second page skip whatever the first page's
 * pending rows displaced. They are also never *many* — a handful of holds — so
 * there is nothing to page.
 *
 * Sent only with the first page, because they are drawn once at the top and
 * "load more" appending them again is the obvious bug.
 *
 * `amount` is the raw signed amount and not a base-currency figure, because
 * `amount_base` is a formula on `transactions` and there is none here. On a
 * foreign-currency hold that means the number shown is the one the bank sent,
 * which is the honest answer — converting it here would invent a rate.
 */
function pendingForPage_(scope, request) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.PENDING);
  if (!sheet) return [];

  return readRecords_(sheet, PENDING_COLUMNS, colIndex_(PENDING_COLUMNS, 'uid'))
    .filter(function (row) {
      if (!matchesAccount_(row, scope)) return false;

      /*
        The window test, and it is not the one a row gets.

        This used to skip it entirely, on the grounds that a hold is by
        definition recent and by definition not yet dated the way it will be
        once it books — so filtering it out of "last 12 months" on a date the
        bank has not finalised would hide the rows this exists to show. Sound
        for a window that reaches the present, and plainly wrong for one that
        does not: a view of March 2024 drew this morning's holds above a list of
        two-year-old transactions, under a heading and a count that did not
        include them.

        So the test is on the *window* rather than on the row. A window that
        contains today is one where a hold belongs whatever date the bank has
        put on it, and it keeps the original reasoning intact — which covers
        every default and every current period. A window that ended in the past
        is a deliberate look backwards, and a hold placed this week is not part
        of the answer.
      */
      if (!windowReachesToday_(scope.window) && !inWindow_(row.booking_date, scope.window)) {
        return false;
      }

      var search = String((request || {}).search || '').trim().toLowerCase();
      if (!search) return true;

      return [row.description, row.counterparty].some(function (field) {
        return String(field == null ? '' : field).toLowerCase().indexOf(search) !== -1;
      });
    })
    .sort(function (a, b) {
      return (dayNumber_(b.booking_date) || 0) - (dayNumber_(a.booking_date) || 0);
    })
    .map(function (row) {
      return {
        uid: String(row.uid || ''),
        date: dayKey_(dayNumber_(row.booking_date)),
        account: String(row.account_name || ''),
        description: String(row.description || row.counterparty || ''),
        amount: cellNumber_(row.amount),
        currency: String(row.currency || ''),
        pending: true
      };
    });
}

/** Does this window still include today? See `pendingForPage_`. */
function windowReachesToday_(window) {
  if (!window) return true;
  return dayNumber_(new Date()) <= window.to;
}

/** Is this date inside the window? Blank dates are outside it. */
function inWindow_(value, window) {
  if (!window) return true;

  var day = dayNumber_(value);
  if (day === null) return false;
  return day >= window.from && day <= window.to;
}

/**
 * The records list is the one place `in_reports` must **not** be the gate —
 * unless the list was reached by tapping a number, which is what `spendOnly` is.
 *
 * Every other block here answers "what did I spend", where a transfer and an
 * excluded row are noise. This one answers "what is in my ledger", and a row
 * you cannot find in the list you use to look things up is a row you conclude
 * was never imported. `search` is what a phone actually reaches for, so it is
 * here rather than being a filter you have to set.
 *
 * **`spendOnly` exists so that a list reached from a total adds up to it.** The
 * three drill filters are set by tapping the Spending card or a category bar on
 * Charts, and a drill whose list disagrees with the figure that opened it is
 * worse than no drill: the number and the rows are both plausible and only one
 * of them can be right. So the test here is `matchesFilters_`'s `in_reports`
 * gate plus `aggregate_`'s money-out rule, in that order and for those reasons —
 * including the blank `amount_base`, which `aggregate_` counts as `unconvertible`
 * and leaves out of `expenses` rather than treating as zero.
 *
 * `category` and `subcategory` go through `groupKey_`, the same function the
 * tally keys its buckets with, so `(uncategorised)` addresses the rows it
 * counted. They arrive as a *pair* for a subcategory drill: a child name is
 * unique per parent by construction, but `(uncategorised)` is the bucket every
 * category has, so a child alone cannot name one group.
 */
function matchesRecordFilters_(row, scope, request) {
  if (!matchesAccount_(row, scope)) return false;

  var day = dayNumber_(row.booking_date);
  if (day === null) return false;
  if (day < scope.window.from || day > scope.window.to) return false;

  if (scope.label && scope.label !== 'All') {
    if (splitLabels_(row.labels).indexOf(String(scope.label)) === -1) return false;
  }

  /*
    The two directions, and they are one rule with the comparison flipped:
    `in_reports` first, then the sign that `aggregate_` sorted the row into.

    **Exactly zero has no sign, so it is answered by `type` instead.** A
    pre-authorisation is a real debit of €0.00 — a card check at a fuel pump or
    a hotel — and every part of this project used to answer it differently:
    this excluded it from both drills, the row on the phone painted it green
    because `0 < 0` is false, and the sheet opened it on the Expense tab
    because `0 > 0` is false too. Three plausible answers to a question with a
    stored answer, since `type` is a formula over the row's category and says
    `expense`. Nothing about a total moves either way — a zero row adds zero to
    whichever side takes it — so this costs nothing and stops the list, the
    colour and the sheet disagreeing about the same row.
  */
  if (request.spendOnly || request.incomeOnly) {
    if (!isTruthyCell_(row.in_reports)) return false;
    var amount = cellNumber_(row.amount_base);
    if (amount === null) return false;

    var moneyIn = amount === 0 ? String(row.type) === TX_TYPE.INCOME : amount > 0;
    if (request.spendOnly && moneyIn) return false;
    if (request.incomeOnly && !moneyIn) return false;
  }

  if (!matchesGroup_(row.category, request.category)) return false;
  if (!matchesGroup_(row.subcategory, request.subcategory)) return false;

  if (request.unconfirmedOnly && isConfirmedRow_(row)) return false;

  var search = String(request.search || '').trim().toLowerCase();
  if (!search) return true;

  return [row.description, row.counterparty, row.category, row.subcategory, row.labels]
    .some(function (field) {
      return String(field == null ? '' : field).toLowerCase().indexOf(search) !== -1;
    });
}

/**
 * One group test, for the category and the subcategory alike.
 *
 * `All` and absent both mean "do not filter", the convention `matchesAccount_`
 * and the label test already follow — the page's dropdowns say `All` and a
 * filter object built before this feature existed says nothing at all, and both
 * have to keep working.
 */
function matchesGroup_(value, wanted) {
  if (!wanted || wanted === 'All') return true;
  return groupKey_(value) === String(wanted);
}

/** Is any of the drill filters set? See `webAppRecords_` on `pending`. */
function isDrilled_(request) {
  var want = request || {};
  return !!want.spendOnly || !!want.incomeOnly ||
    (!!want.category && want.category !== 'All') ||
    (!!want.subcategory && want.subcategory !== 'All');
}

/**
 * One row, compacted for the wire.
 *
 * `uid` is here because it is what a confirmation is addressed to — the same
 * pointer the `review` tab carries, and for the same reason: a list re-sorts
 * under you and a position does not survive that.
 *
 * `categoryAuto` is the cascade's own guess, carried **beside** the resolved
 * `category` rather than instead of it. The page needs both to undo a
 * categorisation: `applyReviewDecisions_` reads a blank `category_override` as
 * "I did not touch this" and not as "clear it", deliberately, so there is no
 * way to send an erasure. Putting a row back to its guess is therefore done by
 * writing that guess as the override — which needs the guess, and only the
 * server knows it. Blank here means the cascade had no opinion, and the page
 * must offer no undo rather than invent one.
 */
function recordForPage_(row, peers) {
  var peer = peers ? peers.of(row) : null;

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
    categoryAuto: String(row.category_auto || ''),
    // What a rule built from this row should match on, computed by the same
    // `normalizeMerchant` the cascade itself uses. Sent rather than derived in
    // the page on purpose: it strips dates, card references, digit runs and a
    // list of Italian POS noise words, and a second implementation in JS would
    // be a second thing to keep in step with the categoriser it exists to
    // agree with. Blank when the row has nothing to key on, and the page
    // offers no rule in that case.
    merchantKey: normalizeMerchant(row.description, row.counterparty),
    labels: splitLabels_(row.labels),
    type: String(row.type || ''),
    source: String(row.category_source || ''),
    confirmed: isConfirmedRow_(row),
    inReports: isTruthyCell_(row.in_reports),
    // Whether the description is yours to change. See `descriptionIsEditable_`.
    editableDescription: descriptionIsEditable_(row.source),
    /*
      The other end of a transfer, when this book holds it.

      Blank on everything else, and blank on a transfer whose counter-leg is not
      in the book — money to another bank, or to a person, has no second row and
      never will. The page has to be able to tell "somewhere outside" from "I do
      not know", so this says nothing rather than guessing.

      `peerDirection` rather than leaving the page to work it out from the sign:
      a €500 credit marked as a transfer is money arriving, and its peer is
      where it came *from*, while the matching debit's peer is where it went
      *to*. The page had neither and drew both as `⇄` beside the row's own
      account, which is the one account the arrow is not about.
    */
    peerAccount: peer ? peer.account : '',
    peerDirection: peer ? peer.direction : ''
  };
}

/**
 * `transfer_group` → the other leg, for whichever leg you ask about.
 *
 * The column is written by `detectTransfers_` and by `webAppLinkTransfer_`, and
 * both write the identical `tr:<the debit's uid>` to *both* rows — so a group
 * is a pair, and the other one is whichever member is not the row in hand. A
 * group holding three rows is a pairing that has gone wrong; this answers
 * nothing for it rather than picking one, because a transfer that names two
 * destinations is worse than one that names none.
 *
 * Rows are matched by `_row` rather than by uid: a leg this project wrote for a
 * cash withdrawal has a derived uid, and a book carrying two rows with the same
 * uid is a state `08_dedup` exists to prevent but cannot promise about history
 * that predates it. The row number is the one identifier a sheet cannot
 * duplicate.
 *
 * Built once per request and handed in, rather than looked up per row: the
 * alternative is a scan of the whole ledger for every transfer on the page.
 */
function transferPeers_(ledger) {
  var groups = {};

  (ledger || []).forEach(function (row) {
    var group = String(row.transfer_group || '');
    if (!group) return;
    if (!groups[group]) groups[group] = [];
    groups[group].push(row);
  });

  return {
    of: function (row) {
      var group = String(row.transfer_group || '');
      var members = group ? groups[group] : null;
      if (!members || members.length !== 2) return null;

      var other = members[0]._row === row._row ? members[1] : members[0];
      if (other._row === row._row) return null;

      var amount = cellNumber_(row.amount_base);
      if (amount === null) amount = cellNumber_(row.amount);

      return {
        account: String(other.account_name || ''),
        direction: amount !== null && amount > 0 ? 'from' : 'to'
      };
    }
  };
}

/**
 * Whether a row's description may be rewritten, which turns entirely on
 * whether a bank will ever fetch it again.
 *
 * `computeUid` has two branches. With an `entry_reference` the identity is the
 * bank's own immutable id and the description is decoration. Without one — and
 * plenty of banks send none — the uid is a hash of account, date, amount and
 * **`normalizeDescription(description)`**, which makes the description part of
 * what identifies the row.
 *
 * That is only dangerous in one direction. The uid already stored is never
 * recomputed; the risk is a *future* sync fetching the same transaction,
 * hashing the bank's description, and not recognising the row it is looking at
 * — which appends a duplicate of something already in the book, silently, and
 * days after the edit that caused it. So a synced row's description belongs to
 * the bank, and everything else is yours: cash you typed, a leg this project
 * wrote, a row you imported. Nothing will ever fetch any of those again.
 *
 * Not `crossSourceKey`, which pairs imported rows with synced ones during
 * "Remove synced duplicates" — that one is account, date and amount, and reads
 * no description at all. Checked, because it would have been the other reason
 * to say no.
 *
 * One function because two places ask: the page, to decide whether to offer the
 * field, and `applyReviewDecisions_`, to decide whether to honour it. The
 * second is the one that matters — a page can send anything.
 */
function descriptionIsEditable_(source) {
  return String(source === null || source === undefined ? '' : source) !== TX_SOURCE_API;
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

  // The probe is a second 3.7MB copy of the ledger and it must not outlive the
  // measurement. At the old five-minute TTL it aged out before it mattered; at
  // six hours, three runs of this diagnostic would leave 11MB of unreachable
  // ledger in a cache that evicts under pressure — and the thing it would
  // evict is the real one. Measuring a cache must not be what breaks it.
  forgetLedgerCache_(probe);

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
