/**
 * The schedule.
 *
 * Short, but the one property here is worth protecting: installing twice must
 * not leave two triggers behind. Two nightly syncs is double the API calls,
 * straight into a rate limit whose penalty is measured in hours, reported as
 * nothing at all.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

function built() {
  const c = load();
  c.setup();
  return c;
}

const handlers = (c) => c.__triggers().map((t) => t.getHandlerFunction());

describe('installTriggers', () => {
  it('schedules the daily sync', () => {
    const c = built();
    const result = c.installTriggers();

    expect(handlers(c)).toEqual(['syncScheduled']);
    expect(c.__triggers()[0].type).toBe('every 1d');
    expect(result.installed[0].hour).toBe(4);
  });

  it('replaces its own triggers instead of stacking them', () => {
    const c = built();
    c.installTriggers();
    c.installTriggers();
    const result = c.installTriggers();

    expect(handlers(c)).toEqual(['syncScheduled']);
    expect(result.removed).toBe(1);
  });

  it('leaves a trigger you added yourself alone', () => {
    // Deleting an unrelated trigger because it happened to live in the same
    // project would be a genuinely nasty surprise.
    const c = built();
    c.ScriptApp.newTrigger('myOwnThing').timeBased().everyDays(1).atHour(12).create();

    c.installTriggers();

    expect(handlers(c)).toContain('myOwnThing');
    expect(handlers(c)).toContain('syncScheduled');
  });

  it('skips phases that have not landed', () => {
    // selfCheck is phase 8. Scheduling a function that does not exist would
    // fail nightly, by email, forever.
    const c = built();
    c.installTriggers();

    expect(handlers(c)).not.toContain('selfCheck');
  });

  it('runs at the hour you set in _config', () => {
    const c = built();
    const config = c.__spreadsheet.getSheetByName('_config');
    config.getRange(c.readColumn_(config, 1).indexOf('sync_hour') + 2, 2).setValue(23);

    c.installTriggers();

    expect(c.__triggers()[0].hour).toBe(23);
  });

  it('falls back to a sane hour rather than trusting a bad one', () => {
    const c = built();
    const config = c.__spreadsheet.getSheetByName('_config');
    const row = c.readColumn_(config, 1).indexOf('sync_hour') + 2;

    [99, -1, 'midnight', ''].forEach((value) => {
      config.getRange(row, 2).setValue(value);
      c.installTriggers();
      expect(c.__triggers()[0].hour).toBe(4);
    });
  });
});

describe('describeTriggers', () => {
  it('says nothing is scheduled when nothing is', () => {
    const c = built();
    expect(c.describeTriggers()).toEqual([]);
    expect(c.__spreadsheet.toasts.pop().message).toMatch(/Install triggers/);
  });

  it('names what is scheduled, and the limit of what Google will tell you', () => {
    const c = built();
    c.installTriggers();

    expect(c.describeTriggers()).toEqual(['syncScheduled']);
    // Nothing inside a script can report that the script is not running.
    expect(c.__spreadsheet.toasts.pop().message).toMatch(/does not email/);
  });
});
