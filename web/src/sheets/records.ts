/**
 * records.ts — the Sheets API values array, as `readRecords_` hands rows back.
 *
 * This is the whole adapter. `domain/query.ts` is pure aggregation over an
 * array of objects keyed by column name, the shape `readRecords_` gives the
 * `.gs`; produce the same objects from a `values.batchGet` and the aggregation
 * needs nothing else — which is why this file exists and why it is small.
 *
 * It reproduces `03_sheets.gs`'s semantics deliberately, including the ones
 * that look like quirks:
 *
 *   `_row` is the 1-based sheet row, because every writer downstream addresses
 *   a cell by it. Dropping it here would cost the write path its addressing.
 *
 *   The block is exactly `headers.length` wide. Columns you have added to the
 *   right of the schema are neither read nor disturbed — the same promise the
 *   `.gs` makes, and the reason a user's own notes survive a sync.
 *
 *   Rows are counted by the **key column**, never by the array's length. See
 *   `lastRecordRow` below: `getLastRow()` lying is an Apps Script problem, but
 *   trailing blank rows are not, and a tab carrying an `ARRAYFORMULA` hands
 *   back a thousand of them from either source.
 *
 * ## The one difference from `getValues()`, and it is the dangerous kind
 *
 * `getValues()` always returns a full rectangle: ask for thirty columns and
 * every row has thirty cells, blank ones included. **The Sheets REST API does
 * not.** It truncates trailing empty cells from each row and trailing empty
 * rows from the range, so a row whose last four columns are blank comes back
 * with twenty-six entries and a row that is entirely blank may not come back
 * at all. Read that array positionally and every short row loses its tail
 * columns to `undefined` — which is not `''`, so `isBlankCell_` is not even
 * asked, and the value reads as missing rather than as empty.
 *
 * The rows most likely to be short are the newest ones (overrides unset,
 * nothing reviewed yet), so the symptom would be the recent end of the ledger
 * quietly losing its derived columns while the old rows look perfect.
 *
 * `pad` is the answer and it runs on every row, unconditionally. Cheap, and
 * the alternative is a class of bug this project has already paid for twice
 * under other names.
 */

/** Pass as `keyColumn` when no single column is reliably filled first. */
export const ANY_COLUMN = 0;

/** One cell, as the Sheets API renders it before anything interprets it. */
export type Cell = string | number | boolean | null;

/** A record: the schema columns by name, plus the row it came from. */
export type Record<K extends string = string> = { _row: number } & {
  [name in K]: Cell;
};

/**
 * The last row that actually holds a record, judged by its key column.
 * Returns 0 when there are none — the caller slices, so this is an index.
 *
 * `ANY_COLUMN` widens the test to the whole schema block, for tabs you type
 * into in no fixed order. `cash_entry` is the one that needs it: insisting on
 * a single key column there means a row whose first cell you have not filled
 * yet is invisible, and a transaction you typed silently never syncs.
 */
export function lastRecordIndex(
  rows: readonly (readonly Cell[])[],
  width: number,
  keyColumn: number = 1
): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i] ?? [];
    if (keyColumn === ANY_COLUMN) {
      for (let c = 0; c < width; c++) if (!isBlank(row[c])) return i + 1;
    } else if (!isBlank(row[keyColumn - 1])) {
      return i + 1;
    }
  }
  return 0;
}

/**
 * Blank as `03_sheets.gs` means it: empty string or absent.
 *
 * `undefined` is in here only because of the truncation described above — the
 * `.gs` never sees one, since `getValues()` cannot produce one. Treating it as
 * blank is what makes a padded row and a full row indistinguishable to
 * everything downstream, which is the entire point of padding.
 */
function isBlank(value: Cell | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/** A row widened to the schema, so a truncated tail reads as empty, not absent. */
function pad(row: readonly Cell[], width: number): Cell[] {
  const out: Cell[] = new Array(width);
  for (let c = 0; c < width; c++) out[c] = row[c] === undefined ? '' : row[c];
  return out;
}

/**
 * The data rows of a tab as objects keyed by column name.
 *
 * @param rows    values from **row 2 down** — the header row already dropped
 * @param headers the schema constant (`TX_COLUMNS` and friends), not the
 *                sheet's own header row. Reading the names off the sheet would
 *                make a renamed column silently change what the query reads;
 *                the `.gs` takes the constant for that reason and so does this.
 * @param keyColumn 1-based, or `ANY_COLUMN`
 */
export function records<K extends string>(
  rows: readonly (readonly Cell[])[],
  headers: readonly K[],
  keyColumn: number = 1
): Record<K>[] {
  const width = headers.length;
  const last = lastRecordIndex(rows, width, keyColumn);

  const out: Record<K>[] = [];
  for (let i = 0; i < last; i++) {
    const values = pad(rows[i] ?? [], width);
    const record = { _row: i + 2 } as Record<K>;
    headers.forEach((name, c) => {
      (record as any)[name] = values[c];
    });
    out.push(record);
  }
  return out;
}

/**
 * Drop the header row from a `values.batchGet` range that starts at row 1.
 *
 * Separate from `records` because the range a caller asks for is the caller's
 * decision — `A1:AD` and `A2:AD` are both reasonable, and the second needs no
 * dropping. Making that explicit at the call site beats a flag.
 */
export function dataRows(values: readonly (readonly Cell[])[] | undefined): Cell[][] {
  if (!values || values.length < 2) return [];
  return values.slice(1) as Cell[][];
}
