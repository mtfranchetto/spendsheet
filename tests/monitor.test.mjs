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
    addConnection(c, { last_error: 'consent expired' });

    const finding = c.runChecks_(NOW).filter((f) => f.kind === 'account_failing')[0];
    expect(finding.detail).toContain('consent expired');
    expect(finding.subject).toContain('Illimity');
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

    expect(() => c.syncAll({})).toThrow(/append-only/);
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
    expect(() => c.syncAll({})).not.toThrow();
  });

  it('does not fire before anything has ever been recorded', () => {
    const c = built();
    addTransactions(c, 5);
    expect(kinds(c.runChecks_(NOW))).not.toContain('rows_lost');
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
    addRun(c);
    addConnection(c);

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
    expect(c.DriveApp.getFoldersByName('spendsheet-backups').hasNext()).toBe(true);
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
