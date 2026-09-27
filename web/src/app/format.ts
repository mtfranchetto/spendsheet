/**
 * format.ts — numbers and dates as the screens print them.
 *
 * Carried over from `page.core.html` unchanged in behaviour, and pure, so the
 * rules that were argued there are held by a test here rather than by a
 * browser: the grouping separator that must not come and go with magnitude,
 * the year that is almost never the question, and an age worded to be doubted.
 */

/**
 * Money, in the book's own currency.
 *
 * `useGrouping: true` is stated because the locale default is `"min2"` in it-IT
 * and friends: a thousands separator at five digits and none at four, which
 * put `14.500,00 €` beside `8920,40 €` in columns that are lined up digit by
 * digit. The fallback is for a currency code `Intl` does not know —
 * `base_currency` is a cell somebody can type into.
 */
export function money(value: number | null | undefined, currency: string, options: { whole?: boolean } = {}): string {
  if (value === null || value === undefined || (value as unknown) === '') return '—';
  const digits = options.whole ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      useGrouping: true,
      maximumFractionDigits: digits,
      minimumFractionDigits: digits
    }).format(value);
  } catch {
    return Number(value).toFixed(digits) + ' ' + currency;
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-08-06` as `6 Aug`, and `2026-08` as `Aug 2026`, because the year is almost never the question. */
export function shortDate(key: string | null | undefined): string {
  if (!key) return '';
  const parts = String(key).split('-');
  const month = MONTHS[Number(parts[1]) - 1] || parts[1];
  return parts.length > 2 ? Number(parts[2]) + ' ' + month : month + ' ' + parts[0];
}

/**
 * How long ago, in the least precise words that are still true.
 *
 * It sits beside numbers from a stored copy, and its job is to stop someone
 * reading them as today's — so it rounds outward and never offers a precision
 * it has not got.
 */
export function agoWords(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return 'a moment ago';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : hours + ' hours ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

/**
 * A day's heading on Records: `Today`, `6 August`, or `6 August 2024`.
 *
 * `today` is the book's day key, not the phone's, so the heading and the
 * numbers under it agree about which day it is.
 */
export function dayHeading(key: string, today: string): string {
  if (!key) return 'No date';
  if (key === today) return 'Today';
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return key;
  return day + ' ' + date.toLocaleDateString(undefined, { month: 'long' }) +
    (String(year) === today.slice(0, 4) ? '' : ' ' + year);
}

/** January…December, short, in the phone's locale. */
export function monthNames(): string[] {
  return Array.from({ length: 12 }, (_, month) => new Date(2000, month, 1).toLocaleDateString(undefined, { month: 'short' }));
}

/** `🛒 Groceries`, or `Groceries` with no leading space when the icon cell is empty. */
export function withIcon(icon: string, name: string): string {
  return icon ? icon + ' ' + name : String(name || '');
}
