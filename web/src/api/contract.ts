/**
 * contract.ts — what the page and the Worker agree a write looks like.
 *
 * Imported by both, so a request shape is one definition rather than two that
 * agree by care. That is not enough on its own: a Home Screen icon can run a
 * page cached days before the Worker it talks to was deployed, and the two
 * then disagree about a shape neither side can see. So every write carries
 * `CONTRACT` in a header, the Worker refuses any other number with a 409
 * before it reads anything, and the page answers a 409 by reloading itself —
 * which fetches the page that matches.
 *
 * Bump `CONTRACT` whenever a request or an answer below changes meaning. A
 * field added that an old page would simply not send is not a change; a field
 * whose absence an old page would mean differently is.
 */

import type { Cell } from '../sheets/records';

export const CONTRACT = 1;
export const CONTRACT_HEADER = 'x-spendsheet-contract';

/** One call confirms at most this many rows. */
export const MAX_DECISIONS = 100;

/** The destination that means "not an account in this book". */
export const TRANSFER_OUTSIDE = '__outside__';

/** A row the page is talking about: its uid, and the sheet row it last saw it at. */
export type RowRef = { uid: string; row: number };

export type Decision = RowRef & {
  category_override?: string;
  subcategory_override?: string;
  confirmed?: boolean;
  /** Replaces the row's labels; `[]` is "I removed the last one". */
  labels?: string[];
  description?: string;
  /** How much, never which way — the Worker keeps the stored sign. */
  amount?: number;
};

export type TransferRequest = RowRef & {
  /** An account name, or `TRANSFER_OUTSIDE`. */
  destination: string;
  subcategory?: string;
  amount?: number;
  description?: string;
  /** For a bank destination: the row on that account the page matched, if it found one. */
  counter?: RowRef;
};

export type RuleRequest = {
  field: string;
  match_type: string;
  pattern: string;
  category: string;
  subcategory?: string;
};

export type CashRequest = {
  /** Made on the phone, once per entry: a retry of the same entry is the same row. */
  id: string;
  account: string;
  amount: number;
  direction?: 'income' | 'expense';
  category?: string;
  subcategory?: string;
  note?: string;
  labels?: string[];
  /** `yyyy-mm-dd`, or blank for today. */
  date?: string;
};

export type DeleteRequest = RowRef;

/** A `transactions` row as Google now holds it, read back after the write: sheet row → A…AD. */
export type FreshRows = { [row: string]: Cell[] };

export type DecisionResult =
  | { uid: string; ok: true; wrote: string[]; refused: string[] }
  | { uid: string; ok: false; reason: string };

export type DecideAnswer = {
  written: number;
  skipped: number;
  capped: boolean;
  results: DecisionResult[];
  rows: FreshRows;
};

/** Every other write answers a sentence to show, and the rows it touched. */
export type ActAnswer = {
  message: string;
  rows: FreshRows;
  /** A delete: the sheet row that is gone, so the page can close the gap in its copy. */
  removed?: number;
};

/** A refusal that is about the request rather than the caller — shown as it is. */
export type Problem = { error: 'problem'; message: string };
