/**
 * The port agrees with the original, payload for payload.
 *
 * `web/src/domain/` is `21_query.gs`, `23_api.gs`'s own logic, `runChecks_`
 * and `normalizeMerchant`, rewritten in TypeScript to run on the phone. A
 * rewrite that is *nearly* the same is the dangerous kind — a total a cent off
 * is a total nobody believes again — so this does not test the port against
 * expectations written by hand. It holds it to the original's own answers.
 *
 * Two kinds of original, because only some of it is still here:
 *
 *   - **The payloads are recorded.** `21_query.gs` and `23_api.gs` served the
 *     Apps Script viewer and went with it. While both implementations existed,
 *     this test asked each of them over the same book at the same instants and
 *     required them to agree to the last field; what the `.gs` answered then is
 *     `tests/parity/*.json`. The recording *is* the old viewer's answer, so
 *     updating one to match a change in the port is a decision that the old
 *     viewer was wrong, never a chore — say which field and why in the commit.
 *   - **The rest is asked live.** `runChecks_`, `normalizeMerchant` and the
 *     schema in `00_config.gs` are still what the book runs on, so the port is
 *     compared against them every run, and a change to either side shows here.
 *
 * The book is `tests/book.mjs` — the one the viewer's browser tests draw —
 * read back **the way the Sheets API sends it**: through the Worker's own
 * `READ_RANGES`, dates as serials, trailing empty cells and rows dropped.
 *
 * Three fences:
 *
 *   - **`TZ` is pinned to the book's zone.** The harness uses the host's zone,
 *     and the port uses the book's; in CI's UTC they would disagree on every
 *     row booked before 01:00 or 02:00 Rome time, and on which days exist.
 *   - **The clock is pinned**, at instants chosen to be awkward: just after the
 *     spring clock change, half an hour into a new year, late on a Saturday,
 *     and on the 31st of a month that follows a 30-day one.
 *   - **`book.mjs` is imported under a pinned clock too.** It dates its
 *     accounts and consents when it is loaded, so a recording made against a
 *     book imported today would disagree with the same book imported tomorrow.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { READ_RANGES } from '../web/worker/router.ts';
import { asBatchGet, width } from './batch.mjs';
import { bookFromBatch } from '../web/src/domain/book.ts';
import { clockAt } from '../web/src/domain/days.ts';
import { appHealth } from '../web/src/domain/health.ts';
import { normalizeMerchant } from '../web/src/domain/merchant.ts';
import {
  appAnalyticsData, appDashboardData, appDefaultFilters, appOpenData, appOverviewData, appRecordsData
} from '../web/src/domain/payloads.ts';
import { ledgerOf } from '../web/src/domain/query.ts';
import * as schema from '../web/src/domain/schema.ts';

const ZONE = 'Europe/Rome';
const DAY = 24 * 60 * 60 * 1000;

let zone = process.env.TZ;
process.env.TZ = ZONE;

vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(new Date('2026-09-26T12:00:00+02:00'));
const { previewBook } = await import('./book.mjs');
vi.useRealTimers();

afterAll(() => {
  process.env.TZ = zone;
  vi.useRealTimers();
});

/** What a page receives: the answer after `JSON.stringify`. */
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

  // The consent about to lapse is re-dated against the instant under test.
  const status = c.__spreadsheet.getSheetByName('_status');
  c.writeCell_(status, 3, c.STATUS_COLUMNS, 'valid_until', at(-6));
  c.writeCell_(status, 3, c.STATUS_COLUMNS, 'last_error', 'HTTP 500 from the bank');
  return c;
}

/** The port's answers for one harness book, at the pinned clock. */
function port(c) {
  const book = bookFromBatch(asBatchGet(c), ZONE);
  const ledger = ledgerOf(book);
  const clock = clockAt(new Date(), ZONE);
  return {
    book, ledger, clock,
    appOpen: () => appOpenData(book, clock),
    appOverview: () => appOverviewData(book, ledger, clock),
    appDashboard: () => appDashboardData(book, ledger, clock),
    appRecords: (filters, offset) => appRecordsData(book, ledger, filters, offset, clock),
    appAnalytics: (filters) => appAnalyticsData(book, ledger, filters, clock)
  };
}

/** `runChecks_` as the payload carries it — what `appHealth` is the port of. */
function gsHealth(c) {
  return c.runChecks_(new Date()).map((alert) => ({
    kind: String(alert.kind || ''),
    subject: String(alert.subject || ''),
    detail: String(alert.detail || '')
  }));
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
  ['just after the spring clock change', '2026-03-31T10:00:00+02:00', 'spring'],
  ['half an hour into a new year', '2026-01-01T00:30:00+01:00', 'new-year'],
  ['late on a Saturday', '2026-09-26T23:30:00+02:00', 'saturday'],
  ['the 31st, after a 30-day month', '2026-10-31T12:00:00+01:00', 'thirty-first']
];

/**
 * The recording's text: one payload to a line, under its name.
 *
 * Compact because a recording is read by the comparison and not by people —
 * pretty-printed, four of them were fifty thousand lines of diff for one file
 * of evidence each. One *line* per payload rather than one line per file, so a
 * disagreement still names which payload moved when the file changes.
 */
function recording(answers) {
  const line = (value) => JSON.stringify(value);
  const group = (named) => '{\n' + Object.entries(named)
    .map(([name, value]) => '  ' + line(name) + ': ' + line(value)).join(',\n') + '\n }';
  return '{\n' + Object.entries(answers)
    .map(([name, value]) => ' ' + line(name) + ': ' +
      (name === 'appRecords' || name === 'appAnalytics' ? group(value) : line(value)))
    .join(',\n') + '\n}\n';
}

/** Every payload the old viewer answered for the sick book at one instant, keyed as the recording is. */
function everyPayload(ts) {
  const out = {
    appOpen: ts.appOpen(),
    appOverview: ts.appOverview(),
    appDashboard: ts.appDashboard(),
    appRecords: {},
    appAnalytics: {}
  };
  for (const [name, filters] of RECORD_FILTERS) out.appRecords[name] = [0, 3].map((offset) => ts.appRecords(filters, offset));
  for (const [name, filters] of ANALYTICS_FILTERS) out.appAnalytics[name] = ts.appAnalytics(filters);
  return wire(out);
}

describe.each(INSTANTS)('the old viewer\'s answers %s', (_label, instant, file) => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
  });
  afterAll(() => vi.useRealTimers());

  it('every payload, field for field', async () => {
    const answers = everyPayload(port(sickBook()));
    await expect(recording(answers))
      .toMatchFileSnapshot(fileURLToPath(new URL(`./parity/${file}.json`, import.meta.url)));
  });

  it('the health strip, against the checks the book still runs', () => {
    const c = sickBook();
    const ts = port(c);
    expect(wire(appHealth(ts.book, ts.clock, ts.ledger.length))).toEqual(wire(gsHealth(c)));
  });

  it('actually exercised every detector, so the health comparison means something', () => {
    const kinds = port(sickBook()).appOverview().health.map((alert) => alert.kind);
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
    const ts = port(c);
    return { gs: wire(gsHealth(c)), ts: wire(appHealth(ts.book, ts.clock, ts.ledger.length)) };
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
    'MERCHANT_LETTER_FOLDS', 'MERCHANT_KEY_MAX_TOKENS'
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
