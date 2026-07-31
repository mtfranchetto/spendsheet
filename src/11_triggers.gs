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
 */
var SCHEDULED = [
  {
    fn: 'syncScheduled',
    hourKey: 'sync_hour',
    describe: 'fetch from every connected bank and drain cash entries'
  },
  {
    fn: 'selfCheck',
    hourKey: 'selfcheck_hour',
    describe: 'notice if the sync has stopped running at all'
  }
];

/** Menu → Install triggers. Safe to run as often as you like. */
function installTriggers() {
  var config = readConfig_();
  var removed = removeOwnTriggers_();
  var installed = [];

  SCHEDULED.forEach(function (entry) {
    if (!functionExists_(entry.fn)) return;

    var hour = triggerHour_(config, entry.hourKey);
    ScriptApp.newTrigger(entry.fn).timeBased().everyDays(1).atHour(hour).create();
    installed.push({ fn: entry.fn, hour: hour, describe: entry.describe });
  });

  var message = installed.map(function (entry) {
    return formatHour_(entry.hour) + ' — ' + entry.describe;
  }).join('\n') || 'Nothing to schedule yet.';

  if (removed) message = 'Replaced ' + removed + ' existing.\n' + message;

  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Triggers installed', 20);
  return { installed: installed, removed: removed };
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
 * The hour a job runs, clamped to something a clock recognises.
 *
 * Apps Script picks a random minute within the hour, which is deliberate on
 * their side — it stops every script on the platform firing at :00 — and
 * harmless here.
 */
function triggerHour_(config, key) {
  var hour = Math.floor(configNumber_(config, key));
  if (!(hour >= 0 && hour <= 23)) return 4;
  return hour;
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
  var ours = SCHEDULED.map(function (entry) { return entry.fn; });
  var found = ScriptApp.getProjectTriggers().filter(function (trigger) {
    return ours.indexOf(trigger.getHandlerFunction()) !== -1;
  });

  var message = found.length
    ? found.map(function (t) { return t.getHandlerFunction(); }).join(', ') + ' scheduled daily.'
    : 'Nothing scheduled. Run Spendsheet → Install triggers.';

  // The honest limit, stated where it will be read: nothing inside a script
  // can report that the script is not running. Both triggers being deleted,
  // or the project disabled, is undetectable from in here.
  message += '\n\nGoogle emails you when a trigger throws. It does not email ' +
    'you when a trigger stops existing — see docs/MONITORING.md.';

  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Schedule', 20);
  return found.map(function (t) { return t.getHandlerFunction(); });
}
