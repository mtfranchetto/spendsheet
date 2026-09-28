/**
 * writes.ts — the five writes, from the page's side.
 *
 * Each one lays its guess over the book (`layer`), sends, and on the answer
 * patches the book with the rows Google read back (`wrote`) and lifts the
 * guess. A refusal lifts the guess alone, which puts the row back exactly as
 * it was — and says why, because a row snapping back looks otherwise like a
 * tap that never landed. Success says nothing for a confirmation, the action
 * done most often: the row has already redrawn, and a banner would add four
 * seconds of screen to every swipe.
 *
 * **One write at a time, and rows are named when it leaves.** Every write
 * goes through one lane, and is given its sheet rows only when its turn comes,
 * from the book as the writes before it left it. Two writes in the air at
 * once could land in either order, and a delete landing first moves every
 * row below it — so a decision sent alongside would name a row that now holds
 * something else. The Worker would refuse it as moved, which is safe; the
 * lane makes it not happen.
 *
 * **Swipes are batched.** `decide` takes a list; while one call is out, what
 * is swiped waits and goes as one — five swipes in five seconds are one write
 * and one answer rather than five, each queued behind the last.
 */

import { act } from '../api/client';
import {
  TRANSFER_OUTSIDE, type ActAnswer, type CashRequest, type DecideAnswer, type Decision, type RuleRequest
} from '../api/contract';
import { configNumber } from '../domain/book';
import type { PageRecord } from '../domain/query';
import { TX_TYPE } from '../domain/schema';
import { findCounterLeg } from '../domain/transfer';
import type { Cell } from '../sheets/records';
import {
  book, layer, overview, refresh, rowOf, toast, unlayer, writeFailed, writeSettled, writeStarted, wrote
} from './state';

export type DecisionFields = Omit<Decision, 'uid' | 'row'>;

function kindOf(category: string): string {
  return overview()?.lists.categories.parents.find((parent) => parent.name === category)?.kind ?? '';
}

/** What a decision will do to the row's columns, derived ones included — a guess until the answer lands. */
function guess(record: PageRecord, decision: DecisionFields): { [column: string]: Cell } {
  const fields: { [column: string]: Cell } = {};
  if (decision.confirmed) fields.confirmed = true;
  if (decision.category_override) {
    fields.category_override = decision.category_override;
    fields.category = decision.category_override;
    const kind = kindOf(decision.category_override);
    if (kind) {
      fields.type = kind;
      fields.in_reports = kind !== TX_TYPE.TRANSFER;
    }
    if (!decision.subcategory_override) fields.subcategory = '';
  }
  if (decision.subcategory_override) {
    fields.subcategory_override = decision.subcategory_override;
    fields.subcategory = decision.subcategory_override;
  }
  if (decision.labels !== undefined) fields.labels = decision.labels.join(', ');
  if (decision.description !== undefined) fields.description = decision.description;
  if (decision.amount !== undefined) {
    const signed = Number(record.rawAmount) < 0 ? -decision.amount : decision.amount;
    fields.amount = signed;
    fields.amount_base = signed;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Decisions, batched
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The lane
// ---------------------------------------------------------------------------

const waiting: (() => Promise<void>)[] = [];
let busy = false;

function enqueue(task: () => Promise<void>): void {
  waiting.push(task);
  void pump();
}

async function pump(): Promise<void> {
  if (busy) return;
  const task = waiting.shift();
  if (!task) return;
  busy = true;
  try {
    await task();
  } finally {
    busy = false;
    void pump();
  }
}

type Queued = { uid: string; decision: DecisionFields; layer: number };
let queued: Queued[] = [];
let flushWaiting = false;

export function sendDecision(record: PageRecord, decision: DecisionFields): void {
  queued.push({ uid: record.uid, decision, layer: layer(record.uid, guess(record, decision)) });
  // One flush in the lane at a time: whatever is swiped before it runs goes with it.
  if (flushWaiting) return;
  flushWaiting = true;
  enqueue(flushDecisions);
}

async function flushDecisions(): Promise<void> {
  flushWaiting = false;
  const batch = queued;
  queued = [];

  const sendable = batch.filter((entry) => rowOf(entry.uid));
  const lost = batch.filter((entry) => !rowOf(entry.uid));
  if (lost.length) {
    unlayer(lost.map((entry) => entry.layer));
    toast('Not saved: that row is no longer in the book.');
  }
  if (!sendable.length) return;

  const gen = writeStarted();
  const decisions = sendable.map((entry) => ({ ...entry.decision, uid: entry.uid, row: rowOf(entry.uid)!._row }));
  try {
    const answer = await act<DecideAnswer>('decide', { decisions });
    wrote(gen, answer.rows);
    const refused = answer.results.filter((result) => !result.ok) as { reason: string }[];
    if (refused.length) {
      toast((refused.length === 1 ? 'Not saved: ' : refused.length + ' not saved: ') + refused[0].reason);
      void refresh();
    } else if (decisions.some((decision) => decision.amount !== undefined)) {
      // A new amount moves a cash account's balance, which only a read brings back — see `addCash`.
      void refresh();
    }
  } catch (error) {
    writeFailed(error);
  } finally {
    unlayer(sendable.map((entry) => entry.layer));
    writeSettled();
  }
}

// ---------------------------------------------------------------------------
// The other four, one at a time
// ---------------------------------------------------------------------------

/**
 * One write that is not a decision: `guesses` laid at once, the call made in
 * its turn with the body `build` gives then (null: nothing left to send), and
 * the answer patched in. Resolves to the answer, or null when it failed — the
 * failure has already been said.
 */
function one<T extends ActAnswer>(
  name: 'transfer' | 'rule' | 'cash' | 'delete',
  build: () => unknown | null,
  guesses: [string, { [column: string]: Cell } | null][] = []
): Promise<T | null> {
  const ids = guesses.map(([uid, fields]) => layer(uid, fields));
  return new Promise((resolve) => {
    enqueue(async () => {
      const body = build();
      if (body === null) {
        unlayer(ids);
        toast('Not saved: that row is no longer in the book.');
        resolve(null);
        return;
      }
      const gen = writeStarted();
      try {
        const answer = await act<T>(name, body);
        wrote(gen, answer.rows, answer.removed);
        resolve(answer);
      } catch (error) {
        writeFailed(error);
        void refresh();
        resolve(null);
      } finally {
        unlayer(ids);
        writeSettled();
      }
    });
  });
}

export type TransferFields = { destination: string; subcategory: string; amount?: number; description?: string };

/**
 * Mark a transfer. For a bank destination the page finds the other half —
 * it holds the ledger — and the Worker checks that row again with the same
 * predicate before pairing.
 */
export async function markTransfer(record: PageRecord, fields: TransferFields): Promise<void> {
  const answer = await one<ActAnswer>(
    'transfer',
    () => {
      const source = rowOf(record.uid);
      const b = book();
      if (!source || !b) return null;
      let counter: { uid: string; row: number } | undefined;
      if (fields.destination !== TRANSFER_OUTSIDE) {
        const target = b.accounts.find((account) => String(account.name) === fields.destination);
        if (target && String(target.kind) === 'bank') {
          const window = configNumber(b.config, 'transfer_window_days');
          // Against the amount as it will be: an edited cash row pairs at its new figure, as the Worker checks it.
          const amount = fields.amount === undefined ? source.amount : Number(source.amount) < 0 ? -fields.amount : fields.amount;
          const found = findCounterLeg(b.transactions, { ...source, amount }, String(target.account_id), window, b.timeZone);
          if (found) counter = { uid: String(found.uid), row: found._row };
        }
      }
      return { uid: record.uid, row: source._row, ...fields, counter };
    },
    [[record.uid, { category: 'Transfer', subcategory: fields.subcategory, type: TX_TYPE.TRANSFER, in_reports: false, confirmed: true }]]
  );
  if (!answer) return;
  toast(answer.message);
  // A new amount moves a cash account's balance, which only a read brings back — see `addCash`.
  if (fields.amount !== undefined) void refresh();
}

export async function addRule(rule: RuleRequest): Promise<boolean> {
  const answer = await one<ActAnswer>('rule', () => rule);
  if (answer) toast(answer.message);
  return !!answer;
}

/** A random id for an entry, made once per form: a retry of the same entry sends the same one. */
export function entryId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A cash entry, or an asset's new value — which is a cash entry for the
 * difference.
 *
 * **The book is read again once it lands**, because what the entry changes
 * most visibly is not in the answer. The Worker reads back the transaction
 * rows it wrote; a cash or asset account's balance is the `accounts` tab's own
 * formula over those rows, which Google recomputes and nothing here can patch.
 * Without the read, the tile you added from goes on showing the old balance.
 */
export async function addCash(entry: CashRequest): Promise<boolean> {
  const answer = await one<ActAnswer>('cash', () => entry);
  if (!answer) return false;
  toast(answer.message === '1 added' ? 'Added.' : answer.message);
  void refresh();
  return true;
}

/**
 * Delete a cash row, or an asset's valuation change. Read again once it
 * lands, for the reason `addCash` is: the balance it moves is the `accounts`
 * tab's formula, which the answer does not carry. It stays where it is — a
 * delete is made from the list it was in.
 */
export async function deleteRecord(record: PageRecord): Promise<void> {
  const answer = await one<ActAnswer>(
    'delete',
    () => {
      const row = rowOf(record.uid);
      return row ? { uid: record.uid, row: row._row } : null;
    },
    [[record.uid, null]]
  );
  if (!answer) return;
  toast(answer.message);
  void refresh();
}
