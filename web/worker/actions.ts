/**
 * actions.ts — the five things the page may write, each checked against the
 * row as Google holds it, and nothing else.
 *
 * ## Named actions, never a pass-through
 *
 * The read route hands Google's body back unread; a write route cannot. A raw
 * `values.update` carrying the owner's token cannot tell a confirmation from
 * an overwrite of history, so every write here is one of five named actions,
 * each asking what the `.gs` writers ask — whether a description is the
 * bank's, whether an amount has a partner holding the same figure, whether a
 * row is cash you typed — against **the row as Google holds it now**, not as
 * the page says it is. The page decides what to offer; this decides what is
 * true.
 *
 * ## Rows are named by the page and checked here
 *
 * The page holds the whole ledger, so it knows which sheet row each uid sits
 * at; the Worker reads only those rows and refuses any whose uid is no longer
 * there. That keeps a write to a few cells' worth of reading under the 10ms
 * CPU cap — the `.gs` built a uid index of the whole tab for every call, which
 * here would be the one thing that did not fit. A row moves only when a row
 * above it is deleted, and a refusal that says "refresh" is the honest answer
 * to that.
 *
 * Appending is the exception: a new row needs the next free row, and a new
 * uid needs to be known absent, so the two appending actions (cash, and a
 * transfer leg) read column A whole. ~70 bytes a row; about a millisecond of
 * parsing at five thousand.
 *
 * ## How values are written
 *
 * `values.batchUpdate` with `RAW`, at explicit addresses. **`RAW` is what
 * makes `textSafe_` unnecessary here**: Sheets stores a RAW string as the
 * string, so a description starting with `=` is text and never a formula.
 * Values go as typed JSON — an amount as a number, `confirmed` as `true`, a
 * date as its serial number (the date columns carry a `yyyy-mm-dd` format from
 * row 2 down, so a serial reads back as the date the `.gs` would have written).
 *
 * **Never `values.append` on `transactions`.** It finds "the table" the way
 * `getLastRow()` does, and the `ARRAYFORMULA`s from P onward make that the
 * sheet's last row rather than the last record — the bug that once put an
 * account at row 1001. The next row is the one after the last uid in column A,
 * and a new row is *inserted* there and written in the same request, typed as
 * `updateCells` values — see `insertRow` for why an address alone is not
 * enough.
 *
 * ## After writing, the rows are read back
 *
 * Every action answers with the rows it touched, A–AD, as Google now holds
 * them — formulas recalculated — so the page patches its copy of the book
 * instead of reading the whole of it again.
 */

import type {
  ActAnswer, CashRequest, DecideAnswer, Decision, DecisionResult, DeleteRequest, FreshRows,
  RowRef, RuleRequest, TransferRequest
} from '../src/api/contract';
import { MAX_DECISIONS, TRANSFER_OUTSIDE } from '../src/api/contract';
import { configNumber, type Row } from '../src/domain/book';
import { isBlankCell, isTruthyCell, text } from '../src/domain/cells';
import { clockAt, serialOf, SERIAL_EPOCH } from '../src/domain/days';
import { amountIsEditable, descriptionIsEditable, recordIsDeletable, splitLabels } from '../src/domain/query';
import {
  ACCOUNT_COLUMNS, ACCOUNT_KIND, CATEGORY_COLUMNS, CONFIG_COLUMNS, DEFAULT_CONFIG, TABS,
  TX_COLUMNS, TX_COLUMNS_CODE, TX_SOURCE_CASH, TX_TYPE
} from '../src/domain/schema';
import { arrives, counterLegProblem } from '../src/domain/transfer';
import { ANY_COLUMN, records, type Cell } from '../src/sheets/records';

/** A refusal about the request — shown to the person as it is, with a 422. */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Refusal';
  }
}

/** The four things an action may ask of Google. `router.ts` builds the real one. */
export type Google = {
  /** `values.batchGet`, unformatted, serial dates: one array per range, in order. */
  read(ranges: string[]): Promise<Cell[][][]>;
  /** `values.batchUpdate` with `RAW`. */
  write(data: { range: string; values: Cell[][] }[]): Promise<void>;
  /** `spreadsheets.batchUpdate`: applied in order, and all or nothing. */
  update(requests: object[]): Promise<void>;
  /** The book's zone, and each tab's id and row count. */
  sheets(): Promise<Sheets>;
};

export type Sheets = { timeZone: string; tabs: { [title: string]: { sheetId: number; rows: number } } };

export const TX_SOURCE_TRANSFER_LEG = 'transfer-leg';
export const TRANSFER_CATEGORY_NAME = 'Transfer';
const UID_SEPARATOR = '|';

export const RULE_COLUMNS = [
  'priority', 'field', 'match_type', 'pattern',
  'account_filter', 'category', 'subcategory', 'type', 'enabled'
] as const;
export const RULE_FIELDS = ['description', 'counterparty', 'mcc', 'bank_transaction_code'];
export const RULE_MATCH_TYPES = ['contains', 'equals', 'starts_with', 'regex'];

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const TX_WIDTH = TX_COLUMNS.length;

/**
 * The columns a new row may be written in: A–O, and the few past O that hold
 * a value rather than a formula's spill. `transactions` is shaped so, with
 * `amount_base`, `category`, `type`, `in_reports` and the rest filled by
 * `ARRAYFORMULA`s anchored in row 2.
 */
const STORED_COLUMNS: ReadonlySet<string> = new Set([
  ...TX_COLUMNS_CODE,
  'category_override', 'transfer_group', 'notes', 'excluded', 'labels', 'confirmed', 'subcategory_override'
]);

export function columnLetter(index: number): string {
  let n = index;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const quoted = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const LAST_TX_COLUMN = columnLetter(TX_WIDTH);
const txRow = (row: number) => `${quoted(TABS.TRANSACTIONS)}!A${row}:${LAST_TX_COLUMN}${row}`;
const txCell = (name: string, row: number) =>
  `${quoted(TABS.TRANSACTIONS)}!${columnLetter(TX_COLUMNS.indexOf(name as never) + 1)}${row}`;

const RANGES = {
  accounts: `${quoted(TABS.ACCOUNTS)}!A1:${columnLetter(ACCOUNT_COLUMNS.length)}`,
  categories: `${quoted(TABS.CATEGORIES)}!A1:D`,
  config: `${quoted(TABS.CONFIG)}!A1:B`,
  uids: `${quoted(TABS.TRANSACTIONS)}!A1:A`,
  removedUids: `${quoted(TABS.REMOVED)}!A1:A`,
  rules: `${quoted('rules')}!A1:${columnLetter(RULE_COLUMNS.length)}`
};

// ---------------------------------------------------------------------------
// Reading what was read
// ---------------------------------------------------------------------------

function pad(values: readonly Cell[] | undefined, width: number): Cell[] {
  const out: Cell[] = [];
  for (let c = 0; c < width; c++) out.push(values?.[c] ?? '');
  return out;
}

/** One `transactions` row as a record, with its sheet row. */
function txRecord(values: Cell[][] | undefined, row: number): Row {
  const cells = pad(values?.[0], TX_WIDTH);
  const record = { _row: row } as Row;
  TX_COLUMNS.forEach((name, c) => {
    record[name] = cells[c];
  });
  return record;
}

/** Past the header: the rest of a tab read from row 1. */
const body = (values: Cell[][] | undefined) => (values ?? []).slice(1);

/** The sheet row after the last non-blank cell of a column read from row 1; 2 on an empty tab. */
export function nextRow(column: Cell[][] | undefined): number {
  const rows = column ?? [];
  for (let i = rows.length - 1; i >= 1; i--) {
    if (!isBlankCell(rows[i]?.[0])) return i + 2;
  }
  return 2;
}

function hasUid(column: Cell[][] | undefined, uid: string): boolean {
  return (column ?? []).some((cells, i) => i > 0 && String(cells?.[0] ?? '') === uid);
}

function configOf(values: Cell[][] | undefined): { [key: string]: Cell } {
  const config: { [key: string]: Cell } = { ...DEFAULT_CONFIG };
  for (const row of records(body(values), CONFIG_COLUMNS)) {
    if (!isBlankCell(row.key)) config[String(row.key)] = row.value;
  }
  return config;
}

type Categories = {
  /** Parent → kind, from the first row that names one — `categoryKinds_`. */
  kinds: { [parent: string]: string };
  parents: string[];
  children: { name: string; parent: string; kind: string }[];
};

function categoriesOf(values: Cell[][] | undefined): Categories {
  const kinds: { [parent: string]: string } = {};
  const parents: string[] = [];
  const children: Categories['children'] = [];
  for (const row of records(body(values), CATEGORY_COLUMNS.slice(0, 4))) {
    const parent = text(row.category);
    if (!parent) continue;
    if (!kinds[parent] && row.kind) kinds[parent] = text(row.kind);
    if (!row.subcategory) continue;
    if (parents.indexOf(parent) === -1) parents.push(parent);
    children.push({ name: text(row.subcategory), parent, kind: text(row.kind) });
  }
  return { kinds, parents, children };
}

function activeAccount(values: Cell[][] | undefined, name: string): Row | null {
  return records(body(values), ACCOUNT_COLUMNS).find(
    (account) => !isBlankCell(account.account_id) && isTruthyCell(account.active) && text(account.name) === name
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Rules shared with 10_cash.gs and the review tab
// ---------------------------------------------------------------------------

/** `editedAmount_`: how much, never which way — the stored sign is kept. */
export function editedAmount(typed: unknown, stored: Cell): { amount: number } | { problem: string } {
  if (isBlankCell(typed as Cell)) return { problem: 'an amount cannot be blank' };
  const size = Number(typed);
  if (!Number.isFinite(size)) return { problem: 'that amount is not a number' };
  if (size === 0) return { problem: 'a zero-euro transaction is not a transaction' };
  if (size < 0) return { problem: 'type the amount without a sign — editing it changes how much, not which way' };
  const was = isBlankCell(stored) ? NaN : Number(stored);
  if (!Number.isFinite(was) || was === 0) return { problem: 'this row has no amount to keep the direction of' };
  return { amount: was < 0 ? -size : size };
}

/** `normalizeLabels_`: trimmed, deduplicated, `a, b`. */
export function normalizeLabels(value: unknown): string {
  const parts = Array.isArray(value) ? value : splitLabels(value as Cell);
  const kept: string[] = [];
  for (const part of parts) {
    const label = String(part ?? '').trim();
    if (label && kept.indexOf(label) === -1) kept.push(label);
  }
  return kept.join(', ');
}

/** `cashEntryAmount`: a typed minus wins; otherwise the category's kind decides. */
export function cashEntryAmount(typed: number, kind: string | undefined): number {
  if (typed < 0) return typed;
  return kind === TX_TYPE.INCOME || kind === TX_TYPE.TRANSFER ? typed : -typed;
}

/** `directedCashAmount_`. */
function directedCashAmount(request: CashRequest): number {
  const amount = Number(request.amount);
  if (request.direction === TX_TYPE.INCOME) return Math.abs(amount);
  if (request.direction === TX_TYPE.EXPENSE) return -Math.abs(amount);
  return amount;
}

/** `transferSubcategoryFor_`. */
function transferSubcategoryFor(target: Row | null, sourceAmount: number, chosen: unknown, categories: Categories): string {
  const wanted = String(chosen ?? '').trim();
  const offered = categories.children
    .filter((child) => categories.kinds[child.parent] === TX_TYPE.TRANSFER)
    .map((child) => child.name);
  if (wanted && offered.indexOf(wanted) !== -1) return wanted;
  if (target && text(target.kind) === ACCOUNT_KIND.CASH && sourceAmount < 0) return 'Cash withdrawal';
  return 'Between accounts';
}

/** Lowercase hex SHA-256 of UTF-8 — `sha256Hex` in `08_dedup.gs`. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `transferLegUid_`: the same source and destination always make the same leg. */
export function transferLegUid(sourceUid: string, destinationId: string): Promise<string> {
  return sha256Hex([TX_SOURCE_TRANSFER_LEG, sourceUid, destinationId].join(UID_SEPARATOR));
}

/**
 * A cash row's uid. The `.gs` numbers entries from a counter in script
 * properties, which nothing here can reach; the phone's id takes its place,
 * and is what makes a retried entry land once.
 */
export function cashUid(accountId: string, day: string, amount: number, description: string, id: string): Promise<string> {
  const normalized = description.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
  return sha256Hex(['cash', accountId, day, amount.toFixed(2), normalized, 'web', id].join(UID_SEPARATOR));
}

/** The instant `now` on the book's wall clock, as a serial. */
function serialAt(now: Date, timeZone: string): number {
  return serialOf(now.toISOString(), timeZone) as number;
}

// ---------------------------------------------------------------------------
// Shapes a page may send
// ---------------------------------------------------------------------------

function isRowRef(value: unknown): value is RowRef {
  const ref = value as RowRef;
  return !!ref && typeof ref.uid === 'string' && ref.uid !== '' && Number.isInteger(ref.row) && ref.row >= 2;
}

/** The rows' current values, read back after a write. */
async function fresh(google: Google, rows: number[]): Promise<FreshRows> {
  const unique = [...new Set(rows)];
  if (!unique.length) return {};
  const read = await google.read(unique.map(txRow));
  const out: FreshRows = {};
  unique.forEach((row, i) => {
    out[String(row)] = pad(read[i]?.[0], TX_WIDTH);
  });
  return out;
}

/** Room for `row` on a tab, because a write past the grid is refused rather than grown. */
async function ensureRows(google: Google, sheets: Sheets, tab: string, row: number): Promise<void> {
  const grid = sheets.tabs[tab];
  if (!grid) throw new Refusal(`This book has no "${tab}" tab. Run Spendsheet → Setup sheet first.`);
  if (row <= grid.rows) return;
  await google.update([{ appendDimension: { sheetId: grid.sheetId, dimension: 'ROWS', length: row - grid.rows } }]);
}

/** One cell as `updateCells` takes it: a string is a string value, never parsed — `RAW`, by construction. */
function cellData(value: Cell): object {
  if (typeof value === 'number') return { userEnteredValue: { numberValue: value } };
  if (typeof value === 'boolean') return { userEnteredValue: { boolValue: value } };
  if (value === '' || value === null) return {};
  return { userEnteredValue: { stringValue: String(value) } };
}

/**
 * A new `transactions` row at `at`, **inserted and written in one
 * `spreadsheets.batchUpdate`** — never written into a row that happens to be
 * blank.
 *
 * The Apps Script writers (the sync's `appendRows_`, the cash drain) take the
 * script lock against each other; the Worker cannot reach it. Writing into the
 * next row by address would leave a network round trip between reading column
 * A and writing, in which a sync could write the same row and one of the two
 * transactions would be lost without a trace. Inserting a row at `at` instead
 * pushes anything that landed there in the meantime down, not over — and one
 * request is applied all or nothing, so nothing can land between the insert
 * and the write. What remains is Apps Script's own window between reading its
 * last row and writing after it: milliseconds inside one execution, against
 * the Worker's hundreds.
 *
 * **Only the stored cells it was given are written**, one `updateCells` per
 * run of adjacent columns. The rest of the row belongs to the `ARRAYFORMULA`s
 * anchored in row 2, and a cell written there — even written blank, which is a
 * clear — is a cell the spill no longer owns. And **row 2 is never inserted
 * above**: on a tab with no records the next row *is* row 2, where every
 * anchor lives, and an insert there would push them all down to row 3. That
 * one row is written in place instead; it is also the one row no other writer
 * can be racing for, since a sync appending to an empty tab is appending to a
 * book nobody has used.
 */
async function insertRow(google: Google, sheets: Sheets, at: number, fields: { [name: string]: Cell }): Promise<void> {
  const tab = sheets.tabs[TABS.TRANSACTIONS];
  if (!tab) throw new Refusal(`This book has no "${TABS.TRANSACTIONS}" tab. Run Spendsheet → Setup sheet first.`);
  const spilled = Object.keys(fields).filter((name) => !STORED_COLUMNS.has(name));
  if (spilled.length) throw new Error(`insertRow: ${spilled.join(', ')} ${spilled.length > 1 ? 'are' : 'is'} a formula's to fill`);

  const requests: object[] = [];
  // Row `at` must already be inside the grid, to insert at it or to write it.
  if (at > tab.rows) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: at - tab.rows } });
  if (at > 2) {
    requests.push({ insertDimension: { range: { sheetId: tab.sheetId, dimension: 'ROWS', startIndex: at - 1, endIndex: at }, inheritFromBefore: true } });
  }
  for (const run of adjacentRuns(TX_COLUMNS.map((name, i) => (name in fields ? i : -1)).filter((i) => i >= 0))) {
    requests.push({
      updateCells: {
        start: { sheetId: tab.sheetId, rowIndex: at - 1, columnIndex: run[0] },
        rows: [{ values: run.map((i) => cellData(fields[TX_COLUMNS[i]])) }],
        fields: 'userEnteredValue'
      }
    });
  }
  await google.update(requests);
}

/** `[0,1,2,19,26,27]` → `[[0,1,2],[19],[26,27]]`. */
function adjacentRuns(indices: number[]): number[][] {
  const runs: number[][] = [];
  for (const i of indices) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1] === i - 1) last.push(i);
    else runs.push([i]);
  }
  return runs;
}

const moved = 'That row has moved since this page read the book. Pull to refresh and try again.';

// ---------------------------------------------------------------------------
// 1. Confirm, recategorise, label, rename, resize — `applyReviewDecisions_`
// ---------------------------------------------------------------------------

/**
 * Up to `MAX_DECISIONS`, each written or skipped on its own.
 *
 * Every refusal is decided **before** anything of that row is written: a
 * decision whose amount or description is refused writes none of its other
 * cells either, so a skipped row is a row left exactly as it was.
 */
export async function decide(google: Google, request: { decisions?: unknown }): Promise<DecideAnswer> {
  const list = Array.isArray(request?.decisions) ? request.decisions : [];
  const asked = list.slice(0, MAX_DECISIONS) as Decision[];
  const answer: DecideAnswer = { written: 0, skipped: 0, capped: list.length > MAX_DECISIONS, results: [], rows: {} };
  if (!asked.length) return answer;
  if (!asked.every(isRowRef)) throw new Refusal('Every decision needs a uid and a row.');

  const rows = [...new Set(asked.map((decision) => decision.row))];
  const read = await google.read([...rows.map(txRow), RANGES.categories]);
  const byRow = new Map(rows.map((row, i) => [row, txRecord(read[i], row)]));
  const categories = categoriesOf(read[rows.length]);

  const writes: { range: string; values: Cell[][] }[] = [];
  const touched: number[] = [];
  const skip = (uid: string, reason: string) => {
    answer.skipped++;
    answer.results.push({ uid, ok: false, reason });
  };

  for (const decision of asked) {
    const row = byRow.get(decision.row) as Row;
    if (text(row.uid) !== decision.uid) {
      skip(decision.uid, moved);
      continue;
    }
    const cells: [string, Cell][] = [];
    const refused: string[] = [];

    if (decision.amount !== undefined && decision.amount !== null) {
      if (!amountIsEditable(row.source, row.transfer_group)) {
        skip(decision.uid, 'only cash you typed, and not paired in a transfer, can have its amount changed');
        continue;
      }
      const edit = editedAmount(decision.amount, row.amount);
      if ('problem' in edit) {
        skip(decision.uid, edit.problem);
        continue;
      }
      cells.push(['amount', edit.amount]);
    }

    let renamed: string | null = null;
    if (decision.description !== undefined && decision.description !== null) {
      renamed = String(decision.description).trim();
      if (!descriptionIsEditable(row.source)) {
        skip(decision.uid, 'that description came from your bank and is what identifies the row');
        continue;
      }
      if (!renamed) {
        skip(decision.uid, 'a description cannot be empty');
        continue;
      }
    }

    if (!isBlankCell(decision.category_override as Cell)) cells.push(['category_override', String(decision.category_override)]);
    if (!isBlankCell(decision.subcategory_override as Cell)) cells.push(['subcategory_override', String(decision.subcategory_override)]);
    if (decision.confirmed !== undefined && decision.confirmed !== null) {
      cells.push(['confirmed', isTruthyCell(decision.confirmed as Cell)]);
    }
    if (decision.labels !== undefined && decision.labels !== null) {
      // A label is an axis over spending, and a transfer is in no total a label could filter.
      const becomes = !isBlankCell(decision.category_override as Cell)
        ? categories.kinds[String(decision.category_override)]
        : text(row.type);
      if (becomes === TX_TYPE.TRANSFER) refused.push('labels');
      else cells.push(['labels', normalizeLabels(decision.labels)]);
    }
    if (renamed !== null) cells.push(['description', renamed]);

    if (!cells.length) {
      skip(decision.uid, refused.length ? 'a transfer takes no labels' : 'nothing to write');
      continue;
    }
    for (const [name, value] of cells) writes.push({ range: txCell(name, decision.row), values: [[value]] });
    touched.push(decision.row);
    answer.written++;
    answer.results.push({ uid: decision.uid, ok: true, wrote: cells.map(([name]) => name), refused } as DecisionResult);
  }

  if (writes.length) {
    await google.write(writes);
    answer.rows = await fresh(google, touched);
  }
  return answer;
}

// ---------------------------------------------------------------------------
// 2. Mark a transfer — `webAppLinkTransfer_`
// ---------------------------------------------------------------------------

/**
 * Three destinations, three answers. **Outside** marks the row and stops.
 * **A bank** is paired, never written: its own sync reports the other half, and
 * a leg written here would be a second copy of money that moved once. The page
 * names the counter row it matched, or none, and a missing one leaves the row
 * marked for `detectTransfers_` to pair tonight under the same group id.
 * **Cash or an asset** gets its half written, because nothing else will ever
 * report it — at a uid derived from the source and destination, so a second
 * tap finds the first leg rather than writing another.
 */
export async function transfer(google: Google, request: TransferRequest, now: Date): Promise<ActAnswer> {
  if (!isRowRef(request)) throw new Refusal('No transaction to mark.');
  const destination = String(request.destination ?? '');
  if (!destination) throw new Refusal('Say which account is the other side.');
  if (request.counter !== undefined && !isRowRef(request.counter)) throw new Refusal('That matching row is not one this can read.');

  const counterRow = request.counter?.row;
  const [read, sheets] = await Promise.all([
    google.read([
      txRow(request.row), RANGES.accounts, RANGES.categories, RANGES.config, RANGES.uids,
      ...(counterRow ? [txRow(counterRow)] : [])
    ]),
    google.sheets()
  ]);
  const [sourceValues, accounts, categoryValues, configValues, uids] = read;
  const source = txRecord(sourceValues, request.row);
  if (text(source.uid) !== request.uid) throw new Refusal(moved);
  const categories = categoriesOf(categoryValues);

  const outside = destination === TRANSFER_OUTSIDE;
  const target = outside ? null : activeAccount(accounts, destination);
  if (!outside && !target) throw new Refusal(`"${destination}" is not an active account on this book.`);
  if (target && text(target.account_id) === text(source.account_id)) {
    throw new Refusal('That is the same account the transaction is already on.');
  }

  const writes: { range: string; values: Cell[][] }[] = [];
  const touched = [request.row];
  const put = (name: string, row: number, value: Cell) => writes.push({ range: txCell(name, row), values: [[value]] });

  let amount = Number(source.amount);
  if (request.amount !== undefined && request.amount !== null) {
    if (!amountIsEditable(source.source, source.transfer_group)) {
      throw new Refusal('Only cash you typed, and not already paired in a transfer, can have its amount changed.');
    }
    const edit = editedAmount(request.amount, source.amount);
    if ('problem' in edit) throw new Refusal(edit.problem.charAt(0).toUpperCase() + edit.problem.slice(1) + '.');
    amount = edit.amount;
    put('amount', request.row, amount);
  }
  if (request.description !== undefined && request.description !== null) {
    const renamed = String(request.description).trim();
    if (!renamed) throw new Refusal('A description cannot be empty.');
    if (!descriptionIsEditable(source.source)) {
      throw new Refusal('That description came from your bank and is what identifies the row.');
    }
    put('description', request.row, renamed);
  }
  put('category_override', request.row, TRANSFER_CATEGORY_NAME);
  put('subcategory_override', request.row, transferSubcategoryFor(target, amount, request.subcategory, categories));
  put('confirmed', request.row, true);

  const finish = async (message: string, extra: Partial<ActAnswer> = {}): Promise<ActAnswer> => {
    await google.write(writes);
    return { message, rows: await fresh(google, touched), ...extra };
  };

  // The page asked its question with `arrives`; the answer says the same way round.
  const arriving = arrives(amount, source.type);
  if (!target) return finish(`Marked as a transfer ${arriving ? 'in from outside' : 'out of'} your tracked accounts.`);
  const targetName = text(target.name);

  if (text(target.kind) === ACCOUNT_KIND.BANK) {
    if (!request.counter) {
      return finish(`Marked as a transfer ${arriving ? 'from' : 'to'} ${targetName}. Nothing on that account matches it yet — ` +
        'the pair is made automatically once it syncs.');
    }
    const counter = txRecord(read[5], request.counter.row);
    if (text(counter.uid) !== request.counter.uid) throw new Refusal(moved);
    const window = configNumber(configOf(configValues), 'transfer_window_days');
    const problem = counterLegProblem({ ...source, amount } as Row, counter, text(target.account_id), window, sheets.timeZone);
    if (problem) throw new Refusal(`That row cannot be the other half: ${problem}. Pull to refresh and try again.`);

    const pairId = 'tr:' + (amount < 0 ? request.uid : request.counter.uid);
    put('transfer_group', request.row, pairId);
    put('transfer_group', counter._row, pairId);
    put('category_override', counter._row, TRANSFER_CATEGORY_NAME);
    put('subcategory_override', counter._row, 'Between accounts');
    put('confirmed', counter._row, true);
    touched.push(counter._row);
    return finish(`Paired with the matching row on ${targetName}. Neither counts as spending now.`);
  }

  const legUid = await transferLegUid(request.uid, text(target.account_id));
  if (hasUid(uids, legUid)) return finish(`That transfer was already recorded on ${targetName}.`);

  const at = nextRow(uids);
  const legAmount = -amount;
  const leg: { [name: string]: Cell } = {
    uid: legUid,
    account_id: text(target.account_id),
    account_name: targetName,
    booking_date: source.booking_date,
    value_date: isBlankCell(source.value_date) ? source.booking_date : source.value_date,
    transaction_date: isBlankCell(source.transaction_date) ? source.booking_date : source.transaction_date,
    amount: legAmount,
    currency: source.currency,
    description: (legAmount > 0 ? 'Transfer from ' : 'Transfer to ') + text(source.account_name),
    counterparty: text(source.account_name),
    entry_reference: '',
    bank_transaction_code: '',
    mcc: '',
    source: TX_SOURCE_TRANSFER_LEG,
    imported_at: serialAt(now, sheets.timeZone)
  };
  const group = 'tr:' + (amount < 0 ? request.uid : legUid);
  leg.category_override = TRANSFER_CATEGORY_NAME;
  leg.subcategory_override = transferSubcategoryFor(target, amount, undefined, categories);
  leg.confirmed = true;
  leg.transfer_group = group;
  // The source is above `at` by construction, so the insert does not move it.
  await insertRow(google, sheets, at, leg);
  put('transfer_group', request.row, group);
  touched.push(at);
  return finish(
    (legAmount > 0 ? 'Added ' : 'Took ') + Math.abs(legAmount).toFixed(2) + (legAmount > 0 ? ' to ' : ' from ') + targetName + '.'
  );
}

// ---------------------------------------------------------------------------
// 3. A rule — `webAppAddRule_`
// ---------------------------------------------------------------------------

/** `ruleProblem_`. */
export function ruleProblem(request: RuleRequest, categories: Categories): string | null {
  if (isBlankCell(request.pattern as Cell)) return 'Type something for the rule to match.';
  if (String(request.pattern).trim().length < 2) return 'That pattern is too short to be a rule.';
  if (RULE_FIELDS.indexOf(String(request.field)) === -1) return 'A rule can only match on ' + RULE_FIELDS.join(', ') + '.';
  if (RULE_MATCH_TYPES.indexOf(String(request.match_type)) === -1) {
    return 'A rule can only match by ' + RULE_MATCH_TYPES.join(', ') + '.';
  }
  if (isBlankCell(request.category as Cell)) return 'Pick a category for the rule to set.';
  if (categories.parents.indexOf(String(request.category)) === -1) return `There is no category called "${request.category}".`;
  if (!isBlankCell(request.subcategory as Cell)) {
    const fits = categories.children.some((child) => child.name === String(request.subcategory) && child.parent === String(request.category));
    if (!fits) return `"${request.subcategory}" is not under ${request.category}.`;
  }
  if (String(request.match_type) === 'regex') {
    try {
      new RegExp(String(request.pattern));
    } catch (error) {
      return 'That is not a pattern this can read: ' + (error as Error).message;
    }
  }
  return null;
}

/** A row after the last filled one, at a priority below every rule there — so it is tried last. */
export async function addRule(google: Google, request: RuleRequest): Promise<ActAnswer> {
  const [[rules, categoryValues], sheets] = await Promise.all([google.read([RANGES.rules, RANGES.categories]), google.sheets()]);
  const problem = ruleProblem(request ?? ({} as RuleRequest), categoriesOf(categoryValues));
  if (problem) throw new Refusal(problem);

  const existing = records(body(rules), RULE_COLUMNS, ANY_COLUMN);
  const at = (existing.length ? existing[existing.length - 1]._row : 1) + 1;
  const priority = existing.reduce((highest, rule) => {
    const value = Number(rule.priority);
    return !isBlankCell(rule.priority) && Number.isFinite(value) && value > highest ? value : highest;
  }, 0) + 10;

  await ensureRows(google, sheets, 'rules', at);
  await google.write([{
    range: `${quoted('rules')}!A${at}:${columnLetter(RULE_COLUMNS.length)}${at}`,
    values: [[
      priority, String(request.field), String(request.match_type), String(request.pattern).trim(), '',
      String(request.category), String(request.subcategory ?? ''), '', true
    ]]
  }]);
  return { message: 'Rule saved. It applies to new transactions from the next sync.', rows: {} };
}

// ---------------------------------------------------------------------------
// 4. Cash — `webAppAddCash_` and `drainCashEntries_`, in one step
// ---------------------------------------------------------------------------

/**
 * Straight into `transactions`. The `.gs` wrote a `cash_entry` row and drained
 * it under the script lock, because a sync might be draining at the same
 * moment; this writes the row the drain would have, at the next free row,
 * with the phone's id in its uid so a retry lands once.
 */
export async function addCash(google: Google, request: CashRequest, now: Date): Promise<ActAnswer> {
  const entry = request ?? ({} as CashRequest);
  if (typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(entry.id)) throw new Refusal('That entry has no id.');
  if (isBlankCell(entry.account as Cell)) throw new Refusal('Pick an account.');
  if (isBlankCell(entry.amount as Cell)) throw new Refusal('Type an amount.');
  const typed = Number(entry.amount);
  if (!Number.isFinite(typed)) throw new Refusal('That amount is not a number.');
  if (typed === 0) throw new Refusal('A zero-euro transaction is not a transaction.');
  if (entry.direction !== undefined && entry.direction !== TX_TYPE.INCOME && entry.direction !== TX_TYPE.EXPENSE) {
    throw new Refusal('Choose Expense or Income.');
  }

  const [[accounts, categoryValues, configValues, uids], sheets] = await Promise.all([
    google.read([RANGES.accounts, RANGES.categories, RANGES.config, RANGES.uids]),
    google.sheets()
  ]);
  const zone = sheets.timeZone;
  const today = clockAt(now, zone).today;

  let day: number | null = null;
  if (!isBlankCell(entry.date as Cell)) {
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(String(entry.date)) ? serialOf(String(entry.date), zone) : null;
    if (parsed === null) throw new Refusal('That date cannot be read.');
    day = Math.floor(parsed - SERIAL_EPOCH);
    if (day > today + 1) throw new Refusal('That date is in the future. A cash transaction is money already spent.');
  }

  const categories = categoriesOf(categoryValues);
  const category = String(entry.category ?? '').trim();
  const subcategory = String(entry.subcategory ?? '').trim();
  if (categories.parents.length || Object.keys(categories.kinds).length) {
    const missingCategory = !!category && !(category in categories.kinds);
    const missingSubcategory = !!subcategory && !categories.children.some((child) => child.name === subcategory);
    if (missingCategory || missingSubcategory) {
      throw new Refusal(`This book has no "${missingCategory ? category : subcategory}" category. ` +
        'Run Spendsheet → Setup sheet to add the ones that ship with it.');
    }
  }
  const kind = categories.kinds[category];
  const directed = directedCashAmount(entry);
  if (entry.direction === TX_TYPE.INCOME && cashEntryAmount(directed, kind) < 0) {
    throw new Refusal('Income needs an Income category — without one it is recorded as spending.');
  }
  const labels = normalizeLabels(entry.labels ?? []);
  if (labels && kind === TX_TYPE.TRANSFER) throw new Refusal('A transfer takes no labels.');

  // `resolveCashAccount_`: an id, a name, or — typed on the tab — neither.
  const typedAccount = String(entry.account);
  const known = records(body(accounts), ACCOUNT_COLUMNS).filter((row) => !isBlankCell(row.account_id));
  const match = known.find((row) => text(row.account_id) === typedAccount) ??
    known.find((row) => (text(row.name) || text(row.account_id)) === typedAccount);
  const accountId = match ? text(match.account_id) : typedAccount;
  const accountName = match ? text(match.name) || accountId : typedAccount;

  const amount = cashEntryAmount(directed, kind);
  const nowSerial = serialAt(now, zone);
  const daySerial = day === null ? null : day + SERIAL_EPOCH;
  const description = String(entry.note ?? '').trim() || category || 'Cash';
  const dayText = String(entry.date ?? '') || new Date((today) * 86400000).toISOString().slice(0, 10);
  const uid = await cashUid(accountId, dayText, amount, description, entry.id);
  if (hasUid(uids, uid)) return { message: 'Already added.', rows: {} };

  const at = nextRow(uids);
  await insertRow(google, sheets, at, {
    uid,
    account_id: accountId,
    account_name: accountName,
    booking_date: daySerial ?? nowSerial,
    value_date: daySerial ?? '',
    transaction_date: daySerial === null || day === today ? nowSerial : daySerial,
    amount,
    currency: text(configOf(configValues).base_currency) || 'EUR',
    description,
    source: TX_SOURCE_CASH,
    imported_at: nowSerial,
    category_override: category,
    subcategory_override: subcategory,
    labels
  });
  return { message: '1 added', rows: await fresh(google, [at]) };
}

// ---------------------------------------------------------------------------
// 5. Delete cash you typed — `webAppDeleteRecord_`
// ---------------------------------------------------------------------------

/**
 * Archived and removed in **one** `spreadsheets.batchUpdate`, which Google
 * applies all or nothing: the row is pasted, values only, after the last uid
 * on `_removed`, and then its sheet row is deleted. There is no moment at
 * which the row is gone and not archived. `12_monitor.gs` excuses the drop in
 * the row count by exactly that archived uid, which is why nothing here has to
 * reach the count it remembered.
 */
export async function deleteRecord(google: Google, request: DeleteRequest): Promise<ActAnswer> {
  if (!isRowRef(request)) throw new Refusal('Which transaction?');
  const [[values, removed], sheets] = await Promise.all([google.read([txRow(request.row), RANGES.removedUids]), google.sheets()]);
  const row = txRecord(values, request.row);
  if (text(row.uid) !== request.uid) throw new Refusal(moved);
  if (!recordIsDeletable(row.source)) {
    throw new Refusal('Only a cash transaction you typed can be deleted. A synced row would come back on the next sync.');
  }
  if (request.row <= 2) {
    throw new Refusal(`Refusing: this is row 2, and it anchors every formula in ${TABS.TRANSACTIONS}. Delete that one row by hand in the sheet.`);
  }
  const tx = sheets.tabs[TABS.TRANSACTIONS];
  const archive = sheets.tabs[TABS.REMOVED];
  if (!tx || !archive) throw new Refusal(`This book has no "${TABS.REMOVED}" tab. Run Spendsheet → Setup sheet first.`);

  const at = nextRow(removed);
  const requests: object[] = [];
  if (at > archive.rows) requests.push({ appendDimension: { sheetId: archive.sheetId, dimension: 'ROWS', length: at - archive.rows } });
  requests.push(
    {
      copyPaste: {
        source: { sheetId: tx.sheetId, startRowIndex: request.row - 1, endRowIndex: request.row, startColumnIndex: 0, endColumnIndex: TX_WIDTH },
        destination: { sheetId: archive.sheetId, startRowIndex: at - 1, endRowIndex: at, startColumnIndex: 0, endColumnIndex: TX_WIDTH },
        pasteType: 'PASTE_VALUES'
      }
    },
    { deleteDimension: { range: { sheetId: tx.sheetId, dimension: 'ROWS', startIndex: request.row - 1, endIndex: request.row } } }
  );
  await google.update(requests);
  return { message: 'Deleted.', rows: {}, removed: request.row };
}
