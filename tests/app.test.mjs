/**
 * The app's own surface: what a page may call, and what it writes.
 *
 * Two things are worth testing hard here, and neither is a happy path.
 *
 * **The gate is on every entry point.** These functions return bank balances
 * and write to the ledger. "You can only reach this if you were served the
 * page" is a claim about a whole system; `requireOwner_` makes it a claim about
 * one line, and this file is what holds every line to it. A new public function
 * that forgets the guard is the realistic security failure, so the last test in
 * the first block finds one by name rather than by memory.
 *
 * **The write rules are a second copy.** `writeReviewRow_` has three of them
 * and `applyReviewDecisions_` reproduces all three against a different input,
 * because the original is `onEdit`-shaped end to end and a page has no `Range`.
 * Two implementations of a rule are two places for it to be wrong, so each one
 * is tested here in the same words it is tested there.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './harness.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** A book with the owner seeded and a few transactions in it. */
function book(rows = [], options = {}) {
  const c = load(Object.assign({ userEmail: 'owner@example.com' }, options));
  c.setup();

  if (rows.length) {
    const tx = c.__spreadsheet.getSheetByName('transactions');
    c.appendRows_(tx, 1, rows.map((r) => c.toRow_(c.TX_COLUMNS_CODE, r)));

    // Derived columns are formulas on a real book, and the harness evaluates
    // none — so the values they would have spilled are written in.
    rows.forEach((r, i) => {
      ['amount_base', 'category', 'subcategory', 'type', 'in_reports', 'labels',
        'confirmed', 'category_source'].forEach((name) => {
        if (r[name] !== undefined) c.writeCell_(tx, i + 2, c.TX_COLUMNS, name, r[name]);
      });
    });
  }
  return c;
}

const tx = (over = {}) => Object.assign({
  uid: 'u-1',
  account_id: 'acc-1',
  account_name: 'Revolut',
  booking_date: new Date(2026, 6, 15),
  amount: 12.5,
  currency: 'EUR',
  description: 'COOP SUPERMERCATO',
  source: 'enablebanking',
  imported_at: new Date(),
  amount_base: -12.5,
  category: 'Food & Drink',
  subcategory: 'Groceries',
  category_source: 'rule',
  type: 'expense',
  in_reports: true
}, over);

/** Every function a page can invoke by name. */
const PUBLIC_API = ['appBootstrap', 'appAnalytics', 'appRecords', 'appDashboard',
  'appConfirm', 'appAddCash'];

describe('the gate on every entry point', () => {
  it('lets the owner past the guard on each one', () => {
    // Not "does not throw" — `appAddCash` refuses an entry with no account,
    // which is a different and correct refusal. What is under test is that
    // the *gate* let the call through.
    const c = book([tx()]);
    PUBLIC_API.forEach((name) => {
      expect(() => c[name]({ period: { kind: 'mtd' } }, 0), name).not.toThrow('Not available');
    });
  });

  it('refuses every one of them to anyone else', () => {
    const c = book([tx()]);
    c.Session.getActiveUser = () => ({ getEmail: () => 'someone@else.com' });

    PUBLIC_API.forEach((name) => {
      expect(() => c[name]([]), name).toThrow('Not available');
    });
  });

  it('refuses them all when nobody is signed in', () => {
    // This is what the anonymous consent-redirect deployment produces.
    const c = book([tx()]);
    c.Session.getActiveUser = () => ({ getEmail: () => '' });

    PUBLIC_API.forEach((name) => {
      expect(() => c[name]([]), name).toThrow('Not available');
    });
  });

  it('has no endpoint that forgot the guard', () => {
    // The realistic security failure is a seventh function added later without
    // `requireOwner_()`. Found by reading the file rather than by remembering:
    // google.script.run can call any global whose name does not end in `_`, so
    // "public" is a property of the name, not of a list someone maintains.
    const api = readFileSync(join(SRC, '23_api.gs'), 'utf8');
    const declared = [...api.matchAll(/^function\s+([A-Za-z0-9]+)\s*\(/gm)]
      .map((m) => m[1])
      .filter((name) => !name.endsWith('_'));

    expect(declared.sort()).toEqual(PUBLIC_API.slice().sort());

    declared.forEach((name) => {
      const body = api.slice(api.indexOf(`function ${name}(`));
      expect(body.slice(0, body.indexOf('\n}')), name).toContain('requireOwner_()');
    });
  });

  it('keeps the implementations private, so the gate cannot be walked around', () => {
    // 21 and 22 hold the work, and every function in them ends in `_` — which
    // Apps Script enforces as unreachable from google.script.run. That is what
    // makes 23 the only way in rather than the intended way in. A missing
    // underscore in 21 or 22 is an endpoint with no gate on it at all.
    //
    // `describeQueryCost` is the one exception and is a menu item, listed in
    // DIAGNOSTIC_ITEMS: it reports a row count and two timings to somebody who
    // already has edit access to the Sheet.
    const ALLOWED = { '21_query.gs': ['describeQueryCost'], '22_actions.gs': [],
      '20_webapp.gs': [] };

    Object.keys(ALLOWED).forEach((file) => {
      const text = readFileSync(join(SRC, file), 'utf8');
      const exposed = [...text.matchAll(/^function\s+([A-Za-z0-9]+)\s*\(/gm)]
        .map((m) => m[1])
        .filter((name) => !name.endsWith('_'));

      expect(exposed, file).toEqual(ALLOWED[file]);
    });
  });
});

describe('confirming from the app', () => {
  const uidRow = (c, uid) => c.readRecords_(
    c.__spreadsheet.getSheetByName('transactions'), c.TX_COLUMNS, 1)
    .find((r) => r.uid === uid);

  it('finds the transaction by uid rather than by position', () => {
    // A list on a phone re-sorts as you act on it, so a position is not a
    // thing that can be sent back — the same reason `review` carries a uid.
    const c = book([
      tx({ uid: 'u-old', booking_date: new Date(2026, 3, 1) }),
      tx({ uid: 'u-new', booking_date: new Date(2026, 6, 1) })
    ]);

    c.appConfirm([{ uid: 'u-new', confirmed: true }]);

    expect(uidRow(c, 'u-new').confirmed).toBe(true);
    expect(uidRow(c, 'u-old').confirmed).toBe('');
  });

  it('does not treat a blank override as an instruction to clear one', () => {
    // Sending `category_override: ''` means "I did not touch this". Clearing a
    // category you typed, because a form serialised an empty input, is the
    // shape of data loss that is discovered months later.
    const c = book([tx({ uid: 'u-1' })]);
    const sheet = c.__spreadsheet.getSheetByName('transactions');
    c.writeCell_(sheet, 2, c.TX_COLUMNS, 'category_override', 'Housing');

    c.appConfirm([{ uid: 'u-1', confirmed: true, category_override: '',
      subcategory_override: '' }]);

    expect(uidRow(c, 'u-1').category_override).toBe('Housing');
  });

  it('writes confirmed only when it was supplied', () => {
    // Writing it every time means correcting a category on a row you had
    // already ticked sends `false` back and quietly un-confirms it.
    const c = book([tx({ uid: 'u-1' })]);
    c.appConfirm([{ uid: 'u-1', confirmed: true }]);
    c.appConfirm([{ uid: 'u-1', subcategory_override: 'Restaurants' }]);

    expect(uidRow(c, 'u-1').confirmed).toBe(true);
    expect(uidRow(c, 'u-1').subcategory_override).toBe('Restaurants');
  });

  it('un-ticks when you send false, since that is a value someone chose', () => {
    const c = book([tx({ uid: 'u-1' })]);
    c.appConfirm([{ uid: 'u-1', confirmed: true }]);
    c.appConfirm([{ uid: 'u-1', confirmed: false }]);

    expect(uidRow(c, 'u-1').confirmed).toBe(false);
  });

  it('counts an override alone as confirmation, without a tick', () => {
    // Typing the category is a stronger statement than ticking a box next to
    // it — the argument 00_config.gs makes about the `confirmed` column.
    const c = book([tx({ uid: 'u-1' })]);
    c.appConfirm([{ uid: 'u-1', subcategory_override: 'Restaurants' }]);

    expect(c.isConfirmedRow_(uidRow(c, 'u-1'))).toBe(false);
    c.appConfirm([{ uid: 'u-1', category_override: 'Food & Drink' }]);
    expect(c.isConfirmedRow_(uidRow(c, 'u-1'))).toBe(true);
  });

  it('says which uid it could not find rather than failing the batch', () => {
    const c = book([tx({ uid: 'u-1' })]);
    const result = c.appConfirm([
      { uid: 'u-1', confirmed: true },
      { uid: 'gone', confirmed: true }
    ]);

    expect(result).toMatchObject({ written: 1, skipped: 1 });
    expect(result.results[1]).toMatchObject({ uid: 'gone', ok: false });
    expect(result.results[1].reason).toContain('transactions');
  });

  it('refuses to confirm more rows than an accident could plausibly be', () => {
    // The same argument as MAX_REVIEW_WRITE, and a separate constant because a
    // request is the one that can be repeated.
    const c = book([tx({ uid: 'u-1' })]);
    const many = [];
    for (let i = 0; i < 150; i++) many.push({ uid: 'u-1', confirmed: true });

    expect(c.appConfirm(many).capped).toBe(true);
    expect(c.MAX_APP_DECISIONS).toBe(100);
  });

  it('writes nothing outside the three columns that are yours', () => {
    // Column ownership is a convention the code has to honour: the protections
    // setup() applies are warning-only and do not block a script write at all.
    const c = book([tx({ uid: 'u-1' })]);
    const sheet = c.__spreadsheet.getSheetByName('transactions');
    const before = sheet.getRange(2, 1, 1, c.TX_COLUMNS_CODE.length).getValues()[0];

    c.appConfirm([{ uid: 'u-1', confirmed: true, subcategory_override: 'Restaurants' }]);

    expect(sheet.getRange(2, 1, 1, c.TX_COLUMNS_CODE.length).getValues()[0]).toEqual(before);
  });

  it('does nothing at all when handed nothing', () => {
    const c = book([tx({ uid: 'u-1' })]);
    expect(c.appConfirm([])).toMatchObject({ written: 0, skipped: 0 });
    expect(c.appConfirm(null)).toMatchObject({ written: 0 });
  });
});

describe('adding cash from the app', () => {
  const cashBook = () => {
    const c = book([]);
    const accounts = c.__spreadsheet.getSheetByName('accounts');
    c.appendRows_(accounts, 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'wallet', name: 'Wallet', kind: 'cash',
        currency: 'EUR', active: true, include_in_net_worth: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'bank', name: 'Revolut', kind: 'bank',
        currency: 'EUR', active: true, include_in_net_worth: true })
    ]);
    return c;
  };

  const ledger = (c) => c.readRecords_(
    c.__spreadsheet.getSheetByName('transactions'), c.TX_COLUMNS, 1);

  it('lands the transaction straight away', () => {
    const c = cashBook();
    const result = c.appAddCash({ amount: '3.50', account: 'Wallet',
      category: 'Food & Drink', subcategory: 'Bars & Cafes', note: 'coffee' });

    expect(result.inserted).toBe(1);
    const rows = ledger(c);
    expect(rows).toHaveLength(1);
    expect(rows[0].description).toBe('coffee');
    expect(rows[0].account_name).toBe('Wallet');
  });

  it('reuses the drain whole, so the sign rule is not reimplemented', () => {
    // A bare number is spending; an Income or Transfer category flips it.
    // `cashEntryAmount` owns that, and this path goes through it.
    const c = cashBook();
    c.appAddCash({ amount: '3.50', account: 'Wallet', category: 'Food & Drink' });
    c.appAddCash({ amount: '200', account: 'Wallet', category: 'Income' });

    expect(ledger(c).map((r) => r.amount)).toEqual([-3.5, 200]);
  });

  it('gives every entry a uid, since two identical coffees are two transactions', () => {
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet', note: 'coffee' });
    c.appAddCash({ amount: '3', account: 'Wallet', note: 'coffee' });

    const uids = ledger(c).map((r) => r.uid);
    expect(uids).toHaveLength(2);
    expect(uids[0]).not.toBe(uids[1]);
  });

  it('puts what you picked in the columns the cascade never touches', () => {
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet',
      category: 'Food & Drink', subcategory: 'Bars & Cafes' });

    expect(ledger(c)[0]).toMatchObject({
      category_override: 'Food & Drink', subcategory_override: 'Bars & Cafes'
    });
  });

  it('leaves the tab empty and ready afterwards', () => {
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet' });

    const entry = c.__spreadsheet.getSheetByName('cash_entry');
    const typed = c.readRecords_(entry, c.CASH_ENTRY_COLUMNS, c.ANY_COLUMN)
      .filter((row) => row.account);
    expect(typed).toEqual([]);
  });

  it('does not overwrite a row someone is mid-way through typing', () => {
    // Row 2 is the form row on the Sheets tab and normally holds a lone date.
    // Landing on top of it would take the entry with it.
    const c = cashBook();
    const entry = c.__spreadsheet.getSheetByName('cash_entry');
    c.writeCell_(entry, 2, c.CASH_ENTRY_COLUMNS, 'note', 'half typed');

    c.appAddCash({ amount: '3', account: 'Wallet' });

    expect(c.readCell_(entry, 2, c.CASH_ENTRY_COLUMNS, 'note')).toBe('half typed');
  });

  it('refuses a blank amount rather than booking a zero-euro transaction', () => {
    // Number('') is 0 and isFinite(0) is true, so the obvious guard passes.
    const c = cashBook();
    expect(() => c.appAddCash({ amount: '', account: 'Wallet' })).toThrow('Type an amount');
    expect(() => c.appAddCash({ amount: '0', account: 'Wallet' })).toThrow('not a transaction');
    expect(() => c.appAddCash({ amount: 'lots', account: 'Wallet' })).toThrow('not a number');
    expect(ledger(c)).toEqual([]);
  });

  it('refuses an entry with no account', () => {
    const c = cashBook();
    expect(() => c.appAddCash({ amount: '3' })).toThrow('Pick an account');
  });

  it('offers cash accounts only, since a bank row is one the sync will fetch', () => {
    const c = cashBook();
    expect(c.appBootstrap().lists.cashAccounts).toEqual(['Wallet']);
  });

  it('keeps the entry rather than losing it when a sync holds the lock', () => {
    const c = cashBook();
    c.__setLockHeld(true);

    const result = c.appAddCash({ amount: '3', account: 'Wallet', note: 'coffee' });

    expect(result).toMatchObject({ inserted: 0, queued: true });
    expect(result.message).toContain('next one');

    // Still on the tab, where the nightly sync will drain it.
    const entry = c.__spreadsheet.getSheetByName('cash_entry');
    expect(c.readRecords_(entry, c.CASH_ENTRY_COLUMNS, c.ANY_COLUMN)
      .some((row) => row.note === 'coffee')).toBe(true);
  });

  it('stores a real date, not the string the page sent', () => {
    // `drainCashEntries_` copies this cell straight into booking_date, and a
    // string there sorts and filters as text.
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet', date: '2026-03-09' });

    expect(ledger(c)[0].booking_date).toBeInstanceOf(Date);
  });
});

describe('the dashboard the app draws', () => {
  it('computes its numbers rather than reading them off the dashboard tab', () => {
    // Those coordinates are DASH's business and DASH moves. A page reading
    // cells by address would show a consent expiry where a balance belongs,
    // the next time a block is rearranged.
    const thisMonth = new Date();
    thisMonth.setDate(1);

    const c = book([
      tx({ uid: 'u-1', booking_date: thisMonth, amount_base: -20 }),
      tx({ uid: 'u-2', booking_date: thisMonth, amount_base: -5, category: 'Transport' })
    ]);

    const data = c.appDashboard();
    expect(data.month.byCategory.map((r) => r.name)).toEqual(['Food & Drink', 'Transport']);
    expect(data.currency).toBe('EUR');
  });

  it('runs the six failure detectors rather than a second opinion about them', () => {
    // A phone-shaped reimplementation of "has the sync stopped" is exactly the
    // thing that ends up disagreeing with the original.
    const c = book([]);
    const runs = c.__spreadsheet.getSheetByName('_runs');
    c.appendRows_(runs, 1, [c.toRow_(c.RUN_COLUMNS, {
      run_id: 'r1', started_at: new Date(2020, 0, 1), result: 'OK', accounts_attempted: 1
    })]);

    expect(c.appDashboard().health.some((a) => a.kind === 'never_ran')).toBe(true);
  });

  it('says it could not check rather than failing to load at all', () => {
    const c = book([]);
    c.runChecks_ = () => { throw new Error('a detector exploded'); };

    const health = c.appDashboard().health;
    expect(health[0].kind).toBe('check_failed');
    expect(health[0].detail).toContain('exploded');
  });

  it('reads the backlog live rather than off the review snapshot', () => {
    // `review` is refilled by a run, and a run is the one thing a phone cannot
    // do. Reading it would mean confirming a row on the phone left it sitting
    // there until the nightly sync.
    const c = book([tx({ uid: 'u-1' }), tx({ uid: 'u-2' })]);

    expect(c.appDashboard().review.map((r) => r.uid)).toEqual(['u-1', 'u-2']);
    c.appConfirm([{ uid: 'u-1', confirmed: true }]);
    expect(c.appDashboard().review.map((r) => r.uid)).toEqual(['u-2']);
  });

  it('marks an account whose consent has gone, and leaves a cash tin alone', () => {
    // A cash tin has no consent to expire, and marking it as a problem every
    // day is how a whole column stops being read.
    const c = book([]);
    const accounts = c.__spreadsheet.getSheetByName('accounts');
    c.appendRows_(accounts, 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'b', name: 'Revolut', kind: 'bank',
        currency: 'EUR', balance: 100, active: true, connection_id: 'c-1' }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'w', name: 'Wallet', kind: 'cash',
        currency: 'EUR', balance: 20, active: true })
    ]);

    const status = c.__spreadsheet.getSheetByName('_status');
    c.appendRows_(status, 1, [c.toRow_(c.STATUS_COLUMNS, {
      connection_id: 'c-1', provider: 'Revolut', days_left: -1
    })]);

    const byName = {};
    c.appDashboard().accounts.forEach((account) => { byName[account.name] = account; });

    expect(byName.Revolut).toMatchObject({ severity: 2 });
    expect(byName.Revolut.sync).toContain('expired');
    expect(byName.Wallet).toMatchObject({ severity: 0, sync: '—' });
  });

  it('warns rather than alarms about a balance that has not moved', () => {
    // A weekend, a bank holiday and a quiet current account all produce one.
    const c = book([]);
    const accounts = c.__spreadsheet.getSheetByName('accounts');
    const old = new Date();
    old.setDate(old.getDate() - 30);

    c.appendRows_(accounts, 1, [c.toRow_(c.ACCOUNT_COLUMNS, {
      account_id: 'b', name: 'Revolut', kind: 'bank', currency: 'EUR', balance: 100,
      active: true, connection_id: 'c-1', balance_updated_at: old
    })]);
    c.appendRows_(c.__spreadsheet.getSheetByName('_status'), 1,
      [c.toRow_(c.STATUS_COLUMNS, { connection_id: 'c-1', days_left: 90 })]);

    const account = c.appDashboard().accounts[0];
    expect(account.severity).toBe(1);
    expect(account.sync).toContain('days old');
  });

  it('compares this month against the same point last month', () => {
    // Never against a whole month: a comparison that flatters you on the 3rd
    // and alarms you on the 30th is wrong in a way that feels informative.
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthFirst = new Date(now.getFullYear(), now.getMonth() - 1, 1);

    const c = book([
      tx({ uid: 'u-1', booking_date: thisMonth, amount_base: -10 }),
      tx({ uid: 'u-2', booking_date: lastMonthFirst, amount_base: -40 })
    ]);

    const month = c.appDashboard().month;
    expect(month.expenses).toBe(10);
    expect(month.lastMonthToDate).toBe(40);
  });
});

describe('the bootstrap call', () => {
  it('carries the first screen and the lists, and nothing for the others', () => {
    const c = book([tx()]);
    const boot = c.appBootstrap();

    expect(Object.keys(boot).sort()).toEqual(
      ['currency', 'dashboard', 'generatedAt', 'lists']);
    expect(boot.lists.periods.map((p) => p.kind)).toContain('mtd');
  });

  /**
   * The prefetch is gone on purpose, so its absence is the assertion.
   *
   * `analytics` and `records` used to ride along here, and each of them called
   * `readLedger_` for itself — so opening the app read the whole of
   * `transactions` three times, twice for screens that might never be opened.
   * Putting either key back would restore that silently: the page would simply
   * stop asking, and the only visible symptom would be a slower boot.
   */
  it('does not prefetch the screens that fetch on navigation', () => {
    const boot = book([tx()]).appBootstrap();

    expect(boot.analytics).toBeUndefined();
    expect(boot.records).toBeUndefined();
  });

  it('survives serialisation, because google.script.run has no choice', () => {
    const c = book([tx()]);
    const boot = c.appBootstrap();

    expect(() => JSON.parse(JSON.stringify(boot))).not.toThrow();
    expect(JSON.parse(JSON.stringify(boot)).dashboard.month.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('names a period the same way the reports tab does', () => {
    // "Last month" has to mean the same thing on the phone and on the desktop,
    // and neither can drift into meaning something else.
    const c = book([]);
    const onPhone = c.appBootstrap().lists.periods.map((p) => p.label);
    const onDesktop = c.REPORT_PERIODS.map((p) => p.label);

    onPhone.forEach((label) => {
      if (label === 'Last 12 months') return expect(onDesktop).toContain('Last 12 months');
      expect(onDesktop).toContain(label);
    });
  });

  it('offers a subcategory with the parent it names, since that is one choice', () => {
    const c = book([]);
    const children = c.appBootstrap().lists.categories.children;
    const groceries = children.find((entry) => entry.name === 'Groceries');

    expect(groceries).toMatchObject({ parent: 'Food & Drink' });
    expect(groceries.icon).toBeTruthy();
  });

  it('works on a book with nothing in it at all', () => {
    const c = book([]);
    expect(() => c.appBootstrap()).not.toThrow();
    expect(c.appBootstrap().dashboard.review).toEqual([]);
  });
});

describe('the page itself', () => {
  it('is served to the owner, viewport and all', () => {
    const c = book([]);
    const page = c.doGet({ parameter: {} });

    expect(page.file).toBe('page');
    expect(page.getTitle()).toBe('Spendsheet');
    expect(page.metaTags.find((tag) => tag.name === 'viewport').content)
      .toContain('width=device-width');
  });

  it('refuses to be framed by anyone else', () => {
    // `DEFAULT` sends Apps Script's standard X-Frame-Options header. The only
    // other member is `ALLOWALL`, which removes it — on the one page in this
    // project that renders bank balances, that would be a clickjacking
    // surface. Asserted against the enum rather than against the string, so
    // that a value the enum does not have reads as `undefined` here exactly as
    // it would in production: that is how the first draft passed
    // `XFrameOptionsMode.IFRAME` — a member of `SandboxMode`, not this enum —
    // and shipped a page that would not render at all.
    const c = book([]);
    const page = c.doGet({ parameter: {} });

    expect(page.xFrameOptionsMode).toBe(c.HtmlService.XFrameOptionsMode.DEFAULT);
    expect(page.xFrameOptionsMode).toBeDefined();
    expect(page.xFrameOptionsMode).not.toBe(c.HtmlService.XFrameOptionsMode.ALLOWALL);
  });

  it('calls only functions that exist', () => {
    // The page reaches the server by name, and a name it gets wrong fails at
    // the moment someone taps the thing — with an error a browser writes to a
    // console nobody on a phone can open.
    const c = load();
    const page = readFileSync(join(SRC, 'page.html'), 'utf8');
    const called = [...page.matchAll(/call\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);

    expect(called.length).toBeGreaterThan(0);
    [...new Set(called)].forEach((name) => {
      expect(typeof c[name], name).toBe('function');
    });
  });
});

/**
 * What the dashboard reads, and what it deliberately does not.
 *
 * The screen draws two months and a short review queue, so it reads two months
 * and a short review queue — `ledgerIndex_` says which rows those are from four
 * narrow columns, and only those rows are then read at full width.
 *
 * The property worth guarding is not the saving, it is the correctness the
 * saving must not cost. The obvious cheap version is a tail read: take the last
 * N rows, they are the recent ones. It is wrong twice over. `transactions` is
 * append-only, so row order is *import* order and a backfilling sync or a
 * bulk import puts old dates at the end. And the review queue wants the
 * **oldest** unconfirmed row, which is the one thing the tail cannot hold.
 *
 * So: an unconfirmed row from two years ago, buried at the top of a book with
 * a hundred and twenty rows on top of it, has to come back — and none of the
 * rows in between may leak into this month's total on the way.
 */
describe('what the dashboard reads', () => {
  function bookWithBuriedBacklog() {
    const now = new Date();
    const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const rows = [];

    // Row 2: unconfirmed, and far older than anything else here.
    rows.push(tx({ uid: 'ancient', booking_date: new Date(2024, 0, 15),
      amount_base: -5, confirmed: false, in_reports: true }));

    // Rows 3–122: confirmed, outside both windows. Nothing should read these.
    for (let i = 0; i < 120; i++) {
      rows.push(tx({ uid: 'filler-' + i, booking_date: new Date(2024, 1, 1),
        amount_base: -1, confirmed: true, in_reports: true }));
    }

    // Row 123: this month, which is the only row the month total may contain.
    rows.push(tx({ uid: 'recent', booking_date: thisMonth,
      amount_base: -10, confirmed: true, in_reports: true }));

    return book(rows);
  }

  it('reaches the oldest unconfirmed row, however far it is from this month', () => {
    const review = bookWithBuriedBacklog().appDashboard().review;
    expect(review.map((r) => r.uid)).toContain('ancient');
  });

  /*
    The rows between the queue and the window are read only when they are close
    enough that a second call would cost more — and when they are, they are
    discarded. A passenger that survived into the result would show up here as
    a total larger than the one row that belongs in it.
  */
  it('lets no row it did not select into the month total', () => {
    const month = bookWithBuriedBacklog().appDashboard().month;
    expect(month.expenses).toBe(10);
  });

  it('still answers on a book with nothing in it', () => {
    const dash = book([]).appDashboard();
    expect(dash.month.expenses).toBe(0);
    expect(dash.review).toEqual([]);
  });
});

/**
 * The page, to the extent a file test can reach it.
 *
 * `node:vm` runs `.gs`; everything inside an HTML file is invisible to it, and
 * the script here is an IIFE that exports nothing, so there is no seam to call
 * a function through. Executing it would mean a DOM implementation and a way
 * to reach inside the closure — a dependency and a hole in the encapsulation,
 * both in service of testing *drawing*, which is the one thing deliberately
 * left in the page. That trade is the wrong way round.
 *
 * What is left is real anyway, because the bugs this file has actually shipped
 * were not drawing bugs. They were **contract** bugs: the page reading a key
 * the server stopped sending, or naming a screen that does not exist. Both are
 * visible in the text, and both are silent at runtime — an undefined key
 * renders as an empty screen, not as an error.
 */
describe('the page and the server agree', () => {
  const page = readFileSync(join(SRC, 'page.html'), 'utf8');

  /*
    This is the check that would have caught the change that removed the
    prefetch. `appBootstrap` stopped sending `analytics` and `records`; a page
    still reading `result.records.rows` would have thrown on open, and one
    reading `result.analytics` would have quietly drawn an empty chart.
  */
  it('reads no key from the bootstrap that the bootstrap does not send', () => {
    const from = page.indexOf("call('appBootstrap')");
    const handler = page.slice(from, page.indexOf('}).catch(', from));
    const used = [...handler.matchAll(/result\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);

    expect(used.length).toBeGreaterThan(0);
    const sent = Object.keys(book([tx()]).appBootstrap());
    [...new Set(used)].forEach((key) => expect(sent, key).toContain(key));
  });

  /*
    The tab bar is a filter over the screens now that one of them is reachable
    only from a tile. A typo in either list is a tab that silently vanishes, or
    a tile that navigates to a screen nothing can render.
  */
  it('offers no tab for a screen that does not exist', () => {
    const nav = page.match(/var NAV = \[([^\]]*)\]/)[1];
    const tabs = [...nav.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    const screens = [...page.matchAll(/\{ id: '([a-z]+)',/g)].map((m) => m[1]);

    expect(tabs.length).toBeGreaterThan(0);
    tabs.forEach((id) => expect(screens, id).toContain(id));
  });

  it('keeps every screen reachable, by tab or by name', () => {
    const screens = [...page.matchAll(/\{ id: '([a-z]+)',/g)].map((m) => m[1]);
    const nav = page.match(/var NAV = \[([^\]]*)\]/)[1];

    screens.forEach((id) => {
      const reachable = nav.includes(`'${id}'`) || page.includes(`go('${id}')`);
      expect(reachable, id).toBe(true);
    });
  });
});
