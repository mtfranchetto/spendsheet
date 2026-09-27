/**
 * testing.ts — books for the domain tests, built the way the Sheets API sends them.
 *
 * A header row, then each record in schema order, dates as serials: exactly
 * what `bookFromBatch` reads from `values.batchGet`, so a test here exercises
 * the adapter as well as the logic. Imported only by `*.test.ts`, so the page
 * never bundles it.
 */

import type { Cell } from '../sheets/records';
import { bookFromBatch, type Book } from './book';
import { clockAt, MS_PER_DAY, SERIAL_EPOCH, type Clock } from './days';
import { ledgerOf, type LedgerRow } from './query';
import {
  ACCOUNT_COLUMNS, CATEGORY_COLUMNS, LABEL_COLUMNS, MEMORY_COLUMNS, PENDING_COLUMNS,
  RUN_COLUMNS, STATUS_COLUMNS, TX_COLUMNS
} from './schema';

export const ZONE = 'Europe/Rome';

export type Values = { [column: string]: Cell };

/** A calendar day as the serial a date cell holds, `month` 1–12, with an optional time of day. */
export function serial(year: number, month: number, date: number, hours = 0, minutes = 0): number {
  return Date.UTC(year, month - 1, date, hours, minutes) / MS_PER_DAY + SERIAL_EPOCH;
}

/** The book's clock at noon on a day. */
export function at(year: number, month: number, date: number): Clock {
  return clockAt(new Date(Date.UTC(year, month - 1, date, 10)), ZONE);
}

const TAB_COLUMNS: { [tab: string]: readonly string[] } = {
  transactions: TX_COLUMNS,
  pending: PENDING_COLUMNS,
  accounts: ACCOUNT_COLUMNS,
  categories: CATEGORY_COLUMNS,
  labels: LABEL_COLUMNS,
  _status: STATUS_COLUMNS,
  _runs: RUN_COLUMNS,
  _memory: MEMORY_COLUMNS
};

export type Tabs = {
  transactions?: Values[];
  pending?: Values[];
  accounts?: Values[];
  categories?: Values[];
  labels?: Values[];
  _status?: Values[];
  _runs?: Values[];
  _memory?: Values[];
  _config?: { [key: string]: Cell };
};

/** A book holding these records, and its ledger. */
export function bookOf(tabs: Tabs): { book: Book; ledger: LedgerRow[] } {
  const valueRanges = Object.entries(TAB_COLUMNS).map(([tab, columns]) => ({
    range: `'${tab}'!A1:AD`,
    values: [columns as Cell[], ...((tabs[tab as keyof Tabs] as Values[] | undefined) ?? [])
      .map((row) => columns.map((column) => (column in row ? row[column] : '')))]
  }));
  const config = Object.entries(tabs._config ?? {});
  valueRanges.push({ range: "'_config'!A1:B", values: [['key', 'value'], ...config] });

  const book = bookFromBatch({ valueRanges }, ZONE);
  return { book, ledger: ledgerOf(book) };
}

/** Food & Drink with two children, Transport, Income and Transfer — enough for kinds to mean something. */
export const CATEGORIES: Values[] = [
  { category: 'Food & Drink', subcategory: 'Groceries', kind: 'expense', icon: '🛒' },
  { category: 'Food & Drink', subcategory: 'Restaurants', kind: 'expense', icon: '🍝' },
  { category: 'Transport', subcategory: 'Fuel', kind: 'expense', icon: '⛽' },
  { category: 'Income', subcategory: 'Salary', kind: 'income', icon: '💶' },
  { category: 'Transfer', subcategory: 'Between accounts', kind: 'transfer', icon: '⇄' },
  { category: 'Transfer', subcategory: 'Valuation change', kind: 'transfer', icon: '' }
];
