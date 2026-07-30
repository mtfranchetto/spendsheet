/**
 * The spreadsheet primitives.
 *
 * Small enough to look obviously correct, which is exactly why they get their
 * own file: the one that wasn't cost an account three orders of magnitude of
 * row position while every run reported success. `getLastRow()` is not a
 * record count on a tab carrying an open-ended ARRAYFORMULA, and every
 * function here exists to avoid depending on it.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

function built() {
  const c = load();
  c.setup();
  return c;
}

describe('lastRecordRow_', () => {
  it('ignores a formula that makes the tab look full', () => {
    const c = built();
    const accounts = c.__spreadsheet.getSheetByName('accounts');

    // Sheets reports the ARRAYFORMULA row as content. It is not a record.
    expect(accounts.getLastRow()).toBeGreaterThan(1);
    expect(c.lastRecordRow_(accounts, 1)).toBe(1);
  });

  it('finds the last row that actually holds a key', () => {
    const c = built();
    const runs = c.__spreadsheet.getSheetByName('_runs');
    runs.getRange('A2').setValue('one');
    runs.getRange('A3').setValue('two');

    expect(c.lastRecordRow_(runs, 1)).toBe(3);
  });
});

describe('appendRows_', () => {
  it('starts at row 2 on a tab whose row 2 is a formula', () => {
    const c = built();
    const accounts = c.__spreadsheet.getSheetByName('accounts');

    c.appendRows_(accounts, 1, [['acc-1', 'Mine']]);

    expect(accounts.getRange('A2').getValue()).toBe('acc-1');
    expect(accounts.getRange('J2').getFormula()).toContain('ARRAYFORMULA');
  });

  it('never fills a gap left by a deleted row', () => {
    // Appending into the middle of an append-only log would break insert
    // order permanently, and insert order is what every row's identity and
    // every note attached to it depends on.
    const c = built();
    const runs = c.__spreadsheet.getSheetByName('_runs');
    runs.getRange('A2').setValue('one');
    runs.getRange('A3').setValue('two');
    runs.getRange('A2').clearContent();

    const result = c.appendRows_(runs, 1, [['three']]);

    expect(result.row).toBe(4);
    expect(runs.getRange('A2').getValue()).toBe('');
  });

  it('refuses a ragged batch rather than writing a misaligned block', () => {
    const c = built();
    const runs = c.__spreadsheet.getSheetByName('_runs');
    expect(() => c.appendRows_(runs, 1, [['a', 'b'], ['c']])).toThrow(/expected 2/);
  });

  it('writes nothing, and reports nothing, for an empty batch', () => {
    const c = built();
    const runs = c.__spreadsheet.getSheetByName('_runs');
    expect(c.appendRows_(runs, 1, [])).toEqual({ row: null, count: 0 });
  });
});

describe('nextEmptyRow_', () => {
  it('does reuse a gap, because upserts are not appends', () => {
    // The opposite rule from appendRows_, deliberately: `accounts` is small,
    // hand-edited, and deleting a row there should leave a slot behind.
    const c = built();
    const runs = c.__spreadsheet.getSheetByName('_runs');
    runs.getRange('A2').setValue('one');
    runs.getRange('A3').setValue('two');
    runs.getRange('A2').clearContent();

    expect(c.nextEmptyRow_(runs, 1)).toBe(2);
  });
});

describe('clearDataRows_ and trimToLastRows_', () => {
  it('blanks the data and keeps the header', () => {
    const c = built();
    const pending = c.__spreadsheet.getSheetByName('pending');
    c.appendRows_(pending, 1, [c.toRow_(c.PENDING_COLUMNS, { uid: 'a' })]);

    c.clearDataRows_(pending, 1, c.PENDING_COLUMNS.length);

    expect(pending.getRange('A1').getValue()).toBe('uid');
    expect(pending.getRange('A2').getValue()).toBe('');
  });

  it('keeps the newest rows when a log outgrows its limit', () => {
    const c = built();
    const runs = c.__spreadsheet.getSheetByName('_runs');
    c.appendRows_(runs, 1, [['a'], ['b'], ['c'], ['d']].map((r) => [r[0], '', '']));

    const dropped = c.trimToLastRows_(runs, 1, 3, 2);

    expect(dropped).toBe(2);
    expect(c.readColumn_(runs, 1)).toEqual(['c', 'd']);
  });
});

describe('readRecords_', () => {
  it('reads the schema block and leaves your own columns alone', () => {
    const c = built();
    const runs = c.__spreadsheet.getSheetByName('_runs');
    c.appendRows_(runs, 1, [c.toRow_(c.RUN_COLUMNS, { run_id: 'r1', result: 'OK' })]);
    runs.getRange(2, c.RUN_COLUMNS.length + 1).setValue('my own note');

    const records = c.readRecords_(runs, c.RUN_COLUMNS);

    expect(records).toHaveLength(1);
    expect(records[0].run_id).toBe('r1');
    expect(records[0].result).toBe('OK');
    expect(records[0]._row).toBe(2);
    expect(Object.values(records[0])).not.toContain('my own note');
  });
});

describe('_config', () => {
  it('reads what you typed over what we seeded', () => {
    const c = built();
    const config = c.__spreadsheet.getSheetByName('_config');
    const row = c.readColumn_(config, 1).indexOf('sync_window_days') + 2;
    config.getRange(row, 2).setValue(30);

    expect(c.configNumber_(c.readConfig_(), 'sync_window_days')).toBe(30);
  });

  it('treats a cleared cell as the default, not as zero', () => {
    // A zero-day sync window fetches nothing and looks exactly like a
    // working sync.
    const c = built();
    const config = c.__spreadsheet.getSheetByName('_config');
    const row = c.readColumn_(config, 1).indexOf('sync_window_days') + 2;
    config.getRange(row, 2).clearContent();

    expect(c.configNumber_(c.readConfig_(), 'sync_window_days')).toBe(90);
  });

  it('accepts the several ways a person writes yes', () => {
    const c = built();
    ['yes', 'YES', 'true', '1', 'sì', true].forEach((value) => {
      expect(c.configFlag_({ fetch_pending: value }, 'fetch_pending')).toBe(true);
    });
    ['no', '', 'off', false, null].forEach((value) => {
      expect(c.configFlag_({ fetch_pending: value }, 'fetch_pending')).toBe(false);
    });
  });
});

describe('logAnomaly_', () => {
  it('records the thing it could not interpret', () => {
    const c = built();
    c.logAnomaly_(c.ANOMALY_KIND.RAW_DUMP, 'acc-1', 'something odd', { a: 1 });

    const anomalies = c.__spreadsheet.getSheetByName('_anomalies');
    expect(anomalies.getRange('B2').getValue()).toBe('acc-1');
    expect(anomalies.getRange('C2').getValue()).toBe('raw_dump');
    expect(anomalies.getRange('E2').getValue()).toBe('{"a":1}');
  });

  it('truncates a payload rather than losing the row to it', () => {
    const c = built();
    c.logAnomaly_(c.ANOMALY_KIND.RAW_DUMP, '', 'huge', 'x'.repeat(60000));

    const cell = c.__spreadsheet.getSheetByName('_anomalies').getRange('E2').getValue();
    expect(cell.length).toBeLessThan(50000);
    expect(cell).toMatch(/truncated/);
  });

  it('never throws, even with no tab to write to', () => {
    // A failure to log an anomaly must not become the thing that breaks the
    // run it was reporting on.
    const c = load();
    expect(() => c.logAnomaly_('kind', '', 'detail', {})).not.toThrow();
  });
});
