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

/** Triggers by what they run, never by position: position is install order. */
const triggersFor = (c, fn) => c.__triggers().filter((t) => t.getHandlerFunction() === fn);

function setHour(c, value, key = 'sync_hour') {
  const config = c.__spreadsheet.getSheetByName('_config');
  config.getRange(c.readColumn_(config, 1).indexOf(key) + 2, 2).setValue(value);
}

describe('installTriggers', () => {
  it('schedules the daily sync', () => {
    const c = built();
    const result = c.installTriggers();

    expect(handlers(c)).toContain('syncScheduled');
    expect(triggersFor(c, 'syncScheduled')[0].type).toBe('every 1d');
    expect(result.installed.filter((e) => e.fn === 'syncScheduled')[0].hour).toBe(4);
  });

  it('gives the self-check its own trigger, not a step inside the sync', () => {
    // Inside the sync, a crash would take the alarm down with it — precisely
    // the failure where you most need to hear something.
    const c = built();
    c.installTriggers();

    expect(handlers(c)).toContain('selfCheck');
    expect(c.__triggers().filter((t) => t.getHandlerFunction() === 'selfCheck')[0].type)
      .toBe('every 1d');
  });

  it('runs the snapshot weekly rather than daily', () => {
    const c = built();
    c.installTriggers();

    const snapshot = c.__triggers().filter((t) => t.getHandlerFunction() === 'snapshotToDrive');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].type).toBe('every 1w');
  });

  it('runs the self-check after the sync, so it has something to check', () => {
    const c = built();
    const result = c.installTriggers();
    const at = (fn) => result.installed.filter((e) => e.fn === fn)[0].hour;

    expect(at('selfCheck')).toBeGreaterThan(at('syncScheduled'));
  });

  it('rebuilds memory on its own trigger, before the sync that uses it', () => {
    // Its own trigger for the self-check's reason: a failure in learning must
    // not take the sync down. Before it, so tonight's rows are categorised
    // with today's corrections.
    const c = built();
    const result = c.installTriggers();
    const at = (fn) => result.installed.filter((e) => e.fn === fn)[0].hour;

    expect(triggersFor(c, 'learnScheduled')).toHaveLength(1);
    expect(triggersFor(c, 'learnScheduled')[0].type).toBe('every 1d');
    expect(at('learnScheduled')).toBe(3);
    expect(at('learnScheduled')).toBeLessThan(at('syncScheduled'));
  });

  it('falls back to each schedule\'s own hour, not one they all share', () => {
    // A cleared learn_hour that fell back to the sync's hour would put both in
    // one hour at random minutes — learning after the sync half the time, with
    // nothing anywhere saying so.
    const c = built();

    ['', 'midnight', 99].forEach((value) => {
      setHour(c, value, 'learn_hour');
      setHour(c, value, 'selfcheck_hour');
      c.installTriggers();
      expect(triggersFor(c, 'learnScheduled')[0].hour).toBe(3);
      expect(triggersFor(c, 'selfCheck')[0].hour).toBe(9);
    });
  });

  it('replaces its own triggers instead of stacking them', () => {
    const c = built();
    const first = c.installTriggers().installed.length;
    c.installTriggers();
    const result = c.installTriggers();

    expect(c.__triggers()).toHaveLength(first);
    expect(result.removed).toBe(first);
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

  it('skips anything that has not landed', () => {
    // Scheduling a function that does not exist would fail nightly, by
    // email, forever. Everything in SCHEDULED exists as of phase 8, so the
    // guard is asserted directly rather than through an absent phase.
    const c = built();
    c.installTriggers();

    handlers(c).forEach((fn) => expect(c.functionExists_(fn)).toBe(true));
  });

  it('runs at the hour you set in _config', () => {
    const c = built();
    setHour(c, 23);

    c.installTriggers();

    expect(triggersFor(c, 'syncScheduled')[0].hour).toBe(23);
  });

  it('runs twice a day when you ask for two hours', () => {
    const c = built();
    setHour(c, '4,16');

    const result = c.installTriggers();

    expect(result.installed.filter((e) => e.fn === 'syncScheduled').map((e) => e.hour))
      .toEqual([4, 16]);
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

    expect(c.installTriggers().installed.filter((e) => e.fn === 'syncScheduled'))
      .toHaveLength(1);
  });

  it('falls back to a sane hour rather than trusting a bad one', () => {
    // '' is the one worth naming: Number('') is 0, which is a valid hour, so
    // a cleared cell would schedule midnight instead of the default.
    const c = built();

    [99, -1, 'midnight', '', '4,99'].forEach((value) => {
      setHour(c, value);
      c.installTriggers();
      expect(triggersFor(c, 'syncScheduled')[0].hour).toBe(4);
      expect(triggersFor(c, 'syncScheduled')).toHaveLength(1);
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

    expect(c.describeTriggers()).toContain('syncScheduled');
    // Nothing inside a script can report that the script is not running.
    expect(c.__spreadsheet.toasts.pop().message).toMatch(/does not email/);
  });
});
