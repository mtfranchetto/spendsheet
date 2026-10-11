/**
 * The alarm.
 *
 * Six failure modes, and none of them catches the others — so each gets its
 * own test, and the ones that can be provoked here are provoked rather than
 * asserted about. Two properties get the most attention: that a detector
 * fires when it should, and that it stays quiet when it shouldn't. The second
 * is not a nicety. An alarm that cries wolf gets ignored, and an ignored alarm
 * is worse than none because you believe you have one.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 6, 31, 9, 0, 0);
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY);

function built() {
  const c = load();
  c.setup();
  return c;
}

function addRun(c, over = {}) {
  const runs = c.__spreadsheet.getSheetByName('_runs');
  c.appendRows_(runs, 1, [c.toRow_(c.RUN_COLUMNS, {
    run_id: 'r', started_at: NOW, trigger: 'scheduled',
    accounts_attempted: 1, accounts_ok: 1, rows_fetched: 5, rows_inserted: 1,
    result: 'OK', ...over
  })]);
}

function addConnection(c, over = {}) {
  const status = c.__spreadsheet.getSheetByName('_status');
  c.appendRows_(status, 1, [c.toRow_(c.STATUS_COLUMNS, {
    connection_id: 'conn-1', provider: 'Illimity', session_id: 'conn-1',
    valid_until: new Date(2027, 0, 1), last_success: NOW, accounts_covered: 1, ...over
  })]);
}

function addTransactions(c, count) {
  const tx = c.__spreadsheet.getSheetByName('transactions');
  c.appendRows_(tx, 1, Array.from({ length: count }, (_, i) =>
    c.toRow_(c.TX_COLUMNS_CODE, { uid: `u${i}`, account_id: 'acc-1', amount: -1 })));
}

const kinds = (findings) => findings.map((f) => f.kind);

describe('failure 5 — it never ran', () => {
  it('says so when the last success is older than the threshold', () => {
    const c = built();
    addRun(c, { started_at: daysAgo(5) });

    expect(kinds(c.runChecks_(NOW))).toContain('never_ran');
  });

  it('stays quiet on a sync that ran this morning', () => {
    const c = built();
    addRun(c);
    expect(kinds(c.runChecks_(NOW))).not.toContain('never_ran');
  });

  it('measures from the last success, not the last attempt', () => {
    // A sync failing every night for a week is not "current".
    const c = built();
    addRun(c, { started_at: daysAgo(5), result: 'OK' });
    addRun(c, { started_at: daysAgo(1), result: 'FAIL' });

    expect(kinds(c.runChecks_(NOW))).toContain('never_ran');
  });

  it('does not complain about a sheet that has never synced', () => {
    // Nothing has gone wrong yet — it is a new spreadsheet.
    const c = built();
    expect(kinds(c.runChecks_(NOW))).not.toContain('never_ran');
  });
});

describe('failure 4 — it ran and fetched nothing', () => {
  it('fires after the threshold of consecutive empty days', () => {
    // The quiet one: a green run that fetched nothing looks identical from
    // the outside to a healthy one.
    const c = built();
    [1, 2, 3].forEach((n) => addRun(c, { started_at: daysAgo(n), rows_fetched: 0 }));

    expect(kinds(c.runChecks_(NOW))).toContain('empty_runs');
  });

  it('tolerates a single quiet day', () => {
    // Most people have days with no transactions. Alerting on that would
    // train you to ignore the alerts.
    const c = built();
    addRun(c, { started_at: daysAgo(2), rows_fetched: 4 });
    addRun(c, { started_at: daysAgo(1), rows_fetched: 0 });

    expect(kinds(c.runChecks_(NOW))).not.toContain('empty_runs');
  });

  it('ignores runs that had no accounts to attempt', () => {
    // Zero rows from zero accounts is not a fetching failure.
    const c = built();
    [1, 2, 3].forEach((n) =>
      addRun(c, { started_at: daysAgo(n), rows_fetched: 0, accounts_attempted: 0 }));

    expect(kinds(c.runChecks_(NOW))).not.toContain('empty_runs');
  });
});

describe('failure 3 — a consent is expiring', () => {
  it('warns before it expires, with days remaining', () => {
    const c = built();
    addConnection(c, { valid_until: new Date(NOW.getTime() + 3 * DAY) });

    const finding = c.runChecks_(NOW).filter((f) => f.kind === 'consent')[0];
    expect(finding.subject).toMatch(/expires in 3 days/);
  });

  it('says plainly when it has already gone', () => {
    const c = built();
    addConnection(c, { valid_until: daysAgo(2) });

    const finding = c.runChecks_(NOW).filter((f) => f.kind === 'consent')[0];
    expect(finding.subject).toMatch(/has expired/);
    // Reassurance belongs next to the alarm: nothing already fetched is lost.
    expect(finding.detail).toMatch(/history/);
  });

  it('counts the days across the spring clock change', () => {
    // 29 March 2026 is 23 hours long in Rome, so the midnights either side of
    // it are a whole day apart on the calendar and not in milliseconds. The
    // zone is pinned because CI runs in UTC, where there is no change to cross.
    const zone = process.env.TZ;
    process.env.TZ = 'Europe/Rome';
    try {
      const c = built();
      const saturday = new Date(2026, 2, 28, 9, 0, 0);
      addConnection(c, { valid_until: new Date(2026, 2, 31, 9, 0, 0) });

      const finding = c.runChecks_(saturday).filter((f) => f.kind === 'consent')[0];
      expect(finding.subject).toMatch(/expires in 3 days/);
    } finally {
      process.env.TZ = zone;
    }
  });

  it('stays quiet on a consent with months left', () => {
    const c = built();
    addConnection(c);
    expect(kinds(c.runChecks_(NOW))).not.toContain('consent');
  });

  it('ignores a manual connection with no expiry at all', () => {
    const c = built();
    addConnection(c, { valid_until: '' });
    expect(kinds(c.runChecks_(NOW))).not.toContain('consent');
  });
});

describe('failure 2 — one bank is broken', () => {
  it('reports what that connection last said', () => {
    const c = built();
    addConnection(c, { last_error: 'the bank returned a 500' });

    const finding = c.runChecks_(NOW).filter((f) => f.kind === 'account_failing')[0];
    expect(finding.detail).toContain('the bank returned a 500');
    expect(finding.subject).toContain('Illimity');
  });

  it('files a dead consent as a consent problem, not a failed sync', () => {
    // "Last sync failed" reads as an incident to wait out. This one is a
    // state: every run fails identically until somebody redoes SCA. Filing
    // it under CONSENT also keeps it from arriving twice, since the expiry
    // detector is looking at the same connection.
    const c = built();
    addConnection(c, { last_error: 'consent expired — reconnect Illimity' });

    const findings = c.runChecks_(NOW);
    expect(findings.filter((f) => f.kind === 'account_failing')).toHaveLength(0);

    const consent = findings.filter((f) => f.kind === 'consent')[0];
    expect(consent.subject).toContain('reconnect needed');
    expect(consent.detail).toContain('the other banks keep syncing');
  });
});

describe('failure 6 — rows disappeared', () => {
  it('notices the count going down', () => {
    // transactions is append-only, so this is never legitimate.
    const c = built();
    addTransactions(c, 10);
    c.rememberRowCount_();

    c.__spreadsheet.getSheetByName('transactions').getRange('A8:A11').clearContent();

    expect(kinds(c.runChecks_(NOW))).toContain('rows_lost');
  });

  it('says nothing when the count grows, which is the normal case', () => {
    const c = built();
    addTransactions(c, 5);
    c.rememberRowCount_();
    addTransactions(c, 3);

    expect(kinds(c.runChecks_(NOW))).not.toContain('rows_lost');
  });

  it('blocks the sync rather than appending on top of a hole', () => {
    // Every run after a loss makes the restore harder.
    const c = built();
    addTransactions(c, 10);
    c.rememberRowCount_();
    c.__spreadsheet.getSheetByName('transactions').getRange('A8:A11').clearContent();

    expect(() => c.syncAll_({})).toThrow(/append-only/);
  });

  it('can be told the smaller sheet is correct', () => {
    // The way out, once you have decided you meant it. Manual on purpose —
    // an automatic reset would make the detector unable to detect anything.
    const c = built();
    addTransactions(c, 10);
    c.rememberRowCount_();
    c.__spreadsheet.getSheetByName('transactions').getRange('A8:A11').clearContent();

    c.acceptRowCount();

    expect(kinds(c.runChecks_(NOW))).not.toContain('rows_lost');
    expect(() => c.syncAll_({})).not.toThrow();
  });

  it('does not fire before anything has ever been recorded', () => {
    const c = built();
    addTransactions(c, 5);
    expect(kinds(c.runChecks_(NOW))).not.toContain('rows_lost');
  });


  it('counts the tab itself, every time', () => {
    // The sync guard must never run on a five-minute-old count — that is the
    // one caller whose whole job is to be right before it appends.
    const c = built();
    addTransactions(c, 10);
    c.rememberRowCount_();
    c.__spreadsheet.getSheetByName('transactions').getRange('A8:A11').clearContent();

    expect(kinds(c.runChecks_(NOW))).toContain('rows_lost');
    expect(() => c.syncAll_({})).toThrow(/append-only/);
  });
});

describe('failure 6 — a deletion that left a copy in _removed', () => {
  // The phone's deletions will come from a writer that cannot reach script
  // properties, so cannot re-baseline the count. What it can do is copy the
  // row to `_removed` first, and that copy is what excuses the drop.
  const tx = (c) => c.__spreadsheet.getSheetByName('transactions');
  const removed = (c) => c.__spreadsheet.getSheetByName('_removed');

  /** Copy the row holding `uid` to `_removed`, as every sanctioned delete does. */
  function archive(c, uid) {
    const row = tx(c).getRange('A2:A').getValues().findIndex((r) => r[0] === uid) + 2;
    const values = tx(c).getRange(row, 1, 1, c.TX_COLUMNS_CODE.length).getValues()[0];
    c.appendRows_(removed(c), 1, [values]);
  }
  function deleteUid(c, uid) {
    const row = tx(c).getRange('A2:A').getValues().findIndex((r) => r[0] === uid) + 2;
    tx(c).deleteRows(row, 1);
  }
  function remembered(c) {
    addTransactions(c, 10);
    c.rememberRowCount_();
  }

  it('passes a loss whose row was copied to _removed first', () => {
    const c = built();
    remembered(c);
    archive(c, 'u4');
    deleteUid(c, 'u4');

    expect(kinds(c.runChecks_(NOW))).not.toContain('rows_lost');
    expect(() => c.syncAll_({})).not.toThrow();
  });

  it('blocks the same loss with no copy', () => {
    const c = built();
    remembered(c);
    deleteUid(c, 'u4');

    expect(kinds(c.runChecks_(NOW))).toContain('rows_lost');
    expect(() => c.syncAll_({})).toThrow(/append-only/);
  });

  it('blocks when fewer rows were copied than went missing', () => {
    const c = built();
    remembered(c);
    archive(c, 'u4');
    deleteUid(c, 'u4');
    deleteUid(c, 'u5');

    const lost = c.runChecks_(NOW).filter((f) => f.kind === 'rows_lost');
    expect(lost).toHaveLength(1);
    expect(lost[0].detail).toContain('1 of the missing rows have a copy in _removed');
  });

  it('does not let a copy whose row is still there excuse another row', () => {
    // A delete that copied and then failed leaves an archive row for a uid that
    // never left. Counted, it would excuse some other row's disappearance.
    const c = built();
    remembered(c);
    archive(c, 'u3');
    deleteUid(c, 'u4');

    expect(kinds(c.runChecks_(NOW))).toContain('rows_lost');
  });

  it('does not let a copy made before the count was remembered excuse a new loss', () => {
    const c = built();
    addTransactions(c, 10);
    archive(c, 'u4');
    deleteUid(c, 'u4');
    c.rememberRowCount_();
    archive(c, 'u5');
    deleteUid(c, 'u5');
    deleteUid(c, 'u6');

    // u5 is accounted for; u6 is not, and u4's old copy must not stand in for it.
    expect(kinds(c.runChecks_(NOW))).toContain('rows_lost');
  });

  it('counts one row copied twice as one', () => {
    const c = built();
    remembered(c);
    archive(c, 'u4');
    archive(c, 'u4');
    deleteUid(c, 'u4');
    deleteUid(c, 'u5');

    expect(kinds(c.runChecks_(NOW))).toContain('rows_lost');
  });

  it('excuses nothing on a book whose _removed count was never remembered', () => {
    // `Number(null)` is 0, which would count every row the archive has ever
    // held as new — and one old copy would excuse one real loss.
    const c = built();
    addTransactions(c, 10);
    archive(c, 'u9');
    c.rememberRowCount_();
    c.PropertiesService.getScriptProperties().deleteProperty('MONITOR_REMOVED_COUNT');
    archive(c, 'u4');
    deleteUid(c, 'u4');

    expect(kinds(c.runChecks_(NOW))).toContain('rows_lost');
  });

  it('gets a baseline from setup(), so the first hand delete after an upgrade is excused', () => {
    // Otherwise the sync this blocks is the one that would have recorded it.
    const c = built();
    addTransactions(c, 10);
    archive(c, 'u9');
    c.rememberRowCount_();
    c.PropertiesService.getScriptProperties().deleteProperty('MONITOR_REMOVED_COUNT');

    c.setup();
    archive(c, 'u4');
    deleteUid(c, 'u4');

    expect(kinds(c.runChecks_(NOW))).not.toContain('rows_lost');
  });

  it('leaves an existing baseline where it is when setup() runs again', () => {
    const c = built();
    remembered(c);
    archive(c, 'u4');
    c.setup();
    deleteUid(c, 'u4');

    // Moving the baseline to today's count would put u4's copy behind it, and
    // a delete made properly would block the sync.
    expect(kinds(c.runChecks_(NOW))).not.toContain('rows_lost');
  });

  it('leaves the archive unread when the count has not gone down', () => {
    const c = built();
    remembered(c);
    c.__resetReads();

    c.runChecks_(NOW);
    expect(c.__reads('_removed')).toBe(0);
  });

  it('mirrors both remembered counts into _monitor for the phone', () => {
    const c = built();
    remembered(c);
    const monitor = c.__spreadsheet.getSheetByName('_monitor');
    expect(monitor.getRange('A1:B2').getValues()).toEqual([
      ['transactions_rows', 'removed_rows'], [10, 0]]);

    archive(c, 'u4');
    deleteUid(c, 'u4');
    c.rememberRowCount_();
    expect(monitor.getRange('A2:B2').getValues()).toEqual([[9, 1]]);
    expect(monitor.isSheetHidden()).toBe(true);
  });
});

describe('alerting', () => {
  it('emails the finding to the account owner by default', () => {
    const c = built();
    addConnection(c, { valid_until: daysAgo(1) });

    c.selfCheck();

    expect(c.__sentMail).toHaveLength(1);
    expect(c.__sentMail[0].to).toBe('you@example.com');
    expect(c.__sentMail[0].subject).toMatch(/^spendsheet: /);
  });

  it('prefers the address you configured', () => {
    const c = built();
    const config = c.__spreadsheet.getSheetByName('_config');
    config.getRange(c.readColumn_(config, 1).indexOf('alert_email') + 2, 2).setValue('me@example.org');
    addConnection(c, { valid_until: daysAgo(1) });

    c.selfCheck();

    expect(c.__sentMail[0].to).toBe('me@example.org');
  });

  it('sends each alert once a day, not once a check', () => {
    // A free account allows 100 emails a day. A persistent failure checked
    // hourly would burn that in an afternoon and then go silent.
    const c = built();
    addConnection(c, { valid_until: daysAgo(1) });

    c.selfCheck();
    c.selfCheck();
    c.selfCheck();

    expect(c.__sentMail).toHaveLength(1);
  });

  it('keeps alerts for different connections separate', () => {
    const c = built();
    addConnection(c, { connection_id: 'a', provider: 'Illimity', valid_until: daysAgo(1) });
    addConnection(c, { connection_id: 'b', provider: 'Revolut', valid_until: daysAgo(1) });

    c.selfCheck();

    expect(c.__sentMail).toHaveLength(2);
  });

  it('does not let a failure to send become the failure', () => {
    const c = load({ mailQuota: 0 });
    c.setup();
    c.MailApp.sendEmail = () => { throw new Error('quota exceeded'); };
    addConnection(c, { valid_until: daysAgo(1) });

    expect(() => c.selfCheck()).not.toThrow();
  });
});

describe('healthCheck', () => {
  it('reports rather than emails', () => {
    const c = built();
    addConnection(c, { valid_until: daysAgo(1) });

    const findings = c.healthCheck();

    expect(findings).toHaveLength(1);
    expect(c.__sentMail).toHaveLength(0);
  });

  it('says so plainly when there is nothing wrong', () => {
    const c = built();
    // Every other test here hands `runChecks_` its own clock. `healthCheck`
    // reads the real one, so the run it is meant to be happy about has to be
    // dated from the real one too — pinned to NOW, this passed until the day
    // NOW fell outside `max_sync_age_days` and then failed for a reason that
    // had nothing to do with the code.
    addRun(c, { started_at: new Date() });
    addConnection(c, { last_success: new Date() });

    expect(c.healthCheck()).toEqual([]);
    expect(c.__spreadsheet.toasts.pop().message).toMatch(/Nothing to report/);
  });
});

describe('snapshotToDrive', () => {
  it('writes a CSV of transactions into a Drive folder', () => {
    // Version history is 30 days or 100 revisions, whichever comes first —
    // a daily sync burns 100 revisions in about three months.
    const c = built();
    addTransactions(c, 3);

    const result = c.snapshotToDrive();

    expect(result.rows).toBe(3);
    expect(c.__driveFiles).toHaveLength(1);
    expect(c.__driveFiles[0].name).toMatch(/^transactions-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(c.__driveFiles[0].mime).toBe('text/csv');
  });

  it('includes the header row, so the file restores into a blank sheet', () => {
    const c = built();
    addTransactions(c, 1);
    c.snapshotToDrive();

    expect(c.__driveFiles[0].content.split('\n')[0]).toContain('"uid"');
  });

  it('reuses the folder instead of making a new one each week', () => {
    const c = built();
    addTransactions(c, 1);
    c.snapshotToDrive();
    c.snapshotToDrive();

    expect(c.__driveFiles).toHaveLength(2);
    expect(c.__driveFolders).toHaveLength(1);
  });

  it('still writes the file when the folder is refused for want of a scope', () => {
    // The folder is tidiness; the file is the backup. This used to be the
    // whole story of the snapshot's failure, and it was the smaller half —
    // `DriveApp.createFolder` is refused without the full `drive` scope, and
    // so is `DriveApp.createFile`, so the fallback this test covers had
    // nowhere to fall back to. Both go over the Drive REST API now, which
    // `drive.file` does answer for, and the test survives because the
    // reasoning did: a refusal here must cost the folder and not the file.
    const c = load({ refuseDriveFolders: true });
    c.setup();
    addTransactions(c, 2);

    const result = c.snapshotToDrive();

    expect(result.where).toBe('My Drive');
    expect(c.__driveFiles).toHaveLength(1);
    expect(c.__driveFiles[0].content.split('\n')[0]).toContain('"uid"');
  });

  it('makes a new folder when the remembered one has been deleted', () => {
    // Not an error worth alerting about: the id simply stops resolving, and
    // the recovery is the same thing the first run did.
    const c = built();
    addTransactions(c, 1);
    c.snapshotToDrive();

    c.__driveFolders[0].trashed = true;
    c.snapshotToDrive();

    expect(c.__driveFolders).toHaveLength(2);
    expect(c.__driveFiles).toHaveLength(2);
  });

  it('files the CSV in the folder rather than only making one', () => {
    // The folder id has to reach the upload as `parents`. Without it Drive
    // takes the file happily and puts it in My Drive, so the folder exists,
    // the call succeeds, and the backups are not in it.
    const c = built();
    addTransactions(c, 1);
    c.snapshotToDrive();

    expect(c.__driveFiles[0].parent).toBe(c.__driveFolders[0].id);
  });

  it('goes through the advanced service, not hand-rolled HTTP', () => {
    // Both reach the same endpoint and only one of them arranges to be allowed
    // to: declaring the dependency is what gets the Drive API enabled in a
    // default Cloud project. A snapshot written with UrlFetchApp passed every
    // test here and then failed live, because the API was switched off and the
    // scope list — the thing everyone checks — was correct all along.
    const c = built();
    addTransactions(c, 1);
    c.snapshotToDrive();

    expect(c.__fetches.filter((f) => f.url.includes('googleapis.com/drive'))).toHaveLength(0);
    expect(c.__driveWrites).toHaveLength(1);
  });

  it('throws when Drive refuses the file, rather than reporting a backup', () => {
    // A snapshot that cannot be written must fail loudly. It did fail loudly
    // before too — what it did not do was fail in a way anyone could act on,
    // because the error named the folder and the fix was not about folders.
    const c = built();
    addTransactions(c, 1);
    c.Drive.Files.create = () => { throw new Error('Insufficient Permission'); };

    expect(() => c.snapshotToDrive()).toThrow(/Insufficient Permission/);
  });

  it('says how to switch the API on, and does not send you to the console', () => {
    // The live failure this arrangement was built for. It is not a consent
    // problem, so naming permissions would send the reader to the scope list —
    // the one place with nothing wrong. And the console link Google puts in
    // the message is a dead end here: the project is a default one, which the
    // console will not open, so the only route is the editor's Services list.
    const c = built();
    addTransactions(c, 1);
    c.Drive.Files.create = () => {
      throw new Error('GoogleJsonResponseException: API call to drive.files.create failed ' +
        'with error: Google Drive API has not been used in project 000000000000 before ' +
        'or it is disabled.');
    };

    expect(() => c.snapshotToDrive()).toThrow(/Services \(\+\) → Drive API → v3/);
    expect(() => c.snapshotToDrive()).toThrow(/not a scope problem/);
  });
});

describe('checkSnapshotPermitted_', () => {
  it('proves the write by making a file and removing it again', () => {
    // The check a fake cannot stand in for, which is why it runs from the
    // smoke tests against a real book. Here it can only be proved to clean up.
    const c = built();

    expect(c.checkSnapshotPermitted_()).toMatch(/backup folder/);
    expect(c.__driveWrites).toHaveLength(1);
    expect(c.__driveFiles).toHaveLength(0);
  });

  it('removes the probe by id, so a failed delete cannot pass unnoticed', () => {
    // `remove` throws on an id Drive does not hold. A check that swallowed
    // that would leave a probe file per run in the backup folder, which is the
    // one folder whose contents are supposed to mean something.
    const c = built();
    const removed = [];
    const real = c.Drive.Files.remove;
    c.Drive.Files.remove = (id) => { removed.push(id); return real(id); };

    c.checkSnapshotPermitted_();

    expect(removed).toEqual(['file-1']);
  });

  it('checks the file even when the folder cannot be made', () => {
    const c = load({ refuseDriveFolders: true });
    c.setup();

    expect(c.checkSnapshotPermitted_()).toMatch(/My Drive/);
    expect(c.__driveWrites).toHaveLength(1);
  });

  it('does not write a transaction into the probe', () => {
    // It is a permission check, not a backup. A check that costs a full CSV
    // of `transactions` is a check nobody runs.
    const c = built();
    addTransactions(c, 3);
    c.checkSnapshotPermitted_();

    expect(c.__driveWrites[0].mime).toBe('text/plain');
    expect(c.__driveWrites[0].content).not.toContain('"uid"');
  });
});

describe('toCsv_', () => {
  it('quotes every field, so a comma or newline cannot shift a column', () => {
    // The rule for when a field needs quoting is exactly the rule that is
    // easy to get subtly wrong, and a restore that shifts columns silently is
    // the worst outcome a backup can have.
    const c = built();
    expect(c.toCsv_([['a', 'b,c']])).toBe('"a","b,c"');
    expect(c.toCsv_([['say "hi"']])).toBe('"say ""hi"""');
    expect(c.toCsv_([['line\nbreak']])).toBe('"line\nbreak"');
  });

  it('writes dates ISO, so they survive any locale', () => {
    const c = built();
    expect(c.toCsv_([[new Date(2026, 6, 28)]])).toBe('"2026-07-28"');
  });
});
