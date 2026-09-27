/**
 * harness.mjs — run the shipped .gs files in Node.
 *
 * Apps Script has no test runner and no module system: it concatenates every
 * source file into one global scope and executes it. This reproduces exactly
 * that, using node:vm, with the Google services replaced by in-memory fakes.
 *
 * The point is that there is NO build step and NO second copy of the source.
 * The files loaded here are byte-for-byte the files you paste into the Apps
 * Script editor. A test that passes here is testing what ships — and adding
 * an `export` to make a function reachable would break it for every user,
 * which is why CI greps for import/export in src/.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import crypto from 'node:crypto';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** Source files in the order Apps Script would load them — hence the numbering. */
export function sourceFiles() {
  return readdirSync(SRC).filter((f) => f.endsWith('.gs')).sort();
}

/**
 * Load src/*.gs into a fresh sandbox and return the global object, so tests
 * reach every top-level function by name: `const ctx = load(); ctx.setup()`.
 */
export function load(options = {}) {
  const sandbox = createGoogleStubs(options);
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of sourceFiles()) {
    const code = readFileSync(join(SRC, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }
  return sandbox;
}

// ---------------------------------------------------------------------------
// A1 notation
// ---------------------------------------------------------------------------

export function columnToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Parse A1 into 1-based bounds. Open-ended ranges ("A2:A") are how the .gs
 * files address whole columns, so they resolve against the sheet's extent.
 */
export function parseA1(a1, maxRows, maxCols) {
  const cell = /^\$?([A-Z]+)\$?(\d+)?$/i;
  const [startRaw, endRaw] = a1.split(':');

  const start = startRaw.match(cell);
  if (!start) throw new Error(`unparseable A1: ${a1}`);
  const startCol = columnToIndex(start[1]);
  const startRow = start[2] ? Number(start[2]) : 1;

  if (endRaw === undefined) {
    return { row: startRow, col: startCol, numRows: 1, numCols: 1 };
  }

  const end = endRaw.match(cell);
  if (!end) throw new Error(`unparseable A1: ${a1}`);
  const endCol = columnToIndex(end[1]);
  const endRow = end[2] ? Number(end[2]) : maxRows;

  return {
    row: startRow,
    col: startCol,
    numRows: Math.max(0, endRow - startRow + 1),
    numCols: Math.max(0, endCol - startCol + 1)
  };
}

// ---------------------------------------------------------------------------
// Fake Sheets
// ---------------------------------------------------------------------------

const DEFAULT_ROWS = 1000;
const DEFAULT_COLS = 26;

/**
 * Every `getValues` in the run, by tab.
 *
 * A round trip is what a spreadsheet read costs — ~175ms on the live book,
 * near enough the same whether it returns one column or thirty — so the thing
 * worth testing about a read cache is *how many calls happened*, not how long
 * they took. A duration cannot be asserted in a harness with no spreadsheet
 * behind it; a call count can, exactly.
 */
const readCounts = new Map();

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  getValues() {
    readCounts.set(this.sheet.getName(), (readCounts.get(this.sheet.getName()) || 0) + 1);
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet._get(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }

  getFormulas() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        line.push(this.sheet.formulas.get(`${this.row + r},${this.col + c}`) || '');
      }
      out.push(line);
    }
    return out;
  }

  getValue() {
    const formula = this.sheet.formulas.get(`${this.row},${this.col}`);
    const results = this.sheet.book && this.sheet.book.formulaResults;
    if (formula && results && results.has(formula)) return results.get(formula);
    return this.sheet._get(this.row, this.col);
  }

  setValues(values) {
    values.forEach((line, r) =>
      line.forEach((v, c) => this.sheet._set(this.row + r, this.col + c, v)));
    return this;
  }

  setValue(v) { this.sheet._set(this.row, this.col, v); return this; }

  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getSheet() { return this.sheet; }

  setFontSize(n) { this.sheet.fontSizes.set(`${this.row},${this.col}`, n); return this; }

  /**
   * The selection, which "Confirm visible rows" reads to decide what it is
   * being asked to confirm. Recorded on the sheet rather than on the book,
   * matching `getActiveRange()` being a Sheet method.
   */
  activate() { this.sheet.activeRange = this; return this; }

  clearContent() {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) this.sheet._set(this.row + r, this.col + c, '');
    }
    return this;
  }

  setFormula(f) {
    this.sheet.formulas.set(`${this.row},${this.col}`, f);
    return this;
  }

  getFormula() { return this.sheet.formulas.get(`${this.row},${this.col}`) || ''; }

  setNote(note) { this.sheet.notes.set(`${this.row},${this.col}`, note); return this; }
  getNote() { return this.sheet.notes.get(`${this.row},${this.col}`) || ''; }

  setNumberFormat(pattern) {
    this.sheet.record('numberFormat', { a1: this.a1(), pattern });
    return this;
  }

  setDataValidation(rule) {
    this.sheet.record('validation', { a1: this.a1(), rule });
    return this;
  }

  setFontWeight(w) { this.sheet.record('fontWeight', { a1: this.a1(), w }); return this; }
  setBackground(b) { this.sheet.record('background', { a1: this.a1(), b }); return this; }
  setFontColor(c) { this.sheet.record('fontColor', { a1: this.a1(), c }); return this; }

  protect() {
    const p = new FakeProtection(this);
    this.sheet.protections.push(p);
    return p;
  }

  a1() { return `${this.row},${this.col},${this.numRows},${this.numCols}`; }

  /** Bounded A1, matching how Apps Script resolves an open-ended range. */
  getA1Notation() {
    const start = `${indexToColumn(this.col)}${this.row}`;
    if (this.numRows === 1 && this.numCols === 1) return start;
    return `${start}:${indexToColumn(this.col + this.numCols - 1)}${this.row + this.numRows - 1}`;
  }
}

export function indexToColumn(index) {
  let s = '';
  let n = index;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

class FakeChartBuilder {
  constructor(sheet) {
    this.sheet = sheet;
    this.chartType = null;
    this.ranges = [];
    this.position = null;
    this.numHeaders = 0;
    this.options = {};
  }

  setChartType(type) { this.chartType = type; return this; }
  addRange(range) { this.ranges.push(range); return this; }
  setPosition(row, column, offsetX, offsetY) {
    this.position = { row, column, offsetX, offsetY };
    return this;
  }
  setNumHeaders(n) { this.numHeaders = n; return this; }
  setOption(key, value) { this.options[key] = value; return this; }

  build() {
    const options = { ...this.options };
    const built = this.ranges.slice();

    return {
      type: this.chartType,
      numHeaders: this.numHeaders,
      options,
      position: this.position,
      ranges: built.map((r) => r.getA1Notation()),
      // The two accessors the real EmbeddedChart has, since `emptyCharts_`
      // reads a chart back through them.
      getRanges: () => built.slice(),
      getOptions: () => ({ get: (key) => options[key] })
    };
  }
}

class FakeConditionalFormatRuleBuilder {
  constructor() {
    this.rule = {
      formula: null, background: null, fontColor: null,
      strikethrough: false, ranges: []
    };
  }
  whenFormulaSatisfied(formula) { this.rule.formula = formula; return this; }
  setBackground(colour) { this.rule.background = colour; return this; }
  setFontColor(colour) { this.rule.fontColor = colour; return this; }
  setStrikethrough(on) { this.rule.strikethrough = on; return this; }
  setRanges(ranges) { this.rule.ranges = ranges.map((r) => r.getA1Notation()); return this; }
  build() { return this.rule; }
}

class FakeProtection {
  constructor(range) { this.range = range; this.description = ''; this.warningOnly = false; }
  setDescription(d) { this.description = d; return this; }
  getDescription() { return this.description; }
  setWarningOnly(w) { this.warningOnly = w; return this; }
  isWarningOnly() { return this.warningOnly; }
  getRange() { return this.range; }
}

class FakeSheet {
  constructor(name, book) {
    this.name = name;
    this.book = book;
    this.cells = new Map();
    this.formulas = new Map();
    this.notes = new Map();
    this.fontSizes = new Map();
    this.columnWidths = new Map();
    this.hiddenColumns = new Set();
    this.protections = [];
    this.charts = [];
    this.conditionalFormatRules = [];
    this.activeRange = null;
    this.filter = null;
    this.frozenRows = 0;
    this.hidden = false;
    this.maxRows = DEFAULT_ROWS;
    this.maxColumns = DEFAULT_COLS;
    this.calls = [];
  }

  record(kind, detail) { this.calls.push({ kind, ...detail }); }
  _key(r, c) { return `${r},${c}`; }
  _get(r, c) { const v = this.cells.get(this._key(r, c)); return v === undefined ? '' : v; }
  /**
   * Writing a value destroys any formula in that cell, exactly as in Sheets —
   * including when the value is blank, which is the case that matters. A
   * paste or a setValues one column too wide is how the `amount_base`
   * ARRAYFORMULA gets silently deleted, and a fake that kept the formula
   * alive underneath the value would call that write harmless. Being more
   * forgiving than the real thing is the worst direction for a double to be
   * wrong in.
   */
  _set(r, c, v) {
    const key = this._key(r, c);
    this._grow(r, c);
    this.formulas.delete(key);
    // A leading apostrophe is Sheets' "treat this as text" marker: it is
    // consumed on write and never comes back out of `getValue`. The fake has
    // to do the same or `textSafe_` looks lossy here and is not in production
    // — a test would then pin `'=x` as the stored description, which is a
    // value no book has ever held. Exactly one, as Sheets does: `''x` is `'x`.
    const stored = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
    if (stored === '' || stored === null || stored === undefined) this.cells.delete(key);
    else this.cells.set(key, stored);
  }

  /**
   * Writing past the edge grows the grid, as Sheets does.
   *
   * Not a detail: `buildTable_` has always written more headers than the 26
   * columns a new sheet is born with, so a fake that left `maxColumns` at 26
   * reported a sheet narrower than its own contents — and any code that asks
   * `getMaxColumns()` before touching a column then reads as a no-op in tests
   * while doing the real thing in the book. `makeRoomForNewColumns_` is
   * exactly that code.
   */
  _grow(r, c) {
    if (r > this.maxRows) this.maxRows = r;
    if (c > this.maxColumns) this.maxColumns = c;
  }

  getName() { return this.name; }
  setName(n) { this.name = n; return this; }

  /**
   * Appends after getLastRow(), exactly as Sheets does — including on a tab
   * whose row 2 holds an ARRAYFORMULA, where that is row 1001 and not row 2.
   * Faithful rather than helpful on purpose: appendRow is the trap that
   * `appendRows_` exists to avoid, so the fake has to be able to spring it.
   */
  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, c) => this._set(row, c + 1, v));
    return this;
  }

  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const p = parseA1(a, this.maxRows, this.maxColumns);
      return new FakeRange(this, p.row, p.col, p.numRows, p.numCols);
    }
    return new FakeRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }

  /**
   * Formula cells count as content, exactly as they do in Sheets. This
   * matters: several tabs carry an ARRAYFORMULA in row 2, so getLastRow()
   * reports 2 with zero records — and code that appends at getLastRow() + 1
   * silently leaves a blank first row. Modelling only stored values made the
   * fake more forgiving than the real thing, which is the worst direction
   * for a test double to be wrong in.
   */
  _lastIn(index) {
    let last = 0;
    for (const key of this.cells.keys()) last = Math.max(last, Number(key.split(',')[index]));
    for (const key of this.formulas.keys()) last = Math.max(last, Number(key.split(',')[index]));
    return last;
  }

  getLastRow() { return this._lastIn(0); }
  getLastColumn() { return this._lastIn(1); }

  getMaxRows() { return this.maxRows; }
  getMaxColumns() { return this.maxColumns; }

  deleteColumns(start, howMany) {
    for (const key of [...this.cells.keys()]) {
      const [r, c] = key.split(',').map(Number);
      if (c >= start && c < start + howMany) this.cells.delete(key);
      else if (c >= start + howMany) {
        const v = this.cells.get(key);
        this.cells.delete(key);
        this.cells.set(this._key(r, c - howMany), v);
      }
    }
    this.maxColumns -= howMany;
    return this;
  }

  /**
   * Shifts values, formulas and notes right, the way `makeRoomForNewColumns_`
   * needs: it inserts a slot for a column the schema has grown into, and a
   * fake that moved only the values would let a test claim a user's formula
   * column survived a shift that had actually flattened it.
   */
  insertColumnBefore(index) {
    const shift = (map) => {
      for (const key of [...map.keys()].sort((a, b) => Number(b.split(',')[1]) - Number(a.split(',')[1]))) {
        const [r, c] = key.split(',').map(Number);
        if (c < index) continue;
        const v = map.get(key);
        map.delete(key);
        map.set(this._key(r, c + 1), v);
      }
    };
    shift(this.cells);
    shift(this.formulas);
    shift(this.notes);
    this.maxColumns += 1;
    return this;
  }

  /**
   * Shifts formulas and notes as well as values, because the one caller
   * (`commitSyncedDuplicates_`) deletes rows out of a tab whose row 2 holds
   * eleven ARRAYFORMULAs — and a fake that dropped formulas on the floor would
   * let a test claim row 2 survived a deletion that in Sheets would have taken
   * it with everything below.
   */
  deleteRows(start, howMany = 1) {
    const shift = (map) => {
      for (const key of [...map.keys()]) {
        const [r, c] = key.split(',').map(Number);
        if (r >= start && r < start + howMany) map.delete(key);
        else if (r >= start + howMany) {
          const v = map.get(key);
          map.delete(key);
          map.set(this._key(r - howMany, c), v);
        }
      }
    };
    shift(this.cells);
    shift(this.formulas);
    shift(this.notes);
    this.maxRows -= howMany;
    return this;
  }

  setColumnWidth(column, width) { this.columnWidths.set(column, width); return this; }
  hideColumns(column, count = 1) {
    for (let i = 0; i < count; i++) this.hiddenColumns.add(column + i);
    return this;
  }
  showColumns(column, count = 1) {
    for (let i = 0; i < count; i++) this.hiddenColumns.delete(column + i);
    return this;
  }
  isColumnHiddenByUser(column) { return this.hiddenColumns.has(column); }
  setFrozenRows(n) { this.frozenRows = n; return this; }
  getFrozenRows() { return this.frozenRows; }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }
  clear() { this.cells.clear(); this.formulas.clear(); this.notes.clear(); return this; }
  getProtections() { return this.protections.slice(); }
  getActiveRange() { return this.activeRange || null; }

  /**
   * Charts, modelled just far enough to catch the two mistakes a string test
   * cannot: a chart pointed at a range with nothing in it, and a `setup()`
   * that stacks another copy on every run. An EmbeddedChart has no id in the
   * real API either, which is exactly why the code never tries to update one
   * in place.
   */
  newChart() { return new FakeChartBuilder(this); }
  insertChart(chart) { this.charts.push(chart); return this; }
  removeChart(chart) { this.charts = this.charts.filter((c) => c !== chart); return this; }
  getCharts() { return this.charts.slice(); }

  setConditionalFormatRules(rules) { this.conditionalFormatRules = rules.slice(); return this; }
  getConditionalFormatRules() { return this.conditionalFormatRules.slice(); }

  /**
   * No filter unless a test installs one. Deliberately not faked further:
   * `isRowHiddenByFilter` is real spreadsheet state with no local model behind
   * it, and a stub that always answered "visible" would let a test claim
   * "Confirm visible rows" respects a filter it never actually consulted.
   */
  getFilter() { return this.filter || null; }
  isRowHiddenByFilter(row) { return !!(this.filter && this.filter.hidden.indexOf(row) !== -1); }

  /** Test convenience: the header row as a plain array. */
  headers() {
    const n = this.getLastColumn();
    return n ? this.getRange(1, 1, 1, n).getValues()[0] : [];
  }

  /** Test convenience: a serialisable snapshot, for idempotency diffing. */
  snapshot() {
    return {
      name: this.name,
      hidden: this.hidden,
      frozenRows: this.frozenRows,
      maxColumns: this.maxColumns,
      cells: [...this.cells.entries()].sort(),
      formulas: [...this.formulas.entries()].sort(),
      notes: [...this.notes.entries()].sort(),
      protections: this.protections.map((p) => [p.getDescription(), p.isWarningOnly()]).sort(),
      // Charts and format rules are both APIs that append rather than replace,
      // so a second setup() stacking a duplicate is exactly the shape of bug
      // an idempotency diff exists to catch.
      charts: this.charts.map((c) => [c.type, c.position && c.position.row, ...c.ranges]),
      conditionalFormats: this.conditionalFormatRules.map((r) => [r.formula, ...r.ranges])
    };
  }
}

class FakeSpreadsheet {
  /**
   * `locale` decides what the argument-separator probe returns, which is the
   * only formula this fake evaluates. 'comma' models en-US and friends;
   * 'semicolon' models it-IT, de-DE, fr-FR — where `=SUM(1,1)` reads as the
   * single number 1.1 rather than as two arguments.
   */
  constructor(locale = 'comma') {
    this.locale = locale;
    this.formulaResults = new Map([['=SUM(1,1)', locale === 'semicolon' ? 1.1 : 2]]);
    this.sheets = [new FakeSheet('Sheet1', this)];
    this.toasts = [];
    this.active = this.sheets[0];
  }

  getSheetByName(name) { return this.sheets.find((s) => s.name === name) || null; }
  getSheets() { return this.sheets.slice(); }

  insertSheet(name) {
    if (this.getSheetByName(name)) throw new Error(`sheet exists: ${name}`);
    const sh = new FakeSheet(name, this);
    this.sheets.push(sh);
    return sh;
  }

  deleteSheet(sh) { this.sheets = this.sheets.filter((s) => s !== sh); }
  setActiveSheet(sh) { this.active = sh; return sh; }
  getActiveSheet() { return this.active; }

  moveActiveSheet(pos) {
    this.sheets = this.sheets.filter((s) => s !== this.active);
    this.sheets.splice(pos - 1, 0, this.active);
  }

  toast(message, title, timeout) { this.toasts.push({ message, title, timeout }); }
  getSpreadsheetTimeZone() { return 'Europe/Rome'; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake/edit'; }
  getId() { return 'fake-spreadsheet-id'; }

  /** Ordered snapshot of the whole book — `deepEqual` two of these to prove idempotency. */
  snapshot() { return this.sheets.map((s) => s.snapshot()); }
}

/**
 * An HtmlOutput, chainable, remembering what was set on it.
 *
 * Everything the real one returns is the output itself, so a caller can chain
 * in any order — and a fake that returned a bare object from `setTitle` would
 * make the *order* of those calls load-bearing in tests and nowhere else.
 */
function htmlOutput(html) {
  const out = {
    title: null,
    getContent: () => html,
    setTitle(t) { out.title = t; return out; },
    getTitle: () => out.title,
    setWidth() { return out; },
    setHeight() { return out; }
  };
  return out;
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

export function createGoogleStubs(options = {}) {
  const spreadsheet = options.spreadsheet || new FakeSpreadsheet(options.locale);
  const properties = new Map(Object.entries(options.properties || {}));
  const cache = new Map();
  const sent = [];
  const fetches = [];
  const uiCalls = [];

  const dataValidationBuilder = () => {
    const rule = { type: null, values: null, allowInvalid: true, help: null };
    const builder = {
      requireValueInRange(range, showDropdown) {
        rule.type = 'range'; rule.values = range; rule.showDropdown = showDropdown; return builder;
      },
      requireValueInList(list, showDropdown) {
        rule.type = 'list'; rule.values = list; rule.showDropdown = showDropdown; return builder;
      },
      requireNumberBetween(a, b) { rule.type = 'number'; rule.values = [a, b]; return builder; },
      requireCheckbox() { rule.type = 'checkbox'; return builder; },
      setAllowInvalid(v) { rule.allowInvalid = v; return builder; },
      setHelpText(t) { rule.help = t; return builder; },
      build() { return rule; }
    };
    return builder;
  };

  const sandbox = {
    console,
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Error,
    RegExp,
    isNaN,
    parseFloat,
    parseInt,
    encodeURIComponent,
    decodeURIComponent,

    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getActive: () => spreadsheet,
      getUi: () => ({
        createMenu(title) {
          // Recorded on creation, not on addToUi: a submenu is never added to
          // the UI itself, it is handed to addSubMenu — and a test still has
          // to be able to see what is in it.
          const record = { title, items: [], attached: false, subMenus: [] };
          uiCalls.push(record);
          const menu = {
            addItem(name, fn) { record.items.push({ name, fn }); return menu; },
            addSeparator() { record.items.push({ separator: true }); return menu; },
            addSubMenu(sub) { record.subMenus.push(sub.__title()); return menu; },
            addToUi() { record.attached = true; },
            __title: () => title
          };
          return menu;
        },
        // Real signature: alert(title, prompt, buttons) returns the Button
        // pressed. `alertResponse` decides which, so a test can take either
        // branch of a confirmation without a human.
        alert: (...args) => {
          uiCalls.push({ alert: args[0], body: args.length > 1 ? args[1] : '' });
          return options.alertResponse || 'YES';
        },
        ButtonSet: { OK: 'OK', OK_CANCEL: 'OK_CANCEL', YES_NO: 'YES_NO', YES_NO_CANCEL: 'YES_NO_CANCEL' },
        Button: { OK: 'OK', CANCEL: 'CANCEL', YES: 'YES', NO: 'NO' },
        prompt: (msg) => {
          uiCalls.push({ prompt: msg });
          return { getResponseText: () => (options.promptResponses || {})[msg] || '', getSelectedButton: () => 'OK' };
        }
      }),
      newDataValidation: dataValidationBuilder,
      newConditionalFormatRule: () => new FakeConditionalFormatRuleBuilder(),
      ProtectionType: { RANGE: 'RANGE', SHEET: 'SHEET' },
      flush: () => {}
    },

    /**
     * Only the enum. The builder lives on the sheet, which is where Apps
     * Script puts it too — `Charts` itself contributes nothing but the names,
     * and a fake that invented a chart type would let a typo pass.
     */
    Charts: {
      ChartType: { COLUMN: 'COLUMN', BAR: 'BAR', LINE: 'LINE', PIE: 'PIE', AREA: 'AREA' }
    },

    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (properties.has(k) ? properties.get(k) : null),
        setProperty: (k, v) => { properties.set(k, String(v)); },
        setProperties: (obj) => { Object.entries(obj).forEach(([k, v]) => properties.set(k, String(v))); },
        deleteProperty: (k) => { properties.delete(k); },
        getProperties: () => Object.fromEntries(properties)
      })
    },

    /**
     * The ledger cache, faked no more forgivingly than the real one.
     *
     * Two behaviours are load-bearing and both are refusals. A value over
     * 100KB is **declined, not thrown on** — the real service stores nothing
     * and says nothing, so an oversized chunk is a cache that silently never
     * hits, which reads as "caching made no difference" rather than as a bug.
     * And `getAll` omits keys it does not hold rather than returning null for
     * them, which is what makes a partial expiry look like a shorter ledger to
     * anything that concatenates without checking.
     *
     * `expired()` is the seam the tests need: chunks expire independently in
     * production and there is no other way to reach that case.
     */
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        getAll: (keys) => {
          const out = {};
          keys.forEach((k) => { if (cache.has(k)) out[k] = cache.get(k); });
          return out;
        },
        put: (k, v) => { if (String(v).length <= 100 * 1024) cache.set(k, String(v)); },
        putAll: (obj) => {
          Object.entries(obj).forEach(([k, v]) => {
            if (String(v).length <= 100 * 1024) cache.set(k, String(v));
          });
        },
        remove: (k) => { cache.delete(k); },
        removeAll: (keys) => { keys.forEach((k) => cache.delete(k)); }
      })
    },

    UrlFetchApp: {
      fetch(url, params) {
        fetches.push({ url, params });
        const handler = options.fetch;
        const res = handler ? handler(url, params) : { code: 200, body: '{}' };
        // `bytes` when a test needs a body that is not UTF-8, and the UTF-8
        // encoding of `body` otherwise. Decoded the way the real thing does:
        // an invalid byte becomes U+FFFD rather than an error, and a charset
        // name the runtime does not know throws rather than guessing — a fake
        // that invented an answer for a bad name would pass the typo it exists
        // to catch.
        const bytes = res.bytes ? Buffer.from(res.bytes) : Buffer.from(String(res.body ?? ''), 'utf8');
        return {
          getResponseCode: () => res.code,
          getContent: () => [...bytes].map((b) => (b > 127 ? b - 256 : b)),
          // ISO-8859-1 by hand: `TextDecoder` follows the web platform and
          // quietly reads that label as Windows-1252, where Java reads it as
          // itself. The fake has to be no kinder than the runtime it stands
          // in for, or it hides a wrong charset name behind a right answer.
          getContentText: (charset) => (/^(iso-?8859-1|latin-?1)$/i.test(charset || '')
            ? bytes.toString('latin1')
            : new TextDecoder(charset || 'utf-8').decode(bytes)),
          getHeaders: () => res.headers || {}
        };
      }
    },

    MailApp: {
      sendEmail(...args) { sent.push(args.length === 1 ? args[0] : { to: args[0], subject: args[1], body: args[2] }); },
      getRemainingDailyQuota: () => options.mailQuota ?? 100
    },

    Utilities: {
      computeDigest(_algorithm, value) {
        const hash = crypto.createHash('sha256').update(String(value), 'utf8').digest();
        // Apps Script returns signed bytes.
        return [...hash].map((b) => (b > 127 ? b - 256 : b));
      },
      DigestAlgorithm: { SHA_256: 'SHA_256', MD5: 'MD5' },
      Charset: { UTF_8: 'UTF_8', US_ASCII: 'US_ASCII' },
      computeRsaSha256Signature: (value, key) => {
        const signer = crypto.createSign('RSA-SHA256');
        signer.update(String(value));
        return [...signer.sign(key)].map((b) => (b > 127 ? b - 256 : b));
      },
      base64Encode: (data) => (typeof data === 'string'
        ? Buffer.from(data, 'utf8').toString('base64')
        : Buffer.from(Uint8Array.from(data, (b) => (b < 0 ? b + 256 : b))).toString('base64')),
      base64EncodeWebSafe: (data) => sandbox.Utilities.base64Encode(data)
        .replace(/\+/g, '-').replace(/\//g, '_'),
      base64Decode: (s) => [...Buffer.from(s, 'base64')].map((b) => (b > 127 ? b - 256 : b)),
      getUuid: () => crypto.randomUUID(),
      /**
       * Enough of a Blob for the Drive upload: the bytes, and the name and
       * type that travel with them. Deliberately not indexed by the fake Drive
       * — the *resource* names the file there, as it does in Drive itself.
       */
      newBlob: (content, mime, name) => ({
        getDataAsString: () => String(content),
        getName: () => name,
        getContentType: () => mime
      }),
      sleep: () => {},
      formatDate: (date, _tz, format) => {
        const iso = new Date(date).toISOString();
        if (format === 'yyyy-MM-dd') return iso.slice(0, 10);
        if (format === "yyyy-MM-dd'T'HH:mm:ss") return iso.slice(0, 19);
        return iso;
      }
    },

    Logger: { log: (...a) => (options.verbose ? console.log(...a) : undefined) },

    ScriptApp: {
      newTrigger: (fn) => {
        const t = {
          fn, type: null, hour: null,
          getHandlerFunction: () => fn,
          getUniqueId: () => `trigger-${triggerSeq++}`
        };
        const builder = {
          timeBased: () => ({
            everyDays: (n) => ({ atHour: (h) => ({ create: () => { t.type = `every ${n}d`; t.hour = h; triggers.push(t); return t; } }) }),
            everyWeeks: (n) => ({ onWeekDay: () => ({ atHour: (h) => ({ create: () => { t.type = `every ${n}w`; t.hour = h; triggers.push(t); return t; } }) }) })
          })
        };
        return builder;
      },
      /**
       * The token the Drive REST calls sign with. Real Apps Script mints one
       * carrying exactly the manifest's scopes, which is why the fake Drive
       * below refuses a request that arrives without it — an unsigned call is
       * a 401 there and has to be one here.
       */
      getOAuthToken: () => 'fake-oauth-token',
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' }),
      WeekDay: { SUNDAY: 'SUNDAY', MONDAY: 'MONDAY', SATURDAY: 'SATURDAY' },
      /**
       * Exactly the real enum's four members, and each one an object rather
       * than its name. `requireScheduled_` depends on a string not being equal
       * to the member, which is the whole reason a browser cannot forge a
       * trigger event. A fake whose members were strings would pass
       * `{ authMode: 'FULL' }` straight through.
       */
      AuthMode: Object.freeze(Object.fromEntries(['NONE', 'CUSTOM_FUNCTION', 'LIMITED', 'FULL']
        .map((name) => [name, Object.freeze({ toString: () => name, name: () => name })])))
    },

    Session: {
      getEffectiveUser: () => ({ getEmail: () => options.userEmail || 'you@example.com' }),
      getActiveUser: () => ({ getEmail: () => options.userEmail || 'you@example.com' }),
      // The manifest's `timeZone`, which is what the real one reports.
      getScriptTimeZone: () => 'Europe/Rome'
    },

    MimeType: { CSV: 'text/csv', PLAIN_TEXT: 'text/plain' },

    /**
     * A real lock, so a test can prove that a second sync is refused rather
     * than allowed to interleave. `options.lockHeld` starts it already taken.
     */
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (lockHeld) return false;
          lockHeld = true;
          return true;
        },
        releaseLock: () => { lockHeld = false; },
        hasLock: () => lockHeld
      })
    },

    /**
     * Every method refuses, because in this project every method does.
     *
     * `DriveApp` is documented against the full `drive` scope — the whole
     * Drive — which `appsscript.json` deliberately does not ask for. The
     * previous fake modelled that for `createFolder` alone and let
     * `createFile` succeed, on the same wrong belief the code held; the
     * snapshot trigger then failed weekly in production with the message
     * below while the suite stayed green. A fake more forgiving than the real
     * thing is the recurring way this project ships broken code, and the
     * cheapest cure is a service that says no to everything, so any new use
     * of it fails here first. The Drive calls that *are* permitted go over
     * REST — see `driveApiResponse`.
     */
    DriveApp: new Proxy({}, {
      get: (_target, method) => () => {
        throw new Error('Specified permissions are not sufficient to call ' +
          `DriveApp.${String(method)}. Required permissions: ` +
          'https://www.googleapis.com/auth/drive');
      }
    }),

    /**
     * The dialogs' one call. Nothing here serves a file or a template, so the
     * fake offers neither — a caller that reached for one would be reaching
     * for a method this project no longer has a use for, and should fail.
     */
    HtmlService: {
      createHtmlOutput: (html) => htmlOutput(html)
    },

    /**
     * `MimeType` has exactly the real enum's members, and `setMimeType`
     * refuses anything else — a misspelt member is `undefined` in production,
     * and a fake that accepted it would pass the one call a fake of an enum
     * exists to catch.
     */
    ContentService: (() => {
      const MimeType = Object.freeze({
        ATOM: 'ATOM', CSV: 'CSV', ICAL: 'ICAL', JAVASCRIPT: 'JAVASCRIPT', JSON: 'JSON',
        RSS: 'RSS', TEXT: 'TEXT', VCARD: 'VCARD', XML: 'XML'
      });
      return {
        MimeType,
        createTextOutput(content = '') {
          let text = String(content);
          let mime = MimeType.TEXT;
          const out = {
            getContent: () => text,
            setContent(c) { text = String(c); return out; },
            append(c) { text += String(c); return out; },
            getMimeType: () => mime,
            setMimeType(m) {
              if (!Object.values(MimeType).includes(m)) {
                throw new Error(`Invalid argument: ${m}`);
              }
              mime = m;
              return out;
            }
          };
          return out;
        }
      };
    })()
  };

  let triggers = [];
  let lockHeld = Boolean(options.lockHeld);
  let triggerSeq = 1;
  const folders = [];
  /** What Drive still holds — a delete removes from here, as it does there. */
  const driveFiles = [];
  /**
   * Every file ever uploaded, deleted or not. `checkSnapshotPermitted_` writes
   * one and removes it, so `driveFiles` alone cannot say whether it wrote
   * anything at all, and "wrote nothing" is the failure worth catching.
   */
  const driveWrites = [];

  /**
   * The Drive **advanced service**, for the four calls this project makes:
   * create a folder, create a file with its content, read one file's metadata
   * by id, delete one.
   *
   * It is an advanced service rather than `UrlFetchApp` against the same REST
   * endpoints because declaring it in `appsscript.json` is what gets the Drive
   * API switched on in a *default* Cloud project — which is a separate gate
   * from the OAuth scope, fails with a message that reads like a permissions
   * error, and cannot be opened from the Cloud console, since a default
   * project is one the console will not show you.
   *
   * Drive v3 only, and named as v3 names things: `create` and `remove`, not
   * v2's `insert` and `delete`. A fake answering to both would let a script
   * declaring `"version": "v3"` call v2 methods and pass — and the failure in
   * production is a TypeError inside the weekly trigger, which is where this
   * project has already learned it cannot afford to find things out.
   *
   * `options.refuseDriveFolders` throws the way the advanced service throws:
   * an exception, not a status code. That is the one behavioural difference
   * from the REST transport this replaced, and the code above has to catch
   * rather than inspect.
   */
  const Drive = {
    Files: {
      create(resource, blob) {
        if (resource.mimeType === 'application/vnd.google-apps.folder') {
          if (options.refuseDriveFolders) {
            throw new Error('GoogleJsonResponseException: API call to ' +
              'drive.files.create failed with error: Insufficient Permission');
          }
          const folder = { ...resource, id: `folder-${folders.length + 1}`, trashed: false };
          folders.push(folder);
          return { id: folder.id, name: folder.name };
        }

        if (!blob) throw new Error('A file needs content; pass a blob as the second argument.');

        const file = {
          id: `file-${driveFiles.length + 1}`,
          name: resource.name,
          content: blob.getDataAsString(),
          mime: resource.mimeType,
          parent: (resource.parents || [])[0] || null
        };
        driveFiles.push(file);
        driveWrites.push(file);
        return { id: file.id, name: file.name };
      },

      get(id, optionalArgs) {
        const found = folders.filter((f) => f.id === id)[0] ||
          driveFiles.filter((f) => f.id === id)[0];
        if (!found) throw new Error(`GoogleJsonResponseException: File not found: ${id}`);

        // `trashed` is not in Drive v3's default response — a caller that does
        // not ask for the field reads `undefined` and concludes the folder is
        // fine, for ever, which is precisely the bug worth failing on.
        const fields = String((optionalArgs && optionalArgs.fields) || 'id,name,mimeType').split(',');
        const out = { id: found.id, name: found.name };
        if (fields.includes('trashed')) out.trashed = found.trashed;
        return out;
      },

      remove(id) {
        const index = driveFiles.findIndex((f) => f.id === id);
        if (index === -1) throw new Error(`GoogleJsonResponseException: File not found: ${id}`);
        driveFiles.splice(index, 1);
        return {};
      }
    }
  };

  sandbox.Drive = Drive;

  // Handles for assertions.
  sandbox.__spreadsheet = spreadsheet;
  // The cache's own store, so a test can watch what was written and expire a
  // chunk by hand — independent expiry has no other seam.
  sandbox.__cache = cache;
  sandbox.__properties = properties;
  sandbox.__sentMail = sent;
  sandbox.__fetches = fetches;
  sandbox.__ui = uiCalls;
  sandbox.__triggers = () => triggers;
  sandbox.__driveFiles = driveFiles;
  sandbox.__driveWrites = driveWrites;
  sandbox.__driveFolders = folders;
  /** Take or release the script lock from a test, after the sheet is built. */
  sandbox.__setLockHeld = (held) => { lockHeld = held; };
  /** `getValues` calls since the last reset, per tab — see `readCounts`. */
  sandbox.__reads = (tab) => (tab === undefined
    ? [...readCounts.values()].reduce((a, b) => a + b, 0)
    : readCounts.get(tab) || 0);
  sandbox.__resetReads = () => readCounts.clear();

  return sandbox;
}

export { FakeSpreadsheet, FakeSheet };
