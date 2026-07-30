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

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet._get(this.row + r, this.col + c));
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

  setFormula(f) {
    this.sheet.formulas.set(`${this.row},${this.col}`, f);
    return this;
  }

  getFormula() { return this.sheet.formulas.get(`${this.row},${this.col}`) || ''; }

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
    this.protections = [];
    this.frozenRows = 0;
    this.hidden = false;
    this.maxRows = DEFAULT_ROWS;
    this.maxColumns = DEFAULT_COLS;
    this.calls = [];
  }

  record(kind, detail) { this.calls.push({ kind, ...detail }); }
  _key(r, c) { return `${r},${c}`; }
  _get(r, c) { const v = this.cells.get(this._key(r, c)); return v === undefined ? '' : v; }
  _set(r, c, v) {
    if (v === '' || v === null || v === undefined) this.cells.delete(this._key(r, c));
    else this.cells.set(this._key(r, c), v);
  }

  getName() { return this.name; }
  setName(n) { this.name = n; return this; }

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

  setFrozenRows(n) { this.frozenRows = n; return this; }
  getFrozenRows() { return this.frozenRows; }
  hideSheet() { this.hidden = true; return this; }
  showSheet() { this.hidden = false; return this; }
  isSheetHidden() { return this.hidden; }
  clear() { this.cells.clear(); this.formulas.clear(); return this; }
  getProtections() { return this.protections.slice(); }

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
      protections: this.protections.map((p) => [p.getDescription(), p.isWarningOnly()]).sort()
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
  getId() { return 'fake-spreadsheet-id'; }

  /** Ordered snapshot of the whole book — `deepEqual` two of these to prove idempotency. */
  snapshot() { return this.sheets.map((s) => s.snapshot()); }
}

// ---------------------------------------------------------------------------
// The sandbox
// ---------------------------------------------------------------------------

export function createGoogleStubs(options = {}) {
  const spreadsheet = options.spreadsheet || new FakeSpreadsheet(options.locale);
  const properties = new Map(Object.entries(options.properties || {}));
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
          const items = [];
          const menu = {
            addItem(name, fn) { items.push({ name, fn }); return menu; },
            addSeparator() { return menu; },
            addSubMenu() { return menu; },
            addToUi() { uiCalls.push({ title, items }); }
          };
          return menu;
        },
        alert: (msg) => uiCalls.push({ alert: msg }),
        prompt: (msg) => {
          uiCalls.push({ prompt: msg });
          return { getResponseText: () => (options.promptResponses || {})[msg] || '', getSelectedButton: () => 'OK' };
        }
      }),
      newDataValidation: dataValidationBuilder,
      ProtectionType: { RANGE: 'RANGE', SHEET: 'SHEET' },
      flush: () => {}
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

    UrlFetchApp: {
      fetch(url, params) {
        fetches.push({ url, params });
        const handler = options.fetch;
        const res = handler ? handler(url, params) : { code: 200, body: '{}' };
        return {
          getResponseCode: () => res.code,
          getContentText: () => res.body,
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
        const t = { fn, type: null, at: null };
        const builder = {
          timeBased: () => ({
            everyDays: (n) => ({ atHour: (h) => ({ create: () => { t.type = `every ${n}d @${h}`; triggers.push(t); return t; } }) }),
            everyWeeks: (n) => ({ onWeekDay: () => ({ atHour: (h) => ({ create: () => { t.type = `every ${n}w @${h}`; triggers.push(t); return t; } }) }) })
          })
        };
        return builder;
      },
      getProjectTriggers: () => triggers.slice(),
      deleteTrigger: (t) => { triggers = triggers.filter((x) => x !== t); },
      getService: () => ({ getUrl: () => 'https://script.google.com/macros/s/FAKE/exec' })
    },

    DriveApp: {
      getFoldersByName: () => ({ hasNext: () => false, next: () => null }),
      createFolder: (name) => ({ getName: () => name, createFile: () => ({}) })
    },

    HtmlService: {
      createHtmlOutput: (html) => ({ getContent: () => html, setTitle: () => ({ getContent: () => html }) })
    }
  };

  let triggers = [];

  // Handles for assertions.
  sandbox.__spreadsheet = spreadsheet;
  sandbox.__properties = properties;
  sandbox.__sentMail = sent;
  sandbox.__fetches = fetches;
  sandbox.__ui = uiCalls;
  sandbox.__triggers = () => triggers;

  return sandbox;
}

export { FakeSpreadsheet, FakeSheet };
