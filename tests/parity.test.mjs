/**
 * The port agrees with the original, payload for payload.
 *
 * `web/src/domain/` is `21_query.gs`, `23_api.gs`'s own logic, `runChecks_`
 * and `normalizeMerchant`, rewritten in TypeScript to run on the phone. A
 * rewrite that is *nearly* the same is the dangerous kind — a total a cent off
 * the old viewer's is a total nobody believes again — so this does not test
 * the port against expectations written by hand. It asks both.
 *
 * The same book (`tests/book.mjs`, the one the preview draws) is answered by
 * the `.gs` in the harness, and then read back **the way the Sheets API sends
 * it** — through the Worker's own `READ_RANGES`, dates as serials, trailing
 * empty cells and rows dropped — and answered by the TypeScript. Every payload
 * is compared whole, after the JSON round trip both sides' answers make on the
 * way to a page.
 *
 * Two fences, both from the plan:
 *
 *   - **`TZ` is pinned to the book's zone.** The harness uses the host's zone,
 *     and the port uses the book's; in CI's UTC they would disagree on every
 *     row booked before 01:00 or 02:00 Rome time, and on which days exist.
 *   - **The clock is pinned too**, at instants chosen to be awkward: just after
 *     the spring clock change, half an hour into a new year, late on a
 *     Saturday, and on the 31st of a month that follows a 30-day one.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { previewBook } from './book.mjs';
import { READ_RANGES } from '../web/worker/router.ts';
import { bookFromBatch } from '../web/src/domain/book.ts';
import { clockAt } from '../web/src/domain/days.ts';
import { normalizeMerchant } from '../web/src/domain/merchant.ts';
import {
  appAnalyticsData, appDashboardData, appDefaultFilters, appOpenData, appOverviewData, appRecordsData
} from '../web/src/domain/payloads.ts';
import { ledgerOf } from '../web/src/domain/query.ts';
import * as schema from '../web/src/domain/schema.ts';

const ZONE = 'Europe/Rome';
const DAY = 24 * 60 * 60 * 1000;

let zone;
beforeAll(() => {
  zone = process.env.TZ;
  process.env.TZ = ZONE;
});
afterAll(() => {
  process.env.TZ = zone;
  vi.useRealTimers();
});

/** The column letters to a width: `AD` → 30. */
function width(range) {
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
function asBatchGet(c) {
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

/** What a page receives: the answer after `JSON.stringify`, as both transports do. */
const wire = (value) => JSON.parse(JSON.stringify(value));

function addRun(c, over) {
  c.appendRows_(c.__spreadsheet.getSheetByName('_runs'), 1, [c.toRow_(c.RUN_COLUMNS, {
    run_id: 'run', trigger: 'scheduled', accounts_attempted: 2, accounts_ok: 2,
    rows_fetched: 0, rows_inserted: 0, rows_duplicate: 0, result: 'OK', ...over
  })]);
}

/**
 * The preview's book, plus what makes every health detector speak: three empty
 * days of runs ending three days ago, a failed run since, and a bank reporting
 * an error. The consent six days out is already in the book.
 */
function sickBook() {
  const c = previewBook();
  const now = new Date();
  const at = (days) => new Date(now.getTime() - days * DAY);
  addRun(c, { started_at: at(5) });
  addRun(c, { started_at: at(4) });
  addRun(c, { started_at: at(3) });
  addRun(c, { started_at: at(1), result: 'FAIL', message: 'boom' });

  // `book.mjs` dates its consents when it is imported, before the clock is
  // pinned, so the one about to lapse is re-dated against the pinned one.
  const status = c.__spreadsheet.getSheetByName('_status');
  c.writeCell_(status, 3, c.STATUS_COLUMNS, 'valid_until', at(-6));
  c.writeCell_(status, 3, c.STATUS_COLUMNS, 'last_error', 'HTTP 500 from the bank');
  return c;
}

/** Both sides' answers for one book, at the pinned clock. */
function answers(c) {
  const book = bookFromBatch(asBatchGet(c), ZONE);
  const ledger = ledgerOf(book);
  const clock = clockAt(new Date(), ZONE);
  return {
    gs: c,
    ts: {
      appOpen: () => appOpenData(book, clock),
      appOverview: () => appOverviewData(book, ledger, clock),
      appDashboard: () => appDashboardData(book, ledger, clock),
      appRecords: (filters, offset) => appRecordsData(book, ledger, filters, offset, clock),
      appAnalytics: (filters) => appAnalyticsData(book, ledger, filters, clock)
    }
  };
}

const RECORD_FILTERS = [
  ['the default', appDefaultFilters().records],
  ['unconfirmed only', { ...appDefaultFilters().records, unconfirmedOnly: true }],
  ['a search', { ...appDefaultFilters().records, search: 'bonifico' }],
  ['a spending drill', { ...appDefaultFilters().records, period: { kind: 'last_12' }, spendOnly: true, category: 'Food & Drink' }],
  ['an income drill', { ...appDefaultFilters().records, period: { kind: 'last_12' }, incomeOnly: true }],
  ['the uncategorised bucket', { ...appDefaultFilters().records, period: { kind: 'last_12' }, category: '(uncategorised)', subcategory: '(uncategorised)' }],
  ['two accounts', { ...appDefaultFilters().records, period: { kind: 'last_12' }, account: ['Revolut', 'Wallet'] }],
  ['a label', { ...appDefaultFilters().records, period: { kind: 'last_12' }, label: 'travel' }],
  ['last month, which ended', { ...appDefaultFilters().records, period: { kind: 'last_month' } }],
  ['a custom range given backwards', { ...appDefaultFilters().records, period: { kind: 'custom', from: '2026-12-31', to: '2025-06-01' } }]
];

const ANALYTICS_FILTERS = [
  ['this month', appDefaultFilters().analytics],
  ['this week', { period: { kind: 'week' }, account: 'All', label: 'All' }],
  ['twelve months, monthly buckets', { period: { kind: 'last_12' }, account: 'All', label: 'All' }],
  ['one account', { period: { kind: 'last_12' }, account: 'Fineco', label: 'All' }],
  ['a label', { period: { kind: 'last_12' }, account: 'All', label: 'travel' }],
  ['a named month', { period: { kind: 'month', year: 2026, month: 2 }, account: 'All', label: 'All' }],
  ['a named year', { period: { kind: 'year', year: 2025 }, account: 'All', label: 'All' }],
  ['a custom range', { period: { kind: 'custom', from: '2026-03-01', to: '2026-04-15' }, account: ['Revolut'], label: 'All' }],
  ['an unknown kind', { period: { kind: 'fortnight' }, account: 'All', label: 'All' }]
];

const INSTANTS = [
  ['just after the spring clock change', '2026-03-31T10:00:00+02:00'],
  ['half an hour into a new year', '2026-01-01T00:30:00+01:00'],
  ['late on a Saturday', '2026-09-26T23:30:00+02:00'],
  ['the 31st, after a 30-day month', '2026-10-31T12:00:00+01:00']
];

describe.each(INSTANTS)('the same answers %s', (_label, instant) => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
  });
  afterAll(() => vi.useRealTimers());

  it.each(['appOpen', 'appOverview', 'appDashboard'])('%s', (name) => {
    const { gs, ts } = answers(sickBook());
    expect(wire(ts[name]())).toEqual(wire(gs[name]()));
  });

  it.each(RECORD_FILTERS)('appRecords for %s', (_name, filters) => {
    const { gs, ts } = answers(sickBook());
    for (const offset of [0, 3]) {
      expect(wire(ts.appRecords(filters, offset))).toEqual(wire(gs.appRecords(filters, offset)));
    }
  });

  it.each(ANALYTICS_FILTERS)('appAnalytics for %s', (_name, filters) => {
    const { gs, ts } = answers(sickBook());
    expect(wire(ts.appAnalytics(filters))).toEqual(wire(gs.appAnalytics(filters)));
  });

  it('actually exercised every detector, so the health comparison means something', () => {
    const { ts } = answers(sickBook());
    const kinds = ts.appOverview().health.map((alert) => alert.kind);
    expect(kinds).toEqual(expect.arrayContaining(['never_ran', 'empty_runs', 'consent', 'account_failing']));
  });
});

describe('the row-loss check, from _monitor rather than script properties', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T12:00:00+02:00'));
  });
  afterAll(() => vi.useRealTimers());

  /** A book whose count has been remembered, then lost `uids`, archiving `archived` of them first. */
  function lost(uids, archived) {
    const c = previewBook();
    c.rememberRowCount_();
    const tx = c.__spreadsheet.getSheetByName('transactions');
    const removed = c.__spreadsheet.getSheetByName('_removed');

    for (const uid of uids) {
      const values = tx.getRange(2, 1, tx.getLastRow() - 1, c.TX_COLUMNS.length).getValues();
      const index = values.findIndex((row) => row[0] === uid);
      if (archived.includes(uid)) c.appendRows_(removed, 1, [values[index]]);
      tx.deleteRows(index + 2, 1);
    }
    return c;
  }

  const health = (c) => {
    const { gs, ts } = answers(c);
    return { gs: wire(gs.appOverview().health), ts: wire(ts.appOverview().health) };
  };

  it('agrees a delete that left its copy is excused', () => {
    const { gs, ts } = health(lost(['c-1'], ['c-1']));
    expect(ts).toEqual(gs);
    expect(ts.map((a) => a.kind)).not.toContain('rows_lost');
  });

  it('agrees a loss with no copy is not, and says how much the archive covers', () => {
    const { gs, ts } = health(lost(['c-1', 'r-15'], ['c-1']));
    expect(ts).toEqual(gs);
    expect(ts.map((a) => a.kind)).toContain('rows_lost');
  });
});

describe('the schema, copied into schema.ts', () => {
  const c = previewBook();
  const copied = (name) => (name === 'DEFAULT_CONFIG'
    ? Object.fromEntries(Object.keys(schema.DEFAULT_CONFIG).map((key) =>
        [key, c.DEFAULT_CONFIG.find((row) => row[0] === key)?.[1]]))
    : name === 'TABS'
      ? Object.fromEntries(Object.keys(schema.TABS).map((key) => [key, c.TABS[key]]))
      : c[name]);

  it.each([
    'TABS', 'TX_COLUMNS_CODE', 'TX_COLUMNS_DERIVED', 'TX_COLUMNS', 'PENDING_COLUMNS',
    'ACCOUNT_COLUMNS', 'CATEGORY_COLUMNS', 'LABEL_COLUMNS', 'STATUS_COLUMNS', 'RUN_COLUMNS',
    'CONFIG_COLUMNS', 'MEMORY_COLUMNS', 'MONITOR_COLUMNS', 'DEFAULT_CONFIG',
    'TX_SOURCE_API', 'TX_SOURCE_CASH', 'CATEGORY_SOURCE', 'TX_TYPE', 'ACCOUNT_KIND',
    'ACCOUNT_KINDS', 'RUN_RESULT', 'ALERT_KIND', 'MERCHANT_NOISE_WORDS',
    'MERCHANT_LETTER_FOLDS', 'MERCHANT_KEY_MAX_TOKENS', 'QUERY_PAGE_SIZE',
    'QUERY_GROUP_LIMIT', 'QUERY_DAILY_MAX_DAYS', 'DASHBOARD_TREND_DAYS'
  ])('%s', (name) => {
    expect(wire(schema[name])).toEqual(wire(copied(name)));
  });

  it('reads every tab at exactly its schema width', () => {
    const widths = {
      transactions: c.TX_COLUMNS, accounts: c.ACCOUNT_COLUMNS, categories: c.CATEGORY_COLUMNS,
      labels: c.LABEL_COLUMNS, pending: c.PENDING_COLUMNS, _status: c.STATUS_COLUMNS,
      _runs: c.RUN_COLUMNS, _config: ['key', 'value'], _memory: c.MEMORY_COLUMNS,
      _monitor: c.MONITOR_COLUMNS, _removed: ['uid']
    };
    expect(Object.keys(READ_RANGES).sort()).toEqual(Object.keys(widths).sort());
    for (const [tab, columns] of Object.entries(widths)) expect([tab, width(READ_RANGES[tab])]).toEqual([tab, columns.length]);
  });
});

describe('normalizeMerchant, which a rule made on the phone has to share with the categoriser', () => {
  const c = previewBook();
  const CASES = [
    ['COOP SUPERMERCATO VIA ROMA', ''],
    ['PAGAMENTO POS 12/03/2026 14:22 ESSELUNGA SPA TORINO CARTA N. *1234', ''],
    ['ADDEBITO UNIPOLMOVE - N 555012345/2026', ''],
    ['Kartenzahlung REMA 1000 KØBENHAVN', ''],
    ['Caffè Città di Castello', ''],
    ['BONIFICO A FAVORE DI', 'IT60X0542811101000000123456'],
    ['whatever', 'Amazon EU S.à r.l.'],
    ['', ''],
    ['Q8 A2A 4534 it60x054', ''],
    ['Straße ŁÓDŹ Œuvre Þing', '']
  ];

  it.each(CASES)('%s / %s', (description, counterparty) => {
    expect(normalizeMerchant(description, counterparty)).toBe(c.normalizeMerchant(description, counterparty));
  });
});
