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

function setHour(c, value) {
  const config = c.__spreadsheet.getSheetByName('_config');
  config.getRange(c.readColumn_(config, 1).indexOf('sync_hour') + 2, 2).setValue(value);
}

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
    setHour(c, 23);

    c.installTriggers();

    expect(c.__triggers()[0].hour).toBe(23);
  });

  it('runs twice a day when you ask for two hours', () => {
    const c = built();
    setHour(c, '4,16');

    const result = c.installTriggers();

    expect(c.__triggers().map((t) => t.hour)).toEqual([4, 16]);
    expect(result.installed).toHaveLength(2);
  });

  it('says what the second run will and will not fetch', () => {
    // Not "twice the data": a full sync is 3 of the ~4 daily calls a bank
    // allows, so the later run gets transactions only.
    const c = built();
    setHour(c, '4,16');

    const notes = c.installTriggers().notes.join(' ');

    expect(notes).toMatch(/transactions only/);
    expect(notes).not.toMatch(/will be skipped/);
  });

  it('says plainly when a run would do nothing at all', () => {
    // A schedule that quietly does nothing is worse than one that says so.
    const c = built();
    setHour(c, '2,8,14,20');

    const notes = c.installTriggers().notes.join(' ');

    expect(notes).toMatch(/Only 2 of these 4 runs/);
  });

  it('collapses two runs asked for in the same hour', () => {
    // The stacking mistake, spelled differently.
    const c = built();
    setHour(c, '4, 4');

    expect(c.installTriggers().installed).toHaveLength(1);
  });

  it('falls back to a sane hour rather than trusting a bad one', () => {
    // '' is the one worth naming: Number('') is 0, which is a valid hour, so
    // a cleared cell would schedule midnight instead of the default.
    const c = built();

    [99, -1, 'midnight', '', '4,99'].forEach((value) => {
      setHour(c, value);
      c.installTriggers();
      expect(c.__triggers()[0].hour).toBe(4);
      expect(c.__triggers()).toHaveLength(1);
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
