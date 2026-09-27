/**
 * fake-google.ts — a spreadsheet in memory, behind the `Google` an action writes through.
 *
 * No more forgiving than the real one, in the three ways that matter here:
 * a read drops trailing blank cells and rows as the REST API does (so a short
 * row read positionally is caught), a write past the grid is refused rather
 * than grown, and `RAW` means a string is stored as the string. What it does
 * not do is recalculate: derived columns hold whatever the test put there.
 */

import type { Cell } from '../src/sheets/records';
import type { Google, Sheets } from './actions';

type Tab = { sheetId: number; rows: number; grid: Cell[][] };

const COLUMN = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/** `'tab'!A5:AD5`, `'tab'!A1:A`, `'tab'!T5` → a tab and a 1-based box, open-ended rows as Infinity. */
export function parseRange(range: string) {
  const match = /^'((?:[^']|'')+)'!([A-Z]+)(\d+)(?::([A-Z]+)(\d*))?$/.exec(range);
  if (!match) throw new Error(`fake Google cannot read the range ${range}`);
  const [, tab, c1, r1, c2, r2] = match;
  return {
    tab: tab.replace(/''/g, "'"),
    c1: COLUMN(c1),
    r1: Number(r1),
    c2: c2 ? COLUMN(c2) : COLUMN(c1),
    r2: c2 === undefined ? Number(r1) : r2 ? Number(r2) : Infinity
  };
}

const blank = (value: Cell | undefined) => value === undefined || value === null || value === '';

export class FakeGoogle implements Google {
  readonly tabs: { [title: string]: Tab } = {};
  readonly calls: { kind: 'read' | 'write' | 'update' | 'sheets'; detail: unknown }[] = [];
  timeZone = 'Europe/Rome';
  /** Runs once before the next update — another writer acting between this one's read and its write. */
  meanwhile: (() => void) | null = null;
  private nextId = 1;

  /** A tab of `rows` grid rows, holding `values` from row 1 (the header) down. */
  tab(title: string, values: Cell[][], rows = Math.max(values.length, 1000)): this {
    this.tabs[title] = { sheetId: this.nextId++, rows, grid: values.map((row) => row.slice()) };
    return this;
  }

  cell(title: string, row: number, column: number): Cell | undefined {
    return this.tabs[title]?.grid[row - 1]?.[column - 1];
  }

  row(title: string, row: number): Cell[] {
    return this.tabs[title]?.grid[row - 1] ?? [];
  }

  async read(ranges: string[]): Promise<Cell[][][]> {
    this.calls.push({ kind: 'read', detail: ranges });
    return ranges.map((range) => {
      const box = parseRange(range);
      const tab = this.tabs[box.tab];
      if (!tab) throw new Error(`no tab ${box.tab}`);
      const out: Cell[][] = [];
      for (let r = box.r1; r <= Math.min(box.r2, tab.grid.length); r++) {
        const cells = (tab.grid[r - 1] ?? []).slice(box.c1 - 1, box.c2);
        while (cells.length && blank(cells[cells.length - 1])) cells.pop();
        out.push(cells.map((value) => (value === undefined ? '' : value)));
      }
      while (out.length && !out[out.length - 1].length) out.pop();
      return out;
    });
  }

  async write(data: { range: string; values: Cell[][] }[]): Promise<void> {
    this.calls.push({ kind: 'write', detail: data });
    for (const { range, values } of data) {
      const box = parseRange(range);
      const tab = this.tabs[box.tab];
      if (!tab) throw new Error(`no tab ${box.tab}`);
      values.forEach((cells, i) => {
        const r = box.r1 + i;
        if (r > tab.rows) throw new Error(`Range (${range}) exceeds grid limits. Max rows: ${tab.rows}`);
        while (tab.grid.length < r) tab.grid.push([]);
        cells.forEach((value, c) => {
          tab.grid[r - 1][box.c1 - 1 + c] = value;
        });
      });
    }
  }

  async update(requests: object[]): Promise<void> {
    this.calls.push({ kind: 'update', detail: requests });
    const other = this.meanwhile;
    this.meanwhile = null;
    other?.();
    const byId = (id: number) => Object.values(this.tabs).find((tab) => tab.sheetId === id) as Tab;
    for (const request of requests as { [kind: string]: any }[]) {
      if (request.appendDimension) {
        byId(request.appendDimension.sheetId).rows += request.appendDimension.length;
      } else if (request.copyPaste) {
        const { source, destination, pasteType } = request.copyPaste;
        if (pasteType !== 'PASTE_VALUES') throw new Error('only values');
        const from = byId(source.sheetId);
        const to = byId(destination.sheetId);
        if (destination.endRowIndex > to.rows) throw new Error('exceeds grid limits');
        const cells = (from.grid[source.startRowIndex] ?? []).slice(source.startColumnIndex, source.endColumnIndex);
        while (to.grid.length <= destination.startRowIndex) to.grid.push([]);
        to.grid[destination.startRowIndex] = cells.map((value) => (value === undefined ? '' : value));
      } else if (request.insertDimension) {
        const { sheetId, startIndex, endIndex } = request.insertDimension.range;
        const tab = byId(sheetId);
        if (startIndex >= tab.rows) throw new Error('insert outside the grid');
        while (tab.grid.length < startIndex) tab.grid.push([]);
        tab.grid.splice(startIndex, 0, ...Array.from({ length: endIndex - startIndex }, () => [] as Cell[]));
        tab.rows += endIndex - startIndex;
      } else if (request.updateCells) {
        const { start, rows } = request.updateCells;
        const tab = byId(start.sheetId);
        rows.forEach((row: { values: { userEnteredValue?: { [kind: string]: Cell } }[] }, i: number) => {
          const r = start.rowIndex + i;
          if (r >= tab.rows) throw new Error('exceeds grid limits');
          while (tab.grid.length <= r) tab.grid.push([]);
          row.values.forEach((cell, c) => {
            const value = cell.userEnteredValue ? Object.values(cell.userEnteredValue)[0] : '';
            tab.grid[r][start.columnIndex + c] = value;
          });
        });
      } else if (request.deleteDimension) {
        const { sheetId, startIndex, endIndex } = request.deleteDimension.range;
        const tab = byId(sheetId);
        tab.grid.splice(startIndex, endIndex - startIndex);
        tab.rows -= endIndex - startIndex;
      } else {
        throw new Error(`fake Google does not know ${Object.keys(request)[0]}`);
      }
    }
  }

  async sheets(): Promise<Sheets> {
    this.calls.push({ kind: 'sheets', detail: null });
    const tabs: Sheets['tabs'] = {};
    for (const [title, tab] of Object.entries(this.tabs)) tabs[title] = { sheetId: tab.sheetId, rows: tab.rows };
    return { timeZone: this.timeZone, tabs };
  }

  /** Every write and update, in order — what a test asserts nothing of when a request is refused. */
  get writes() {
    return this.calls.filter((call) => call.kind === 'write' || call.kind === 'update');
  }
}
