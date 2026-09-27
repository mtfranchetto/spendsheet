/**
 * probe.ts — the one number this plan depends on, taken on the phone.
 *
 * How long a full `batchGet` over the real book takes, and how many bytes it
 * is, decides whether phase 3 reads the whole ledger on every open or only the
 * rows after the last cached one. Nobody has measured it. This does, and it
 * follows the repo's rule that **one timing is not a measurement**: it samples
 * several times within one run, where every sample sees the same conditions.
 *
 * Each sample splits its time in two. `google` is what the Worker measured to
 * Google's headers, read from `Server-Timing`; `total` is the phone's own clock
 * around the whole request. The difference is the network and the Worker, which
 * is the part a faster Google would not fix.
 *
 * Rows are counted by the key column, as `records.ts` counts them, rather than
 * by the array's length — an `ARRAYFORMULA` tab hands back trailing blank rows
 * and those are not records.
 */

import { tabOf } from './domain/book';
import { lastRecordIndex, type Cell } from './sheets/records';

export { tabOf };

export type ValueRanges = { valueRanges?: { range?: string; values?: Cell[][] }[] };

export type Sample = { total: number; google: number | null; bytes: number };

/** Records per tab: data rows up to the last with a first column. */
export function rowCounts(payload: ValueRanges): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const block of payload.valueRanges ?? []) {
    const rows = (block.values ?? []).slice(1);
    counts[tabOf(block.range)] = lastRecordIndex(rows, rows[0]?.length ?? 0, 1);
  }
  return counts;
}

/** The Worker's `google;dur=123`, or null if it did not say. */
export function googleMs(header: string | null): number | null {
  const match = /(?:^|,)\s*google;dur=(\d+(?:\.\d+)?)/.exec(header ?? '');
  return match ? Number(match[1]) : null;
}

/** Min, median and max of a list of numbers; null for an empty one. */
export function spread(values: number[]): { min: number; median: number; max: number } | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { min: sorted[0], median, max: sorted[sorted.length - 1] };
}
