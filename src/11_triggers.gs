/**
 * 11_triggers.gs — making it run without you.
 *
 * A time-driven trigger is what turns this from a thing you remember to open
 * into a thing that has already happened. It fires whether or not the
 * spreadsheet is open, whether or not you are logged in, on Google's
 * infrastructure, for free. There is no server in this project and this is
 * the file that makes that true rather than merely aspirational.
 *
 * You *can* install one by hand — Apps Script editor → Triggers → Add
 * trigger — and by the governing rule a one-time human operation should be
 * documented rather than automated. This one earns code anyway, for the same
 * reason `installCredentials()` does: the manual path has a silent failure
 * mode. Adding a second trigger by mistake is two clicks, produces no warning,
 * and doubles your API calls every night — straight into the rate limit whose
 * penalty is measured in hours. You would see it as "the sync stopped
 * working", days later, with nothing to connect it to.
 *
 * So this is idempotent by construction: it removes the triggers it owns
 * before creating them, and touches no others.
 */

/**
 * What runs on a schedule, and when.
 *
 * `selfCheck` is deliberately a **separate trigger** rather than a step at the
 * end of the sync. If it were part of the sync, a crash in the sync would take
 * the alarm down with it — which is precisely the failure where you most need
 * to hear something. It lands in phase 8; until then it is skipped, because
 * this list is filtered to functions that actually exist.
 *
 * `learnScheduled` is separate for the same reason, in the other direction: a
 * failure while rebuilding memory must not cost the night's transactions. It
 * runs an hour *before* the sync so the categorisation that follows each fetch
 * already knows the corrections you made that day.
 *
 * The order here is install order, not clock order. The hours come from
 * `_config`.
 */
var SCHEDULED = [
  {
    fn: 'syncScheduled',
    hourKey: 'sync_hour',
    budgeted: true,
    describe: 'fetch from every connected bank and drain cash entries'
  },
  {
    fn: 'selfCheck',
    hourKey: 'selfcheck_hour',
    budgeted: false,
    describe: 'notice if the sync has stopped running at all'
  },
  {
    fn: 'snapshotToDrive',
    hourKey: 'snapshot_hour',
    budgeted: false,
    weekly: true,
    describe: 'save a CSV of transactions to Drive'
  },
  {
    fn: 'learnScheduled',
    hourKey: 'learn_hour',
    budgeted: false,
    describe: 'rebuild _memory from your corrections, before the sync uses it'
  }
];

/** A full sync of one account: balances, booked, pending. */
var CALLS_PER_FULL_SYNC = 3;

/** Menu → Install triggers. Safe to run as often as you like. */
function installTriggers() {
  requireInteractive_();
  var config = readConfig_();
  var removed = removeOwnTriggers_();
  var installed = [];
  var notes = [];

  SCHEDULED.forEach(function (entry) {
    if (!functionExists_(entry.fn)) return;

    // Each schedule falls back to its own seeded hour. One shared fallback
    // would put a cleared `learn_hour` in the sync's hour, where two triggers
    // take random minutes and learning lands after the sync half the time.
    // `configNumber_` over an empty object is exactly that seeded value.
    var hours = parseHours_(config[entry.hourKey], configNumber_({}, entry.hourKey));
    hours.forEach(function (hour) {
      var timed = ScriptApp.newTrigger(entry.fn).timeBased();
      if (entry.weekly) timed.everyWeeks(1).onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(hour).create();
      else timed.everyDays(1).atHour(hour).create();

      installed.push({
        fn: entry.fn, hour: hour, weekly: Boolean(entry.weekly), describe: entry.describe
      });
    });

    if (entry.budgeted) notes.push(describeBudget_(config, hours.length));
  });

  var message = installed.map(function (entry) {
    return formatHour_(entry.hour) + (entry.weekly ? ' Sundays' : ' daily') + ' — ' + entry.describe;
  }).join('\n') || 'Nothing to schedule yet.';

  if (removed) message = 'Replaced ' + removed + ' existing.\n' + message;
  if (notes.length) message += '\n\n' + notes.join('\n');

  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Triggers installed', 30);
  return { installed: installed, removed: removed, notes: notes };
}

/**
 * What running N times a day actually gets you.
 *
 * Worth spelling out at the moment you choose it, because the honest answer
 * is not "N times the data". PSD2 caps unattended access at roughly four
 * calls per account per day and a full sync is three of them, so the first
 * run of the day is the expensive one and every later run has to make do with
 * what is left — transactions only, no balance, no pending refresh.
 *
 * That is still worth having: transactions are the thing that cannot be
 * recovered once they fall out of the rolling window, and a balance is only
 * ever a few hours stale. But beyond a certain point extra runs are pure
 * decoration, and a schedule that quietly does nothing is worse than one that
 * says so.
 */
function describeBudget_(config, runs) {
  var allowance = configNumber_(config, 'max_calls_per_account_per_day');
  var useful = allowance >= CALLS_PER_FULL_SYNC
    ? 1 + (allowance - CALLS_PER_FULL_SYNC)
    : 0;

  if (runs <= 1) return '';
  if (runs <= useful) {
    return 'Banks allow ~' + allowance + ' calls per account per day, and a full sync is ' +
      CALLS_PER_FULL_SYNC + '. So the first run fetches everything and the later ones ' +
      'fetch transactions only — no balance refresh, no pending.';
  }
  return 'Only ' + useful + ' of these ' + runs + ' runs will do anything: banks allow ~' +
    allowance + ' calls per account per day and a full sync is ' + CALLS_PER_FULL_SYNC +
    '. The rest will be skipped and logged. Drop a run, or set fetch_pending to no in ' +
    '_config to free one call per sync.';
}

/**
 * Delete only the triggers for functions in this list.
 *
 * A trigger you added yourself for something of your own is left alone —
 * deleting an unrelated trigger because it happened to be in the same project
 * would be a genuinely nasty surprise.
 */
function removeOwnTriggers_() {
  var ours = SCHEDULED.map(function (entry) { return entry.fn; });
  var removed = 0;

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (ours.indexOf(trigger.getHandlerFunction()) === -1) return;
    ScriptApp.deleteTrigger(trigger);
    removed++;
  });
  return removed;
}

/**
 * The hours a job runs at, from a cell holding `4` or `4,16` or `4, 16, 22`.
 *
 * Apps Script picks a random minute within each hour, which is deliberate on
 * their side — it stops every script on the platform firing at :00 — and
 * harmless here.
 *
 * Deduped and sorted, because two triggers in the same hour is the stacking
 * mistake this whole function exists to prevent, just spelled differently.
 */
function parseHours_(raw, fallback) {
  var hours = String(raw === null || raw === undefined ? '' : raw)
    .split(',')
    // Blank parts are dropped before Number() sees them: `Number('')` is 0,
    // which is a perfectly valid hour, so an empty cell would schedule
    // midnight rather than fall back to the default.
    .filter(function (part) { return !isBlankCell_(part); })
    .map(function (part) { return Math.floor(Number(part.trim())); })
    .filter(function (hour) { return hour >= 0 && hour <= 23; });

  var unique = [];
  hours.forEach(function (hour) {
    if (unique.indexOf(hour) === -1) unique.push(hour);
  });

  unique.sort(function (a, b) { return a - b; });
  return unique.length ? unique : [fallback];
}

function formatHour_(hour) {
  return (hour < 10 ? '0' : '') + hour + ':00';
}

/**
 * What is currently scheduled, as text.
 *
 * Worth having because the Apps Script triggers page is three clicks away
 * inside a different app, and "is this actually running?" is a question you
 * ask from the spreadsheet.
 */
function describeTriggers() {
  requireInteractive_();
  var ours = SCHEDULED.map(function (entry) { return entry.fn; });
  var found = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return ours.indexOf(trigger.getHandlerFunction()) !== -1;
  });

  var message = found.length
    ? found.length + ' trigger' + (found.length === 1 ? '' : 's') + ': ' +
      found.map(function (t) { return t.getHandlerFunction(); }).join(', ')
    : 'Nothing scheduled. Run Spendsheet → Install triggers.';

  // The honest limit, stated where it will be read: nothing inside a script
  // can report that the script is not running. Both triggers being deleted,
  // or the project disabled, is undetectable from in here.
  message += '\n\nGoogle emails you when a trigger throws. It does not email ' +
    'you when a trigger stops existing — see docs/MONITORING.md.';

  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Schedule', 20);
  return found.map(function (t) { return t.getHandlerFunction(); });
}
