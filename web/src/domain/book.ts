/**
 * book.ts — one `values.batchGet`, as the records every screen is computed from.
 *
 * The Worker passes the response through unread (the 10ms CPU cap is why), so
 * this is where it is first understood. Each range comes back named, as
 * `'_status'!A1:I997`, and is matched to its tab by that name rather than by
 * position — a reordered request must not put `_runs` rows under `_status`
 * columns.
 *
 * `_config` is resolved into a key → value map here, over the defaults, so no
 * caller can forget the fallback: a key deleted from the tab reads as its
 * default, as `readConfig_` has it.
 */

import { dataRows, records, type Cell, type Record as SheetRecord } from '../sheets/records';
import { isBlankCell } from './cells';
import {
  ACCOUNT_COLUMNS, CATEGORY_COLUMNS, CONFIG_COLUMNS, DEFAULT_CONFIG, LABEL_COLUMNS,
  MEMORY_COLUMNS, MONITOR_COLUMNS, PENDING_COLUMNS, RUN_COLUMNS, STATUS_COLUMNS,
  TABS, TX_COLUMNS
} from './schema';

export type Row = SheetRecord<string>;

export type Book = {
  timeZone: string;
  transactions: Row[];
  pending: Row[];
  accounts: Row[];
  categories: Row[];
  labels: Row[];
  status: Row[];
  runs: Row[];
  config: { [key: string]: Cell };
  memory: Row[];
  /** `_monitor`'s one row, or null on a book set up before it existed. */
  monitor: Row | null;
  /** `_removed`'s uids, in archive order, blanks kept — only the row-loss check reads it. */
  removedUids: Cell[];
};

export type ValueRange = { range?: string; values?: Cell[][] };
export type BatchGet = { valueRanges?: ValueRange[] };

/** `'_status'!A1:I997` → `_status`. Quotes are doubled inside a quoted name. */
export function tabOf(range: string | undefined): string {
  const bang = String(range ?? '').lastIndexOf('!');
  const name = bang < 0 ? String(range ?? '') : String(range).slice(0, bang);
  return name.replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
}

/** Column index (1-based) of a name in a schema — `colIndex_`, which throws on a typo. */
export function colIndex(headers: readonly string[], name: string): number {
  const index = headers.indexOf(name);
  if (index === -1) throw new Error(`colIndex: no column named "${name}"`);
  return index + 1;
}

export function bookFromBatch(batch: BatchGet, timeZone: string): Book {
  const byTab = new Map<string, Cell[][]>();
  for (const range of batch.valueRanges ?? []) byTab.set(tabOf(range.range), dataRows(range.values));
  const rows = (tab: string) => byTab.get(tab) ?? [];

  const config: { [key: string]: Cell } = { ...DEFAULT_CONFIG };
  for (const row of records(rows(TABS.CONFIG), CONFIG_COLUMNS)) {
    if (row.key !== '' && row.key !== null) config[String(row.key)] = row.value;
  }

  const uid = colIndex(TX_COLUMNS, 'uid');
  const removed = records(rows(TABS.REMOVED), ['uid'], 1);
  const monitor = records(rows(TABS.MONITOR), MONITOR_COLUMNS, 1);

  return {
    timeZone,
    transactions: records(rows(TABS.TRANSACTIONS), TX_COLUMNS, uid),
    pending: records(rows(TABS.PENDING), PENDING_COLUMNS, uid),
    accounts: records(rows(TABS.ACCOUNTS), ACCOUNT_COLUMNS),
    categories: records(rows(TABS.CATEGORIES), CATEGORY_COLUMNS),
    labels: records(rows(TABS.LABELS), LABEL_COLUMNS),
    status: records(rows(TABS.STATUS), STATUS_COLUMNS),
    runs: records(rows(TABS.RUNS), RUN_COLUMNS),
    config,
    memory: records(rows(TABS.MEMORY), MEMORY_COLUMNS, 1).filter((row) => !isBlankCell(row.merchant_key)),
    monitor: monitor[0] ?? null,
    removedUids: removed.map((row) => row.uid)
  };
}

/** `configNumber_`: the tab's value when it is a number, else the default, else 0. */
export function configNumber(config: Book['config'], key: string): number {
  const raw = config[key];
  const value = Number(raw);
  if (!isBlankCell(raw) && Number.isFinite(value)) return value;
  const fallback = DEFAULT_CONFIG[key];
  return fallback === undefined ? 0 : Number(fallback);
}
