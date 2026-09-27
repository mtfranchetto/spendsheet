/**
 * cells.ts — what a cell means, before anything adds it up.
 *
 * The same rules as `03_sheets.gs`, for the same reasons: an empty cell is not
 * zero — `Number('')` is 0 and passes every finiteness check — and a `yes`
 * typed into a checkbox column is a yes.
 */

import type { Cell } from '../sheets/records';

/** Nothing in it — which `Number('')` would otherwise read as a deliberate 0. */
export function isBlankCell(value: Cell | undefined): boolean {
  if (value === '' || value === null || value === undefined) return true;
  return typeof value === 'string' && !value.trim();
}

/** A real boolean, or the words a person types into a checkbox column. */
export function isTruthyCell(value: Cell | undefined): boolean {
  if (value === true) return true;
  if (value === false || value === '' || value === null || value === undefined) return false;
  return /^(yes|true|1|on|y|si|sì)$/i.test(String(value).trim());
}

/** A cell as a number, or null — never as zero. */
export function cellNumber(value: Cell | undefined): number | null {
  if (isBlankCell(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** `String(value || '')`, the `.gs`'s idiom for a field that must be text. */
export function text(value: Cell | undefined): string {
  return value === null || value === undefined || value === false || value === 0 || value === ''
    ? ''
    : String(value);
}

/** Rounded at the boundary, not during the sum. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
