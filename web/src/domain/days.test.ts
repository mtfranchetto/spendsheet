import { describe, expect, it } from 'vitest';
import { clockAt, dayKey, dayOf, serialOf, timeOfDay } from './days';

const ROME = 'Europe/Rome';

describe('serial dates', () => {
  it('floors a serial to its day, whatever the fraction', () => {
    // 46108 is 2026-03-27. A UTC midnight written into a Rome book is 02:00
    // there, and a noon booking is .5 — both are the 27th, never the 28th.
    expect(dayKey(dayOf(46108, ROME))).toBe('2026-03-27');
    expect(dayKey(dayOf(46108 + 2 / 24, ROME))).toBe('2026-03-27');
    expect(dayKey(dayOf(46108.9999, ROME))).toBe('2026-03-27');
  });

  it('reads a blank, a boolean or text that is no date as no date, never as 1970', () => {
    for (const value of ['', '   ', null, undefined, true, false, 'soon']) expect(dayOf(value, ROME)).toBeNull();
  });

  it('takes a bare yyyy-MM-dd as that calendar day in any zone', () => {
    expect(dayKey(dayOf('2026-01-05', 'America/New_York'))).toBe('2026-01-05');
    expect(serialOf('2026-03-27', ROME)).toBe(46108);
  });

  it('reads an instant on the book clock', () => {
    // 23:30 UTC on New Year's Eve is already the 1st in Rome.
    expect(dayKey(dayOf('2025-12-31T23:30:00Z', ROME))).toBe('2026-01-01');
  });
});

describe('time of day', () => {
  it('is the fraction on the wall clock, to the minute', () => {
    expect(timeOfDay(46108 + (8 * 60 + 5) / 1440, ROME)).toBe('08:05');
    expect(timeOfDay(46108 + (23 * 60 + 59) / 1440, ROME)).toBe('23:59');
  });

  it('survives a float that lands a hair under the minute', () => {
    expect(timeOfDay(46108 + (8 * 60 + 5) / 1440 - 1e-9, ROME)).toBe('08:05');
  });

  it('is blank at midnight, which a date with no time also is', () => {
    expect(timeOfDay(46108, ROME)).toBe('');
    expect(timeOfDay('', ROME)).toBe('');
  });
});

describe("the book's clock", () => {
  it('is the book zone, not the device', () => {
    // 00:30 in Rome on 1 January is still New Year's Eve in New York.
    const instant = new Date('2025-12-31T23:30:00Z');
    const rome = clockAt(instant, ROME);
    const newYork = clockAt(instant, 'America/New_York');

    expect([rome.year, rome.month, rome.date, dayKey(rome.today)]).toEqual([2026, 0, 1, '2026-01-01']);
    expect([newYork.year, newYork.month, newYork.date]).toEqual([2025, 11, 31]);
  });

  it('counts the weekday from Sunday, as Date does', () => {
    expect(clockAt(new Date('2026-09-27T10:00:00Z'), ROME).weekday).toBe(0);
    expect(clockAt(new Date('2026-09-28T10:00:00Z'), ROME).weekday).toBe(1);
  });

  it('agrees with the serial for the same day', () => {
    const clock = clockAt(new Date('2026-03-27T12:00:00Z'), ROME);
    expect(clock.today).toBe(dayOf(46108, ROME));
  });
});
