/**
 * book.mjs — a plausible book, built by the code that would have built it.
 *
 * Every payload the preview hands the page comes from calling the real
 * `appOpen`, `appOverview`, `appRecords`, `appAnalytics` and `appDashboard`
 * against this, so the shapes are the server's rather than a fixture's. That is
 * the whole point of doing it this way: a column added to `recordForPage_`
 * arrives in the browser preview on the next run without anyone remembering,
 * and a fixture would have gone on describing the old shape while looking
 * perfectly healthy.
 *
 * The data is invented but not arbitrary. It carries one of each thing the page
 * draws differently — a transfer with both legs present, a €0.00
 * pre-authorisation, a row with labels, an unconfirmed row, a hold, a foreign
 * currency row with no rate, a cash account and an asset account. Those are the
 * cases where the page has been wrong before, and a preview full of ordinary
 * expenses would show none of them.
 */

import { load } from './harness.mjs';

const OWNER = 'owner@example.com';

/** Days before today, so the preview is always inside the default window. */
function daysAgo(n) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - n);
  return date;
}

/*
  `balance` (column J) is an ARRAYFORMULA over the three kinds and `days_left`
  on `_status` is another, so both are stated rather than derived — the same
  concession the transaction rows below make for `amount_base`. Without them the
  preview draws an em dash against every account, a net worth of zero, and
  "reconnect — no consent" on the two banks, all of which look like page bugs
  and are the harness declining to be a spreadsheet.
*/
const ACCOUNTS = [
  { account_id: 'acc-1', name: 'Revolut', kind: 'bank', provider: 'Revolut',
    iban_masked: '•••• 4021', currency: 'EUR', opening_balance: 0,
    balance_api: 2412.87, balance: 2412.87,
    balance_type: 'CLBD', balance_updated_at: daysAgo(0),
    include_in_net_worth: true, active: true, connection_id: 'conn-1' },
  { account_id: 'acc-2', name: 'Fineco', kind: 'bank', provider: 'Fineco',
    iban_masked: '•••• 8873', currency: 'EUR', opening_balance: 0,
    balance_api: 8140.02, balance: 8140.02,
    balance_type: 'CLBD', balance_updated_at: daysAgo(1),
    include_in_net_worth: true, active: true, connection_id: 'conn-2' },
  { account_id: 'w-1', name: 'Wallet', kind: 'cash', currency: 'EUR',
    opening_balance: 60, balance: 180, balance_updated_at: daysAgo(10),
    include_in_net_worth: true, active: true },
  { account_id: 'a-1', name: 'Degiro', kind: 'asset', currency: 'EUR',
    balance_manual: 31500, balance: 31500, balance_updated_at: daysAgo(3),
    include_in_net_worth: true, active: true }
];

/** One healthy consent per bank, so the tiles are not all asking to reconnect. */
const CONNECTIONS = [
  { connection_id: 'conn-1', provider: 'Revolut', session_id: 'sess-1',
    state: 'AUTHORIZED', valid_until: daysAgo(-64), days_left: 64,
    last_success: daysAgo(0), accounts_covered: 1 },
  { connection_id: 'conn-2', provider: 'Fineco', session_id: 'sess-2',
    state: 'AUTHORIZED', valid_until: daysAgo(-6), days_left: 6,
    last_success: daysAgo(1), accounts_covered: 1 }
];

/*
  `amount_base` and the category columns are formulas on a real book and the
  harness evaluates none, so each row states what the sheet would have derived.
  That is a copy of the sheet's arithmetic and it is confined to this file — the
  moment a preview number looks wrong, this is the list to check against
  `04_setup.gs` rather than a bug in the page.
*/
const ROWS = [
  { uid: 'r-1', account: 'Revolut', at: 1, amount: -42.5,
    description: 'COOP SUPERMERCATO VIA ROMA', category: 'Food & Drink',
    subcategory: 'Groceries', type: 'expense', confirmed: true },
  { uid: 'r-2', account: 'Revolut', at: 1, amount: -8.4,
    description: 'BAR CENTRALE', category: 'Food & Drink',
    subcategory: 'Bars & Cafes', type: 'expense', confirmed: true },
  { uid: 'r-3', account: 'Fineco', at: 2, amount: -212,
    description: 'RYANAIR DUBLIN', category: 'Entertainment',
    subcategory: 'Flights', type: 'expense', labels: 'travel', confirmed: true },
  { uid: 'r-4', account: 'Fineco', at: 2, amount: -96.3,
    description: 'HOTEL BOLOGNA', category: 'Entertainment',
    subcategory: 'Accommodation', type: 'expense', labels: 'travel, kids',
    confirmed: true },
  // Unconfirmed, so the review queue and the "needs review" filter have a row.
  { uid: 'r-5', account: 'Revolut', at: 3, amount: -19.99,
    description: 'ADDEBITO UNIPOLMOVE - N 555012345/2026',
    category: 'Transport', subcategory: 'Tolls & Parking', type: 'expense' },
  { uid: 'r-6', account: 'Revolut', at: 4, amount: -63.1,
    description: 'ESSELUNGA SPA TORINO', category: 'Food & Drink',
    subcategory: 'Groceries', type: 'expense' },
  // A €0.00 pre-authorisation: a real debit with no sign to read it from.
  { uid: 'r-7', account: 'Revolut', at: 4, amount: 0,
    description: 'Q8 EASY PREAUTORIZZAZIONE', category: 'Transport',
    subcategory: 'Fuel', type: 'expense' },
  { uid: 'r-8', account: 'Fineco', at: 6, amount: 2800,
    description: 'STIPENDIO', category: 'Income', subcategory: 'Salary',
    type: 'income', confirmed: true },
  { uid: 'r-9', account: 'Revolut', at: 7, amount: 24.08,
    description: 'Refund from Amzn Mktp It', category: 'Income',
    subcategory: 'Refund', type: 'income', labels: 'refund', confirmed: true },
  // Both legs of one transfer, so the row can say where the money went and the
  // receiving side can say where it came from.
  { uid: 't-out', account: 'Fineco', at: 8, amount: -500,
    description: 'BONIFICO A REVOLUT', category: 'Transfer',
    subcategory: 'Between accounts', type: 'transfer', inReports: false,
    group: 'tr:t-out', confirmed: true },
  { uid: 't-in', account: 'Revolut', at: 8, amount: 500,
    description: 'BONIFICO DA FINECO', category: 'Transfer',
    subcategory: 'Between accounts', type: 'transfer', inReports: false,
    group: 'tr:t-out', confirmed: true },
  // A withdrawal and the leg this project writes for it.
  { uid: 'w-out', account: 'Revolut', at: 10, amount: -120,
    description: 'PRELIEVO ATM VIA GARIBALDI', category: 'Transfer',
    subcategory: 'Cash withdrawal', type: 'transfer', inReports: false,
    group: 'tr:w-out', confirmed: true },
  { uid: 'w-in', account: 'Wallet', at: 10, amount: 120, source: 'transfer-leg',
    description: 'Transfer from Revolut', category: 'Transfer',
    subcategory: 'Cash withdrawal', type: 'transfer', inReports: false,
    group: 'tr:w-out', confirmed: true },
  // Foreign currency with no rate: `amount_base` is blank, and the row must
  // draw an em dash rather than a zero.
  { uid: 'r-10', account: 'Revolut', at: 12, amount: -45, currency: 'GBP',
    base: '', description: 'PRET A MANGER LONDON', category: 'Food & Drink',
    subcategory: 'Restaurants', type: 'expense' },
  { uid: 'r-11', account: 'Fineco', at: 18, amount: -1150,
    description: 'AFFITTO', category: 'Housing', subcategory: 'Rent',
    type: 'expense', confirmed: true },
  { uid: 'r-12', account: 'Fineco', at: 22, amount: -78.2,
    description: 'ENEL ENERGIA', category: 'Housing', subcategory: 'Electricity',
    type: 'expense', confirmed: true },
  { uid: 'r-13', account: 'Revolut', at: 26, amount: -31.5,
    description: 'FARMACIA SAN MARCO', category: 'Health',
    subcategory: 'Pharmacy', type: 'expense', confirmed: true },
  { uid: 'r-14', account: 'Revolut', at: 34, amount: -14.99,
    description: 'NETFLIX.COM', category: 'Entertainment',
    subcategory: 'Streaming', type: 'expense', confirmed: true },
  { uid: 'r-15', account: 'Fineco', at: 40, amount: -220,
    description: 'DECATHLON', category: 'Shopping', subcategory: 'Clothing',
    type: 'expense', confirmed: true }
];

const HOLDS = [
  { uid: 'p-1', account: 'Revolut', at: 0, amount: -34.9,
    description: 'HOTEL PREAUTH' },
  { uid: 'p-2', account: 'Revolut', at: 0, amount: -12, description: 'UBER TRIP' }
];

/** A loaded sandbox with the book in it, ready to answer any `app*` call. */
export function previewBook() {
  const c = load({ userEmail: OWNER });
  c.setup();

  const ss = c.__spreadsheet;
  c.appendRows_(ss.getSheetByName('accounts'), 1,
    ACCOUNTS.map((a) => c.toRow_(c.ACCOUNT_COLUMNS, a)));
  c.appendRows_(ss.getSheetByName('_status'), 1,
    CONNECTIONS.map((s) => c.toRow_(c.STATUS_COLUMNS, s)));

  const tx = ss.getSheetByName('transactions');
  c.appendRows_(tx, 1, ROWS.map((row) => c.toRow_(c.TX_COLUMNS_CODE, {
    uid: row.uid,
    account_id: ACCOUNTS.find((a) => a.name === row.account).account_id,
    account_name: row.account,
    booking_date: daysAgo(row.at),
    amount: row.amount,
    currency: row.currency || 'EUR',
    description: row.description,
    source: row.source || 'enablebanking',
    imported_at: daysAgo(row.at)
  })));

  ROWS.forEach((row, i) => {
    const at = i + 2;
    const put = (name, value) => c.writeCell_(tx, at, c.TX_COLUMNS, name, value);

    put('amount_base', row.base === undefined ? row.amount : row.base);
    put('category', row.category);
    put('subcategory', row.subcategory);
    put('type', row.type);
    put('in_reports', row.inReports === undefined ? true : row.inReports);
    put('category_source', row.confirmed ? 'override' : 'rule');
    if (row.labels) put('labels', row.labels);
    if (row.confirmed) put('confirmed', true);
    if (row.group) put('transfer_group', row.group);
  });

  c.appendRows_(ss.getSheetByName('pending'), 1,
    HOLDS.map((hold) => c.toRow_(c.PENDING_COLUMNS, {
      uid: hold.uid,
      account_id: ACCOUNTS.find((a) => a.name === hold.account).account_id,
      account_name: hold.account,
      booking_date: daysAgo(hold.at),
      amount: hold.amount,
      currency: 'EUR',
      description: hold.description,
      source: 'enablebanking',
      imported_at: daysAgo(hold.at)
    })));

  return c;
}

/**
 * Every answer the page can ask for, keyed by the name it calls.
 *
 * Written by asking the server, one call each, exactly as the browser would.
 * The writes are here too and they are the honest kind — `appConfirm` really
 * confirms the row in the in-memory book, so a preview session behaves like a
 * session rather than like a screenshot.
 */
export function previewAnswers(c = previewBook()) {
  return {
    __boot: c.appInlineBoot_(),
    __view: JSON.stringify(c.webAppView_({})),
    appOpen: c.appOpen(),
    appOverview: c.appOverview(),
    appDashboard: c.appDashboard(),
    appRecords: c.appRecords(c.appDefaultFilters_().records, 0),
    appAnalytics: c.appAnalytics(c.appDefaultFilters_().analytics),
    appConfirm: c.appConfirm([{ uid: 'r-5', confirmed: true }]),
    appMarkTransfer: { linked: false, outside: true,
      message: 'Marked as a transfer out of your tracked accounts.' },
    appAddCash: { added: 1, message: 'Added.' },
    appAddRule: { added: 1, message: 'Rule added. Nothing already in the book moves.' }
  };
}
