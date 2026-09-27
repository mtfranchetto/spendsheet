/**
 * days.ts — dates as the Sheets API sends them, and "today" as the book means it.
 *
 * ## Serials, not Dates
 *
 * The read asks for `SERIAL_NUMBER` dates, so a date arrives as days since
 * 30 December 1899 with the time of day as the fraction. That is the book's own
 * wall clock — no instant, no timezone — which makes it the easy case:
 *
 *   day number = floor(serial − 25569)
 *
 * is whole days since 1970-01-01 in local terms, and the fraction is the time of day on that clock. **Floor, not
 * round**: existing booking dates carry fractions (a UTC midnight written into
 * a Rome book reads as 02:00), and rounding would move every one of those
 * that fell after noon into the next day.
 *
 * `new Date(45678)` is 45 seconds after the epoch, not a day in 2025, so
 * nothing here goes through `Date` on the way in.
 *
 * ## Whose today
 *
 * The book's, from its spreadsheet properties — not the phone's. A phone set
 * to New York at 01:00 in Rome is still on yesterday, and "this month" on the
 * 1st would be last month on it. `clockAt` turns an instant into the book's
 * calendar through `Intl`, once, and everything downstream takes the clock.
 */

import type { Cell } from '../sheets/records';
import { isBlankCell } from './cells';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** 1970-01-01 as a Sheets serial. */
export const SERIAL_EPOCH = 25569;

/** The book's calendar at one instant. `month` is 0–11 and `weekday` 0 is Sunday, as `Date` has them. */
export type Clock = {
  today: number;
  year: number;
  month: number;
  date: number;
  weekday: number;
  timeZone: string;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      weekday: 'short',
      hourCycle: 'h23'
    });
    formatters.set(timeZone, format);
  }
  return format;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Fields = { year: number; month: number; date: number; hours: number; minutes: number; seconds: number; weekday: number };

/** An instant's wall-clock fields in `timeZone`. */
function fieldsAt(instant: Date, timeZone: string): Fields {
  const parts: { [type: string]: string } = {};
  for (const part of formatterFor(timeZone).formatToParts(instant)) parts[part.type] = part.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month) - 1,
    date: Number(parts.day),
    hours: Number(parts.hour),
    minutes: Number(parts.minute),
    seconds: Number(parts.second),
    weekday: WEEKDAYS.indexOf(parts.weekday)
  };
}

/** The book's calendar at `now`. */
export function clockAt(now: Date, timeZone: string): Clock {
  const f = fieldsAt(now, timeZone);
  return {
    today: Math.floor(Date.UTC(f.year, f.month, f.date) / MS_PER_DAY),
    year: f.year,
    month: f.month,
    date: f.date,
    weekday: f.weekday,
    timeZone
  };
}

/**
 * A date cell as a serial — the book's wall clock, fraction and all.
 *
 * A string is what a cell holds when somebody typed a date Sheets did not
 * recognise, or an import wrote text. `yyyy-MM-dd` on its own names a calendar
 * day and is taken as one; anything else `Date` can parse is an instant, read
 * on the book's clock. A number is already a serial. Anything else — a blank,
 * a boolean, text that is not a date — is no date at all, rather than a
 * phantom 1970 at one end of every window.
 */
export function serialOf(value: Cell | undefined, timeZone: string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || isBlankCell(value)) return null;

  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) / MS_PER_DAY + SERIAL_EPOCH;

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  const f = fieldsAt(instant, timeZone);
  return Date.UTC(f.year, f.month, f.date, f.hours, f.minutes, f.seconds) / MS_PER_DAY + SERIAL_EPOCH;
}

/** A date cell as a day number, or null. See the header on floor. */
export function dayOf(value: Cell | undefined, timeZone: string): number | null {
  const serial = serialOf(value, timeZone);
  return serial === null ? null : Math.floor(serial - SERIAL_EPOCH);
}

/**
 * `HH:mm`, or blank when the cell knows only its day.
 *
 * Midnight exactly reads as no time, since a date with no time is midnight
 * too. Seconds are rounded off the fraction
 * first, because `8:05` stored as a float comes back as 8:04:59.99999.
 */
export function timeOfDay(value: Cell | undefined, timeZone: string): string {
  const serial = serialOf(value, timeZone);
  if (serial === null) return '';
  const seconds = Math.round((serial - Math.floor(serial)) * 86400) % 86400;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (!hours && !minutes) return '';
  return pad2(hours) + ':' + pad2(minutes);
}

/** A day number back to `yyyy-MM-dd`, which is what crosses the wire. */
export function dayKey(day: number | null | undefined): string {
  if (day === null || day === undefined) return '';
  const date = new Date(day * MS_PER_DAY);
  return date.getUTCFullYear() + '-' + pad2(date.getUTCMonth() + 1) + '-' + pad2(date.getUTCDate());
}

export function monthKey(day: number): string {
  return dayKey(day).slice(0, 7);
}

export function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

/** The 1st of a month as a day number. `month` is 0–11 and may overflow either way. */
export function startOfMonth(year: number, month: number): number {
  return Math.floor(Date.UTC(year, month, 1) / MS_PER_DAY);
}

/** `offset` months from the 1st that `day` falls in. */
export function addMonths(day: number, offset: number): number {
  const date = new Date(day * MS_PER_DAY);
  return startOfMonth(date.getUTCFullYear(), date.getUTCMonth() + offset);
}

export function startOfMonthDay(day: number): number {
  const date = new Date(day * MS_PER_DAY);
  return startOfMonth(date.getUTCFullYear(), date.getUTCMonth());
}
