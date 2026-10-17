/**
 * transfer.ts — which row on another bank is the other half of a move.
 *
 * Split in two so both sides can ask it. The page holds the whole ledger, so it is the page that *finds* the counter
 * leg; the Worker reads only the two rows it was named and asks
 * `counterLegProblem` of them again, because a page can send anything and the
 * ledger may have moved since it looked. One predicate, so the page can never
 * offer a pair the Worker would refuse.
 */

import type { Row } from './book';
import { isBlankCell, text } from './cells';
import { dayOf } from './days';
import { TX_TYPE } from './schema';

/** How far apart two bookings may be and still be one move, when `_config` does not say. */
export const DEFAULT_TRANSFER_WINDOW_DAYS = 4;

/** A `transactions` row; only uid, account_id, amount, booking_date and transfer_group are read. */
type Leg = Row;

/** Days between two booking dates, or null when either is not a date. */
export function dayDistance(a: Row['booking_date'], b: Row['booking_date'], timeZone: string): number | null {
  const from = dayOf(a, timeZone);
  const to = dayOf(b, timeZone);
  return from === null || to === null ? null : Math.abs(from - to);
}

/**
 * Why `candidate` cannot be the other half of `source` on `targetId`, or null
 * when it can: the same figure to the cent, the other way, on that account, in
 * no pair yet, and booked within the window.
 */
export function counterLegProblem(
  source: Leg,
  candidate: Leg,
  targetId: string,
  windowDays: number,
  timeZone: string
): string | null {
  if (text(candidate.uid) === text(source.uid)) return 'that is the same row';
  if (text(candidate.account_id) !== targetId) return 'that row is on another account';
  const amount = Number(candidate.amount);
  if (isBlankCell(candidate.amount) || !Number.isFinite(amount) || amount === 0) return 'that row has no amount';
  if (Math.abs(amount).toFixed(2) !== Math.abs(Number(source.amount)).toFixed(2)) return 'the amounts differ';
  if (amount < 0 === Number(source.amount) < 0) return 'both rows move money the same way';
  if (!isBlankCell(candidate.transfer_group)) return 'that row is already in a transfer';
  const window = windowDays >= 0 ? windowDays : DEFAULT_TRANSFER_WINDOW_DAYS;
  const distance = dayDistance(source.booking_date, candidate.booking_date, timeZone);
  if (distance === null || distance > window) return 'those rows are too far apart in time';
  return null;
}

/** The closest row that passes `counterLegProblem`, or null. */
export function findCounterLeg<R extends Leg>(
  ledger: readonly R[],
  source: Leg,
  targetId: string,
  windowDays: number,
  timeZone: string
): R | null {
  let best: R | null = null;
  let bestDistance: number | null = null;
  for (const row of ledger) {
    if (counterLegProblem(source, row, targetId, windowDays, timeZone)) continue;
    const distance = dayDistance(source.booking_date, row.booking_date, timeZone) as number;
    if (bestDistance === null || distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Is this money arriving? The sign, except at zero, where a €0.00
 * pre-authorisation is a debit and `type` is the stored answer; and `null` —
 * no figure — claims nothing arrived. The row list, the transfer pane and the
 * Worker's answer all ask it, so the question and the toast cannot disagree.
 */
export function arrives(amount: number | null, type: unknown): boolean {
  if (amount === null || Number.isNaN(amount)) return false;
  return amount === 0 ? String(type) === TX_TYPE.INCOME : amount > 0;
}

/**
 * Did the money arrive on this row's account, from the other one? The pairing
 * once there is one. Before there is, `arrives` on the row's own figure —
 * `rawAmount` when no rate has priced it, because a missing rate is not a
 * direction, though the row list draws it as `—`.
 */
export function movedIn(record: {
  amount: number | null;
  rawAmount: number | null;
  type: string;
  peerDirection: string;
}): boolean {
  if (record.peerDirection) return record.peerDirection === 'from';
  return arrives(record.amount ?? record.rawAmount, record.type);
}
