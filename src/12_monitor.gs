/**
 * 12_monitor.gs — noticing when it stops working.
 *
 * An unattended system you don't check is worth exactly as much as its alarm.
 * There are six ways this one fails and **none of them catches the others**,
 * which is the entire reason this file is a list of separate detectors rather
 * than one health function:
 *
 *   1. the script threw           → Google's own trigger-failure email
 *   2. one bank broke             → per-account catch, run marked PARTIAL
 *   3. a consent is expiring      → `valid_until` against today
 *   4. it ran and fetched nothing → zero rows for N consecutive days
 *   5. it never ran at all        → `selfCheck` on a separate trigger
 *   6. rows disappeared           → the count went down. Alert *and* abort
 *
 * **Failure 4 is the one that quietly ruins these systems.** A green run that
 * fetched nothing looks identical from the outside to a healthy one, and you
 * find out months later when a report reads thin. Nothing but counting rows
 * every single time will catch it.
 *
 * **Failure 5 is why `selfCheck` is its own trigger.** Inside the sync, a
 * crash would take the alarm down with it — precisely the failure where you
 * most need to hear something.
 *
 * The honest limit: nothing in here can report that the *script* is not
 * running. Both triggers being deleted, or the project disabled, is
 * undetectable from inside it. That needs an external dead-man's switch, and
 * it stays out of scope — see docs/MONITORING.md.
 */

var ALERT_PROP = 'MONITOR_ALERTS';
var ROW_COUNT_PROP = 'MONITOR_ROW_COUNT';

var ALERT_KIND = {
  CONSENT: 'consent',
  EMPTY_RUNS: 'empty_runs',
  NEVER_RAN: 'never_ran',
  ROWS_LOST: 'rows_lost',
  ACCOUNT_FAILING: 'account_failing'
};

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Menu → Health check. Every detector, reported rather than emailed. */
function healthCheck() {
  var findings = runChecks_(new Date());
  var message = findings.length
    ? findings.map(function (f) { return '• ' + f.detail; }).join('\n')
    : 'Nothing to report. Sync is current, consents are healthy, no rows lost.';

  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Health check', 30);
  return findings;
}

/**
 * The separate trigger.
 *
 * Reads `_runs` and `_status` and sends what it finds. Deliberately does not
 * touch the network or the transactions tab: its whole job is to still work
 * on a day when the sync does not.
 */
function selfCheck() {
  var findings = runChecks_(new Date());
  findings.forEach(function (finding) {
    sendAlert_(finding.kind, finding.key, finding.subject, finding.detail);
  });
  return findings;
}

function runChecks_(now) {
  var config = readConfig_();
  return []
    .concat(checkStaleness_(config, now))
    .concat(checkEmptyRuns_(config, now))
    .concat(checkConsents_(config, now))
    .concat(checkFailingAccounts_())
    .concat(checkRowLoss_());
}

/**
 * Failure 5 — it never ran.
 *
 * Measured from the last **successful** run rather than the last run of any
 * kind: a sync that has been failing every night for a week is not "current".
 */
function checkStaleness_(config, now) {
  var runs = readRuns_();
  var threshold = configNumber_(config, 'stale_threshold_days');

  var lastGood = runs.filter(function (run) { return run.result !== RUN_RESULT.FAIL; }).pop();
  if (!lastGood) {
    return runs.length
      ? [alert_(ALERT_KIND.NEVER_RAN, '', 'Sync has never succeeded',
          'Every recorded run failed. See _runs and _status.')]
      : [];
  }

  var days = daysBetween_(lastGood.started_at, now);
  if (days <= threshold) return [];

  return [alert_(ALERT_KIND.NEVER_RAN, '', 'Sync has not run for ' + days + ' days',
    'Last successful sync was ' + days + ' days ago (' + dateKey(lastGood.started_at) + '). ' +
    'Check Spendsheet → Show schedule, and the Triggers page in the Apps Script editor.')];
}

/**
 * Failure 4 — it ran fine and fetched nothing.
 *
 * The quiet one. Only fires after several consecutive days, because a single
 * empty day is completely normal — most people have days with no
 * transactions, and alerting on that would train you to ignore the alerts.
 */
function checkEmptyRuns_(config, now) {
  var threshold = configNumber_(config, 'empty_run_threshold_days');
  var runs = readRuns_().filter(function (run) { return run.accounts_attempted > 0; });
  if (!runs.length) return [];

  var days = {};
  runs.forEach(function (run) {
    var day = dateKey(run.started_at);
    if (!day) return;
    days[day] = (days[day] || 0) + Number(run.rows_fetched || 0);
  });

  var recent = Object.keys(days).sort().reverse().slice(0, threshold);
  if (recent.length < threshold) return [];

  var allEmpty = recent.every(function (day) { return days[day] === 0; });
  if (!allEmpty) return [];

  return [alert_(ALERT_KIND.EMPTY_RUNS, '',
    'Sync has fetched nothing for ' + threshold + ' days',
    'The last ' + threshold + ' days of syncs all ran and returned zero transactions. ' +
    'That is normal over a quiet weekend and not over ' + threshold + ' days — check ' +
    '_status for a consent that has expired.')];
}

/**
 * Failure 3 — a consent is expiring.
 *
 * Read from `valid_until` against today rather than from the `days_left`
 * formula, so this is truthful on a morning when the sheet has not
 * recalculated and on a run that has nothing else to say.
 */
function checkConsents_(config, now) {
  var warn = configNumber_(config, 'consent_warning_days');
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STATUS);
  if (!sheet) return [];

  return readRecords_(sheet, STATUS_COLUMNS)
    .filter(function (row) { return row.connection_id && row.valid_until; })
    .map(function (row) {
      var days = daysBetween_(now, row.valid_until);
      if (days > warn) return null;

      var expired = days < 0;
      return alert_(ALERT_KIND.CONSENT, String(row.connection_id),
        expired
          ? row.provider + ': bank consent has expired'
          : row.provider + ': bank consent expires in ' + days + ' days',
        (expired
          ? 'The consent for ' + row.provider + ' expired on ' + dateKey(row.valid_until) + '.'
          : 'The consent for ' + row.provider + ' expires on ' + dateKey(row.valid_until) + '.') +
        ' Reconnect with Spendsheet → Connect a bank. Nothing is lost by waiting — history ' +
        'already fetched stays — but no new transactions arrive until you do.');
    })
    .filter(Boolean);
}

/** Failure 2 — one bank is broken while the others are fine. */
function checkFailingAccounts_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STATUS);
  if (!sheet) return [];

  return readRecords_(sheet, STATUS_COLUMNS)
    .filter(function (row) { return row.connection_id && row.last_error; })
    .map(function (row) {
      return alert_(ALERT_KIND.ACCOUNT_FAILING, String(row.connection_id),
        row.provider + ': last sync failed',
        row.provider + ' reported: ' + row.last_error);
    });
}

/**
 * Failure 6 — rows disappeared.
 *
 * `transactions` is append-only, so its count going down is never legitimate:
 * it means a sort, a deleted range, or an undo that took more than it looked
 * like. Detected by remembering the count rather than by inspecting the rows,
 * because the rows that would tell you are the ones that are gone.
 */
function checkRowLoss_() {
  var current = currentRowCount_();
  var recorded = Number(
    PropertiesService.getScriptProperties().getProperty(ROW_COUNT_PROP) || 0);

  if (!recorded || current >= recorded) return [];

  return [alert_(ALERT_KIND.ROWS_LOST, '',
    'Rows have disappeared from transactions',
    'transactions held ' + recorded + ' rows and now holds ' + current + '. That tab is ' +
    'append-only, so this is never legitimate — a sort, a deleted range, or an undo that ' +
    'took more than it appeared to. Syncing is blocked until it is resolved: File → Version ' +
    'history to restore, then Spendsheet → Accept row count.')];
}

function currentRowCount_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.TRANSACTIONS);
  return sheet ? lastRecordRow_(sheet, colIndex_(TX_COLUMNS, 'uid')) - 1 : 0;
}

/**
 * The guard the sync calls before it does anything.
 *
 * Aborts rather than warns. Appending to a tab that has silently lost rows
 * writes new history on top of a hole, and every day it runs afterwards makes
 * the restore harder.
 */
function assertNoRowLoss_() {
  var loss = checkRowLoss_();
  if (!loss.length) return;

  sendAlert_(loss[0].kind, '', loss[0].subject, loss[0].detail);
  throw new Error(loss[0].detail);
}

/** Record the count as legitimate. Called after every successful append. */
function rememberRowCount_() {
  PropertiesService.getScriptProperties()
    .setProperty(ROW_COUNT_PROP, String(currentRowCount_()));
}

/**
 * Menu → Accept row count.
 *
 * The way out of an abort once you have decided the smaller sheet is correct —
 * you deliberately deleted test rows, say. Manual on purpose: an automatic
 * reset would make the detector unable to detect anything.
 */
function acceptRowCount() {
  var before = PropertiesService.getScriptProperties().getProperty(ROW_COUNT_PROP);
  rememberRowCount_();

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Row count accepted: ' + before + ' → ' + currentRowCount_() + '. Syncing is unblocked.',
    'Accepted', 15);
  return currentRowCount_();
}

// ---------------------------------------------------------------------------
// Alerting
// ---------------------------------------------------------------------------

function alert_(kind, key, subject, detail) {
  return { kind: kind, key: key || '', subject: subject, detail: detail };
}

/**
 * Send at most one of each alert per day.
 *
 * A free Google account allows 100 emails a day. A persistent failure checked
 * hourly would burn that in an afternoon and then go silent — and an alarm
 * system that exhausts its own quota is worse than no alarm at all, because
 * you have learned to expect it.
 */
function sendAlert_(kind, key, subject, body) {
  var id = kind + '|' + (key || '');
  var sent = safeJsonParse(
    PropertiesService.getScriptProperties().getProperty(ALERT_PROP) || '{}') || {};

  var today = dateKey(new Date());
  if (sent[id] === today) return false;

  // Built outside the try on purpose. The catch is here to tolerate the mail
  // quota running out — not to swallow a mistake in the lines that assemble
  // the message, which is exactly what it did until a test caught it: no
  // email, no error, no way to tell the difference from "nothing was wrong".
  var to = alertRecipient_();
  var title = 'spendsheet: ' + subject;
  var text = body + '\n\n— ' + SpreadsheetApp.getActiveSpreadsheet().getUrl();

  try {
    MailApp.sendEmail(to, title, text);
  } catch (e) {
    Logger.log('sendAlert_ could not send: ' + e.message);
    return false;
  }

  sent[id] = today;
  PropertiesService.getScriptProperties().setProperty(ALERT_PROP, JSON.stringify(sent));
  return true;
}

function alertRecipient_() {
  var configured = String(readConfig_().alert_email || '').trim();
  return configured || Session.getEffectiveUser().getEmail();
}

// ---------------------------------------------------------------------------
// _runs
// ---------------------------------------------------------------------------

/** Oldest first, which is the order the checks above assume. */
function readRuns_() {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.RUNS);
  return sheet ? readRecords_(sheet, RUN_COLUMNS) : [];
}

/** Whole days between two dates, positive when `to` is later. */
function daysBetween_(from, to) {
  var a = from instanceof Date ? from : new Date(from);
  var b = to instanceof Date ? to : new Date(to);
  if (isNaN(a.getTime()) || isNaN(b.getTime())) return 0;

  var day = 24 * 60 * 60 * 1000;
  return Math.floor((startOfDay_(b) - startOfDay_(a)) / day);
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

/**
 * A weekly CSV of `transactions` into Drive.
 *
 * Version history is not a backup here. A free account keeps **30 days or 100
 * revisions, whichever comes first**, and a daily sync burns 100 revisions in
 * roughly three months — so discovering in June that something broke in March
 * means it is genuinely gone.
 *
 * CSV rather than a copy of the spreadsheet, because the point is that the
 * data outlives the tooling. A CSV opens in anything, forever.
 *
 * And the honest caveat, which belongs in the code and not only in the docs:
 * Drive is still Google. If the account is lost these go with it. An
 * occasional File → Download → xlsx kept somewhere else is the off-Google
 * backup, and it stays a manual step.
 */
function snapshotToDrive() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = sheetOrThrow_(TABS.TRANSACTIONS);
  var config = readConfig_();

  var rows = lastRecordRow_(sheet, colIndex_(TX_COLUMNS, 'uid'));
  var values = sheet.getRange(1, 1, Math.max(rows, 1), TX_COLUMNS.length).getValues();

  var name = 'transactions-' + dateKey(new Date()) + '.csv';
  var folder = snapshotFolder_(String(config.snapshot_folder || 'spendsheet-backups'));
  folder.createFile(name, toCsv_(values), MimeType.CSV);

  ss.toast(name + ' — ' + (rows - 1) + ' rows', 'Snapshot saved', 15);
  return { file: name, rows: rows - 1 };
}

function snapshotFolder_(name) {
  var existing = DriveApp.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : DriveApp.createFolder(name);
}

/**
 * RFC 4180 CSV.
 *
 * Quoting every field rather than only the ones that need it: the rule for
 * when a field needs quoting is exactly the rule that is easy to get subtly
 * wrong, and a restore that silently shifts columns is the worst possible
 * outcome for a backup. Dates go out ISO so they survive any locale.
 */
function toCsv_(rows) {
  return rows.map(function (row) {
    return row.map(function (cell) {
      var text = cell instanceof Date ? dateKey(cell)
        : (cell === null || cell === undefined ? '' : String(cell));
      return '"' + text.replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\n');
}
