/**
 * 15_recurring.gs — what happens again, and what that means for next month.
 *
 * Two operations that only make sense together: finding the transactions that
 * repeat, and projecting the balance forward from them.
 *
 * This lands after the import on purpose. Cadence detection needs *years*, not
 * the rolling ~90 days PSD2 gives us — an annual insurance premium is invisible
 * in a quarter of data, and a monthly salary needs several instances before
 * "every month" is a claim rather than a coincidence. A five-year history makes
 * this work on day one; a fresh connection would need until roughly Christmas.
 *
 * The grouping key is `normalizeMerchant` from 14_categorize, deliberately
 * reused rather than reinvented. A merchant is the same merchant whether you
 * are categorising it or forecasting it, and two functions that answer that
 * question slightly differently would be a bug nobody could see.
 */

/**
 * Two occurrences is a coincidence.
 *
 * With two dates there is exactly one gap, so *every* pair fits some cadence
 * perfectly — the detector cannot tell a subscription from two unrelated
 * payments that happened to be a month apart. Three is the first count at
 * which the interval can disagree with itself.
 */
var RECURRING_MIN_OCCURRENCES = 3;

/**
 * Cadences worth naming, in days.
 *
 * Monthly is absent because it is not a number of days: Jan 15 → Feb 15 is 31,
 * Feb 15 → Mar 15 is 28, and a fixed tolerance wide enough to hold both also
 * swallows the 4-weekly cycle that is genuinely different. It is detected by
 * day-of-month stability instead — see `isMonthly_`.
 */
var RECURRING_CADENCES = [
  { days: 7, label: 'weekly' },
  { days: 14, label: 'fortnightly' },
  { days: 28, label: '4-weekly' },
  { days: 91, label: 'quarterly' },
  { days: 365, label: 'yearly' }
];

/** A date this many days either side of the expected one still counts. */
var RECURRING_DRIFT_DAYS = 3;

var CADENCE_MONTHLY = { days: 30, label: 'monthly' };

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Menu → Detect recurring. */
function detectRecurringMenu() {
  var ui = SpreadsheetApp.getUi();
  var plan = planRecurring_();

  if (plan.error) {
    ui.alert('Detect recurring', plan.error, ui.ButtonSet.OK);
    return plan;
  }

  var answer = ui.alert('Detect recurring', describeRecurringPlan_(plan), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Nothing changed.', 'Cancelled', 5);
    return plan;
  }

  var written = writeRecurring_(plan);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    written + ' recurring items.', 'Detected', 10);
  return { written: written, plan: plan };
}

function planRecurring_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  var sheet = ss.getSheetByName(TABS.RECURRING);
  if (!tx || !sheet) return { error: 'Run Setup sheet first — a tab is missing.' };

  var records = readRecords_(tx, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'));
  if (records.length < RECURRING_MIN_OCCURRENCES) {
    return { error: 'Not enough history yet. Detection needs at least ' +
      RECURRING_MIN_OCCURRENCES + ' transactions, and realistically a year of them.' };
  }

  var found = deriveRecurring_(records);
  if (!found.length) {
    return { error: 'Nothing repeats often enough yet.\n\nAn item needs ' +
      RECURRING_MIN_OCCURRENCES + ' occurrences at a recognisable cadence. Two is a ' +
      'coincidence — with one gap between them, every pair fits some cadence perfectly.' };
  }

  return { sheet: sheet, items: found, existing: readRecurringChoices_(sheet) };
}

/**
 * Transactions → recurring items. Pure, so the whole detector is testable
 * without a spreadsheet.
 *
 * Excluded rows and transfers are left out. A transfer repeating monthly is
 * real and is not cashflow — both legs are yours, so projecting it would count
 * the same money leaving and arriving, twice.
 */
function deriveRecurring_(records) {
  var groups = {};

  (records || []).forEach(function (record) {
    if (isTruthyCell_(record.excluded)) return;
    if (String(record.type || '') === TX_TYPE.TRANSFER) return;

    var amount = Number(record.amount);
    if (isBlankCell_(record.amount) || !isFinite(amount) || amount === 0) return;
    if (!(record.booking_date instanceof Date)) return;

    var merchant = normalizeMerchant(record.description, record.counterparty);
    if (!merchant) return;

    // Direction is part of identity. A merchant you both pay and are refunded
    // by is two rhythms, and averaging them gives a number that is neither.
    var key = merchant + '|' + String(record.account_id || '') + '|' + (amount < 0 ? 'out' : 'in');
    var group = groups[key] = groups[key] || { key: key, merchant: merchant, rows: [] };
    group.rows.push(record);
  });

  var items = [];

  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    if (group.rows.length < RECURRING_MIN_OCCURRENCES) return;

    var rows = group.rows.slice().sort(function (a, b) {
      return a.booking_date.getTime() - b.booking_date.getTime();
    });
    var dates = rows.map(function (row) { return row.booking_date; });

    var cadence = detectCadence_(dates);
    if (!cadence) return;

    var last = dates[dates.length - 1];
    items.push({
      key: key,
      account_id: rows[0].account_id || '',
      category: rows[0].category || rows[0].category_override || rows[0].category_auto || '',
      avg_amount: averageAmount_(rows),
      cadence_days: cadence.days,
      occurrences: rows.length,
      last_seen: last,
      next_expected: addDays_(last, cadence.days),
      confidence: cadence.confidence,
      active: true,
      _label: cadence.label,
      _merchant: group.merchant
    });
  });

  items.sort(function (a, b) {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return Math.abs(b.avg_amount) - Math.abs(a.avg_amount);
  });

  return items;
}

/**
 * Which rhythm a series of dates is on, or nothing.
 *
 * Monthly is computed separately from the rest, because it is the only cadence
 * that is not a fixed number of days — but it is **not** tried first and
 * accepted on sight. It used to be, and that was wrong: a fortnightly series
 * lands on only a handful of distinct days of the month, so it scores a weak
 * monthly fit, and short-circuiting on it discarded a perfect 14-day match that
 * was never even looked at.
 *
 * So both explanations are computed and the better one wins. A tie goes to
 * monthly, which resolves the one case where both are genuinely perfect: a
 * charge on the 15th produces gaps of 28–31, which also fits 4-weekly exactly.
 * Day-of-month stability is the tiebreak because a real 4-weekly cycle drifts
 * through the month and would not have it.
 *
 * The gap match uses the *median* rather than the mean: one missed payment
 * produces a double-length gap that drags a mean far enough to match nothing,
 * while the median shrugs it off — and a subscription you paused for a month is
 * still a subscription.
 */
function detectCadence_(dates) {
  var monthly = monthlyFit_(dates);
  var byGap = gapFit_(dates);

  if (monthly === null && !byGap) return null;
  if (monthly === null) return byGap;

  var asMonthly = {
    days: CADENCE_MONTHLY.days,
    label: CADENCE_MONTHLY.label,
    confidence: monthly
  };
  if (!byGap) return asMonthly;

  return byGap.confidence > asMonthly.confidence ? byGap : asMonthly;
}

/** The best fixed-day-count cadence for these dates, or null. */
function gapFit_(dates) {
  var gaps = [];
  for (var i = 1; i < dates.length; i++) gaps.push(daysBetween_(dates[i - 1], dates[i]));
  if (!gaps.length) return null;

  var middle = median_(gaps);

  for (var c = 0; c < RECURRING_CADENCES.length; c++) {
    var cadence = RECURRING_CADENCES[c];
    var tolerance = cadenceTolerance_(cadence.days);
    if (Math.abs(middle - cadence.days) > tolerance) continue;

    var fitting = gaps.filter(function (gap) {
      return Math.abs(gap - cadence.days) <= tolerance;
    }).length;

    return {
      days: cadence.days,
      label: cadence.label,
      confidence: round2_(fitting / gaps.length)
    };
  }

  return null;
}

/**
 * A longer cycle is allowed to wander further.
 *
 * Three days out of seven is a different week; three days out of a year is a
 * bank holiday. A flat tolerance either rejects every annual premium or accepts
 * anything weekly.
 */
function cadenceTolerance_(days) {
  return Math.max(RECURRING_DRIFT_DAYS, Math.round(days * 0.1));
}

/**
 * How well the dates sit on one day of the month, or null if they do not.
 *
 * Day-of-month rather than day-count, because that is what a monthly charge
 * actually is: the 15th of every month, whatever that does to the interval.
 * Month-ends are folded to the 28th first, so a charge that lands on the 31st,
 * the 28th and the 30th is one rhythm rather than three.
 */
function monthlyFit_(dates) {
  if (dates.length < RECURRING_MIN_OCCURRENCES) return null;

  var days = dates.map(function (date) { return Math.min(date.getDate(), 28); });

  // The centre is the day that gathers the most others, not the most frequent
  // one. For the 15th, 17th, 13th and 16th every day occurs exactly once, so
  // "most frequent" is a coin toss that picks 13 and then counts the 17th as
  // out of range — reporting 75% confidence in a series that is plainly one
  // billing date with two days of drift.
  var near = 0;
  days.forEach(function (centre) {
    var gathered = days.filter(function (day) {
      // Wrapping, so the 1st and the 28th are three days apart rather than 27.
      var direct = Math.abs(day - centre);
      return Math.min(direct, 28 - direct) <= RECURRING_DRIFT_DAYS;
    }).length;
    if (gathered > near) near = gathered;
  });

  if (near < RECURRING_MIN_OCCURRENCES) return null;

  // And the months themselves have to advance, or twelve charges in one week
  // all landing near the 15th would read as a year of subscription.
  var months = {};
  dates.forEach(function (date) { months[date.getFullYear() + '-' + date.getMonth()] = true; });
  if (Object.keys(months).length < RECURRING_MIN_OCCURRENCES) return null;

  return round2_(near / days.length);
}

function averageAmount_(rows) {
  var total = rows.reduce(function (sum, row) { return sum + Number(row.amount); }, 0);
  return round2_(total / rows.length);
}

function median_(values) {
  var sorted = values.slice().sort(function (a, b) { return a - b; });
  var middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round2_(value) {
  return Math.round(value * 100) / 100;
}

function addDays_(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/**
 * The `active` ticks already on the tab, kept across a re-detect.
 *
 * `active` is yours — it is how you say "yes this repeats, and no, do not
 * forecast it". Rebuilding the tab without it would silently re-enable
 * everything you had turned off, which is the sort of thing you notice three
 * months later in a projection that was wrong the whole time.
 */
function readRecurringChoices_(sheet) {
  var choices = {};
  readRecords_(sheet, RECURRING_COLUMNS, colIndex_(RECURRING_COLUMNS, 'key'))
    .forEach(function (row) {
      if (row.key) choices[String(row.key)] = isTruthyCell_(row.active);
    });
  return choices;
}

function describeRecurringPlan_(plan) {
  var top = plan.items.slice(0, 10).map(function (item) {
    return '  ' + item._merchant + ' — ' + item._label + ', ' +
      item.avg_amount.toFixed(2) + ' (' + item.occurrences + 'x, ' +
      Math.round(item.confidence * 100) + '%)';
  });

  var lines = ['Found ' + plan.items.length + ' recurring items.', ''].concat(top);
  if (plan.items.length > top.length) {
    lines.push('  … and ' + (plan.items.length - top.length) + ' more.');
  }

  var kept = plan.items.filter(function (item) {
    return item.key in plan.existing && !plan.existing[item.key];
  }).length;
  if (kept) lines.push('', kept + ' item(s) you had switched off stay off.');

  lines.push('', TABS.RECURRING + ' is rebuilt, keeping your `active` ticks. ' +
    'Untick anything that is not really a commitment — that column is what the ' +
    'cashflow projection reads.', '', 'Continue?');
  return lines.join('\n');
}

function writeRecurring_(plan) {
  var sheet = plan.sheet;

  var rows = plan.items.map(function (item) {
    var previous = plan.existing[item.key];
    return toRow_(RECURRING_COLUMNS, {
      key: item.key,
      account_id: item.account_id,
      category: item.category,
      avg_amount: item.avg_amount,
      cadence_days: item.cadence_days,
      occurrences: item.occurrences,
      last_seen: item.last_seen,
      next_expected: item.next_expected,
      confidence: item.confidence,
      active: previous === undefined ? true : previous
    });
  });

  clearDataRows_(sheet, colIndex_(RECURRING_COLUMNS, 'key'), RECURRING_COLUMNS.length);
  if (rows.length) sheet.getRange(2, 1, rows.length, RECURRING_COLUMNS.length).setValues(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Cashflow
// ---------------------------------------------------------------------------

/** Menu → Rebuild cashflow. */
function rebuildCashflow() {
  var ui = SpreadsheetApp.getUi();
  var plan = planCashflow_();

  if (plan.error) {
    ui.alert('Rebuild cashflow', plan.error, ui.ButtonSet.OK);
    return plan;
  }

  var written = writeCashflow_(plan);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    written + ' days projected from ' + plan.opening.toFixed(2) + '.', 'Cashflow', 10);
  return { written: written, plan: plan };
}

/**
 * No confirmation prompt, unlike everything else with a menu entry.
 *
 * `cashflow` is entirely derived and holds nothing of yours — rebuilding it is
 * the same class of act as recalculating a formula. A prompt in front of that
 * is the kind of friction that teaches you to click through prompts, including
 * the ones that matter.
 */
function planCashflow_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TABS.CASHFLOW);
  var recurring = ss.getSheetByName(TABS.RECURRING);
  var accounts = ss.getSheetByName(TABS.ACCOUNTS);
  if (!sheet || !recurring || !accounts) {
    return { error: 'Run Setup sheet first — a tab is missing.' };
  }

  var items = readRecords_(recurring, RECURRING_COLUMNS, colIndex_(RECURRING_COLUMNS, 'key'))
    .filter(function (row) { return row.key && isTruthyCell_(row.active); });

  if (!items.length) {
    return { error: 'Nothing to project.\n\nRun "Detect recurring" first, and make sure ' +
      'at least one row in ' + TABS.RECURRING + ' has `active` ticked.' };
  }

  var config = readConfig_();
  var horizon = configNumber_(config, 'cashflow_horizon_days');

  return {
    sheet: sheet,
    opening: liquidBalance_(accounts),
    days: projectCashflow_(items, liquidBalance_(accounts), new Date(), horizon)
  };
}

/**
 * What there is to spend, which is not net worth.
 *
 * `asset` accounts are excluded: a projection is about whether money runs out,
 * and a flat you cannot sell by Thursday does not stop that happening. Bank and
 * cash only, and only the ones still marked active.
 */
function liquidBalance_(sheet) {
  return readRecords_(sheet, ACCOUNT_COLUMNS, colIndex_(ACCOUNT_COLUMNS, 'account_id'))
    .filter(function (row) { return row.account_id && isTruthyCell_(row.active); })
    .filter(function (row) { return String(row.kind) !== ACCOUNT_KIND.ASSET; })
    .reduce(function (total, row) {
      var balance = Number(row.balance);
      return isBlankCell_(row.balance) || !isFinite(balance) ? total : total + balance;
    }, 0);
}

/**
 * One row per day, from tomorrow to the horizon. Pure.
 *
 * Each item is stepped forward from `next_expected` by its cadence until it
 * passes the horizon, so a weekly item lands thirteen times in a quarter and a
 * yearly one lands at most once. An item whose `next_expected` is already in
 * the past is rolled forward first rather than dumped on day one — a missed
 * detection run should not make tomorrow look catastrophic.
 */
function projectCashflow_(items, opening, from, horizonDays) {
  var start = addDays_(from, 1);
  var horizon = addDays_(from, horizonDays);

  var byDay = {};
  items.forEach(function (item) {
    var cadence = Number(item.cadence_days);
    var amount = Number(item.avg_amount);
    if (!isFinite(cadence) || cadence <= 0) return;
    if (!isFinite(amount) || amount === 0) return;

    var next = item.next_expected instanceof Date ? item.next_expected : null;
    if (!next) return;

    // Guarded rather than looped-until-future: a cadence of 0 would spin
    // forever, and this runs inside a six-minute execution limit.
    var guard = 0;
    while (next < start && guard++ < 1000) next = addDays_(next, cadence);

    while (next <= horizon && guard++ < 1000) {
      var key = dateKey(next);
      var day = byDay[key] = byDay[key] || { in: 0, out: 0 };
      if (amount > 0) day.in += amount;
      else day.out += Math.abs(amount);
      next = addDays_(next, cadence);
    }
  });

  var rows = [];
  var balance = opening;

  for (var i = 0; i < horizonDays; i++) {
    var date = addDays_(start, i);
    var day = byDay[dateKey(date)] || { in: 0, out: 0 };
    var closing = balance + day.in - day.out;

    rows.push({
      date: date,
      opening: round2_(balance),
      expected_in: round2_(day.in),
      expected_out: round2_(day.out),
      closing: round2_(closing)
    });
    balance = closing;
  }

  return rows;
}

function writeCashflow_(plan) {
  var sheet = plan.sheet;
  var rows = plan.days.map(function (day) { return toRow_(CASHFLOW_COLUMNS, day); });

  clearDataRows_(sheet, colIndex_(CASHFLOW_COLUMNS, 'date'), CASHFLOW_COLUMNS.length);
  if (rows.length) sheet.getRange(2, 1, rows.length, CASHFLOW_COLUMNS.length).setValues(rows);
  return rows.length;
}

/**
 * Called by the sync. Never throws, and never says anything.
 *
 * A projection that could not be rebuilt is not a reason to fail a run that
 * fetched transactions successfully — and "no recurring items yet" is the
 * normal state of a book in its first month, not an error worth an alert.
 */
function refreshCashflowQuietly_() {
  try {
    var plan = planCashflow_();
    if (plan.error) return null;
    return writeCashflow_(plan);
  } catch (e) {
    Logger.log('refreshCashflowQuietly_: ' + e.message);
    return null;
  }
}

/**
 * The day the projection first goes negative, or null.
 *
 * The one number in the whole tab worth putting on the dashboard: ninety rows
 * of balances answer a question nobody asked, and "you run out on the 14th"
 * answers the only one that matters.
 */
function firstNegativeDay_(rows) {
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].closing < 0) return rows[i].date;
  }
  return null;
}
