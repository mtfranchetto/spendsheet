/**
 * batch.mjs — a harness book as the Sheets API would send it.
 *
 * What `values.batchGet` returns with `UNFORMATTED_VALUE` and `SERIAL_NUMBER`,
 * over the Worker's own `READ_RANGES`: header row included, every date a
 * serial, each row cut after its last non-empty cell, trailing empty rows
 * gone. Shared by the parity test, which holds the port to the `.gs` through
 * it, and the viewer's browser tests, which draw it — so the book on screen in
 * a test is the book the parity test proved the numbers for.
 */

import { READ_RANGES } from '../web/worker/router.ts';

const DAY = 24 * 60 * 60 * 1000;

/** The column letters to a width: `AD` → 30. */
export function width(range) {
  const letters = /:([A-Z]+)$/.exec(range)[1];
  return [...letters].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
}

/** A local `Date` as a Sheets serial: the wall clock, fraction and all. */
function serial(date) {
  const wall = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(),
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
  return wall / DAY + 25569;
}

/**
 * The harness's book as `values.batchGet` with `UNFORMATTED_VALUE` and
 * `SERIAL_NUMBER` would return it: header row included, every date a serial,
 * each row cut after its last non-empty cell, trailing empty rows gone.
 */
export function asBatchGet(c) {
  const valueRanges = Object.entries(READ_RANGES).map(([tab, range]) => {
    const sheet = c.__spreadsheet.getSheetByName(tab);
    if (!sheet || sheet.getLastRow() < 1) return { range };

    const rows = sheet.getRange(1, 1, sheet.getLastRow(), width(range)).getValues()
      .map((row) => {
        const cells = row.map((v) => (v instanceof Date ? serial(v) : v === null || v === undefined ? '' : v));
        while (cells.length && cells[cells.length - 1] === '') cells.pop();
        return cells;
      });
    while (rows.length && !rows[rows.length - 1].length) rows.pop();
    return rows.length ? { range, values: rows } : { range };
  });
  return { valueRanges };
}

