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
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './harness.mjs';
import { pageSource } from './page.mjs';

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
const PUBLIC_API = ['appOpen', 'appOverview', 'appAnalytics', 'appRecords',
  'appDashboard', 'appConfirm', 'appAddCash', 'appAddRule', 'appMarkTransfer',
  'appDeleteRecord', 'describeDashboardCost'];

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
    // 21 and 22 are held to *no* exceptions, which is the whole strength of
    // the claim: a diagnostic that only reports timings still reads the ledger,
    // and "it just returns numbers" is a judgement about one function rather
    // than a property of the file. Anything worth reaching from a browser goes
    // in 23 behind `requireOwner_()`; anything worth reaching from the menu can
    // live in a file that is not the query layer.
    //
    // `openWebApp` is a menu item and menu items are called by name, so it
    // cannot take the underscore. It returns nothing, and the only thing it
    // reads is a URL it then puts in a dialog — `SpreadsheetApp.getUi()`
    // throws outside a container, so reaching it from a browser gets an error
    // rather than an answer.
    const ALLOWED = { '21_query.gs': [], '22_actions.gs': [],
      '20_webapp.gs': ['openWebApp'] };

    Object.keys(ALLOWED).forEach((file) => {
      const text = readFileSync(join(SRC, file), 'utf8');
      const exposed = [...text.matchAll(/^function\s+([A-Za-z0-9]+)\s*\(/gm)]
        .map((m) => m[1])
        .filter((name) => !name.endsWith('_'));

      expect(exposed, file).toEqual(ALLOWED[file]);
    });
  });
});

describe('the gate on every function the Sheet reaches', () => {
  // `23_api.gs` is not the whole browser-reachable surface, and treating it as
  // one is the hole this block exists to keep shut. `google.script.run` can call
  // *any* global whose name lacks a trailing `_`, and Door 1 — the consent
  // redirect — is served to anyone by necessity, bridge and all. So a stranger
  // who loads that URL can call a menu handler or a diagnostic and it runs with
  // the owner's authority: that is how the ungated `ebGet*` wrappers returned
  // balances and `saveCredentials` overwrote the PEM to an anonymous caller.
  //
  // The rule is derived, not remembered, exactly as the `23_api.gs` block above
  // derives its list by reading the file. The set that must be gated is every
  // function the *menu* names and every function a *dialog* calls back into —
  // read out of `19_menu.gs` and the `google.script.run` calls in `src/*.gs`, so
  // a menu item added later drags its handler into this test whether or not
  // anyone remembered to gate it.

  const gs = readdirSync(SRC).filter((f) => f.endsWith('.gs'));
  const text = Object.fromEntries(gs.map((f) => [f, readFileSync(join(SRC, f), 'utf8')]));

  /** name -> the function body, for every non-`_` global across `src/*.gs`. */
  const bodies = {};
  gs.forEach((f) => {
    const src = text[f];
    for (const m of src.matchAll(/^function\s+([A-Za-z0-9]+)\s*\(/gm)) {
      const name = m[1];
      if (name.endsWith('_')) continue;
      const from = m.index;
      const next = src.indexOf('\nfunction ', from + 1);
      bodies[name] = src.slice(from, next === -1 ? undefined : next);
    }
  });

  const names = (re, src) => [...src.matchAll(re)].map((m) => m[1]);

  /** Every function the menu invokes, by name, out of the menu declaration. */
  const menuFns = names(/\bfn:\s*'([A-Za-z0-9]+)'/g, text['19_menu.gs']);

  /** Every function a dialog hands back to via `google.script.run`. */
  const HANDLERS = new Set(['withSuccessHandler', 'withFailureHandler', 'withUserObject', 'withLogger']);
  const dialogFns = [];
  gs.forEach((f) => {
    if (!text[f].includes('google.script.run')) return;
    for (const m of text[f].matchAll(/\.([A-Za-z][A-Za-z0-9]*)\s*\(/g)) {
      const name = m[1];
      if (HANDLERS.has(name)) continue;
      if (bodies[name] && !dialogFns.includes(name)) dialogFns.push(name);
    }
  });

  // A trigger fires by naming a public function, and a trigger has no UI and no
  // signed-in user — so a UI-or-owner gate on one would break the unattended run
  // this project exists to keep alive. They are excused here deliberately, and
  // stay safe by returning nothing a caller could read (counts, a filename, a
  // health summary — never a balance, a transaction or a credential). Derived
  // from the schedule so a fourth one is excused only once it is really wired.
  const triggerFns = names(/\bfn:\s*'([A-Za-z0-9]+)'/g, text['11_triggers.gs']);

  const mustGate = [...new Set([...menuFns, ...dialogFns])].filter((n) => !triggerFns.includes(n));

  it('names a handler for every menu item and dialog callback', () => {
    // If this is empty the derivation broke and every assertion below is vacuous.
    expect(mustGate.length).toBeGreaterThan(20);
    expect(mustGate).toContain('saveCredentials');   // the dialog callback
    expect(mustGate).toContain('inspectSession');    // a diagnostic
    expect(mustGate).not.toContain('snapshotToDrive'); // menu *and* trigger — excused
  });

  it('gates each of them on its first line', () => {
    mustGate.forEach((name) => {
      const body = bodies[name];
      expect(body, name + ' is named by the menu/a dialog but defined nowhere').toBeTruthy();
      const head = body.slice(0, body.indexOf('\n\n') === -1 ? 200 : body.indexOf('\n\n'));
      expect(
        /requireInteractive_\(\)|requireOwner_\(\)/.test(head),
        name + ' is reachable from the Sheet but does not gate its first line'
      ).toBe(true);
    });
  });

  it('refuses the anonymous page context, and only that one', () => {
    // The three states `requireInteractive_` decides between, told apart by the
    // two things it reads: is there a UI, and who is the active user.
    const c = book();

    // A menu click: a UI context, so it is let through even before an identity
    // is known — which is what keeps `setup()` runnable on a book with no owner.
    c.Session.getActiveUser = () => ({ getEmail: () => '' });
    expect(() => c.requireInteractive_(), 'menu click').not.toThrow();

    // A dialog callback: no UI, but the owner is the active user.
    c.Session.getActiveUser = () => ({ getEmail: () => 'owner@example.com' });
    c.SpreadsheetApp.getUi = () => { throw new Error('no UI in this context'); };
    expect(() => c.requireInteractive_(), 'dialog callback').not.toThrow();

    // An anonymous `google.script.run` from Door 1: no UI, and no owner. The one
    // case that must fail — it is the whole reason this gate exists.
    c.Session.getActiveUser = () => ({ getEmail: () => '' });
    expect(() => c.requireInteractive_(), 'anonymous page call').toThrow('Not available');
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

  /*
    Labels take the `confirmed` rule and not the override rule, and the pair of
    tests below is the whole of the difference. It is the one place this
    function deliberately treats a blank as a value, so it is the one place
    where "which rule does this field follow" has to be asserted rather than
    read off the call site — the two branches are four lines apart and look
    identical at a glance.
  */
  it('clears labels when sent an empty value, unlike an override', () => {
    const c = book([tx({ uid: 'u-1', labels: 'kids, travel' })]);

    c.appConfirm([{ uid: 'u-1', labels: [] }]);
    expect(uidRow(c, 'u-1').labels).toBe('');
  });

  it('leaves labels alone when the key is absent', () => {
    // The other half. Confirming a row from a sheet that has no labels control
    // on it must not be a way to wipe the column.
    const c = book([tx({ uid: 'u-1', labels: 'kids, travel' })]);

    c.appConfirm([{ uid: 'u-1', confirmed: true }]);
    expect(uidRow(c, 'u-1').labels).toBe('kids, travel');
  });

  it('stores labels in the shape splitLabels_ reads back', () => {
    // The round trip is the point: `recordForPage_` sends an array out, the
    // page sends one back, and `matchesFilters_` filters on the parts that
    // `splitLabels_` finds. A value stored in any other shape filters by luck.
    const c = book([tx({ uid: 'u-1' })]);

    c.appConfirm([{ uid: 'u-1', labels: ['travel', 'kids'] }]);
    expect(uidRow(c, 'u-1').labels).toBe('travel, kids');
    expect(c.splitLabels_(uidRow(c, 'u-1').labels)).toEqual(['travel', 'kids']);
  });

  it('drops blanks and duplicates rather than storing a lone comma', () => {
    const c = book([tx({ uid: 'u-1' })]);

    c.appConfirm([{ uid: 'u-1', labels: ['travel', '', ' travel ', null, 'kids'] }]);
    expect(uidRow(c, 'u-1').labels).toBe('travel, kids');
  });

  /*
    A label is an axis over spending, and a transfer is not spending.

    `travel` earns its place by spanning a flight, a hotel and forty euros of
    coffee — things a category cannot group. A transfer is the same money in two
    places, excluded from every total through `in_reports`, so a label on one
    builds a filter that can never match what it was set to find. The page no
    longer offers the chips on that pane; this is the second ask, for the same
    reason `descriptionIsEditable_` is asked twice.
  */
  it('refuses a label on a row that is already a transfer', () => {
    const c = book([tx({ uid: 'u-1', category: 'Transfer',
      subcategory: 'Between accounts', type: 'transfer' })]);

    const result = c.appConfirm([{ uid: 'u-1', confirmed: true, labels: ['travel'] }]);

    expect(uidRow(c, 'u-1').labels).toBe('');
    expect(uidRow(c, 'u-1').confirmed).toBe(true);
    expect(result.results[0]).toMatchObject({ ok: true, refused: ['labels'] });
  });

  it('refuses a label on a row this very decision makes a transfer', () => {
    // The question is about the row *after* the write. Marking something a
    // transfer and labelling it arrive in one request, and reading the current
    // category would let the label through on the way past.
    const c = book([tx({ uid: 'u-1' })]);

    c.appConfirm([{ uid: 'u-1', category_override: 'Transfer', labels: ['travel'] }]);

    expect(uidRow(c, 'u-1').labels).toBe('');
    expect(uidRow(c, 'u-1').category_override).toBe('Transfer');
  });

  it('says so rather than reporting nothing to write, when the label was all there was', () => {
    const c = book([tx({ uid: 'u-1', category: 'Transfer', type: 'transfer' })]);

    const result = c.appConfirm([{ uid: 'u-1', labels: ['travel'] }]);

    expect(result.results[0]).toMatchObject({ ok: false });
    expect(result.results[0].reason).toContain('transfer');
  });

  /*
    The page patches its own copy before this call and has to — a phone that
    waits three seconds to redraw a row you just tapped feels broken. But the
    patch is a guess: `type`, `category`, `subcategory` and `in_reports` are
    formulas, so what a confirmation *means* is only knowable by asking the
    sheet. The guess used to be left standing until something else happened to
    refetch, which on the Records screen could be never.
  */
  it('hands back the row as the sheet now describes it', () => {
    const c = book([tx({ uid: 'u-1' })]);

    const result = c.appConfirm([{ uid: 'u-1', category_override: 'Housing',
      subcategory_override: 'Rent' }]);

    expect(result.results[0].record).toMatchObject({
      uid: 'u-1', confirmed: true, account: 'Revolut', description: 'COOP SUPERMERCATO'
    });
  });

  it('sends no row number back, because a page cannot address one', () => {
    // The uid is the whole of the addressing. `_row` is an address in a sheet
    // the page has never seen and that re-numbers under it.
    const c = book([tx({ uid: 'u-1' })]);

    const entry = c.appConfirm([{ uid: 'u-1', confirmed: true }]).results[0];

    expect(entry._row).toBeUndefined();
    expect(entry.record).toBeTruthy();
  });

  it('hands nothing back for a row it could not write', () => {
    const c = book([tx({ uid: 'u-1' })]);

    const entry = c.appConfirm([{ uid: 'gone', confirmed: true }]).results[0];

    expect(entry.ok).toBe(false);
    expect(entry.record).toBeUndefined();
  });

  /*
    A boolean in the labels column is not a label called "false".

    It reached the phone as a fourth chip beside three real labels, selected,
    on a row nobody had labelled. `isBlankCell_` is the reason and is right to
    be: a cleared checkbox is a real answer and must not read as unanswered. But
    a label column holds no checkboxes, so a boolean there came from somewhere
    else — an import mapping an absent field, a formula returning FALSE rather
    than `""` — and `String(false)` is a perfectly serviceable five-character
    label as far as everything downstream can tell.

    The write is the half that matters. Confirming that row would have stored
    the word, and a stray boolean would have become a real label that the
    `labels` tab counts and totals from then on.
  */
  it('does not read a boolean cell as a label called "false"', () => {
    const c = book();
    expect(c.splitLabels_(false)).toEqual([]);
    expect(c.splitLabels_(true)).toEqual([]);
  });

  it('does not send one to the page as a chip', () => {
    const c = book([tx({ uid: 'u-1', labels: false })]);

    expect(c.appRecords({ period: { kind: 'last_12' } }, 0).rows[0].labels).toEqual([]);
  });

  it('does not write one back when the row is confirmed', () => {
    const c = book([tx({ uid: 'u-1', labels: false })]);

    c.appConfirm([{ uid: 'u-1', confirmed: true, labels: false }]);
    expect(uidRow(c, 'u-1').labels).toBe('');
  });

  /*
    Renaming a transaction, and the one rule that decides whether you may.

    This is the only write in the app that touches A–O — the half of
    `transactions` the code owns. Every other one goes to an override column,
    which exists so that your opinion and the bank's can both be on the row; a
    description has none, so changing it changes the stored value.

    Whether that is safe turns entirely on `computeUid`. With an
    `entry_reference` the identity is the bank's own id. Without one — and
    plenty of banks send none — the uid is a hash that includes the description,
    so rewriting it can stop a *future* sync recognising a transaction the book
    already holds, and append a duplicate days later with nothing pointing back
    at the edit. Hence: a bank's row is the bank's, everything else is yours.

    The refusal is tested from the server rather than through the page, because
    the page deciding not to show a field is a courtesy and this is the rule.
  */
  const withSource = (source) => book([tx({ uid: 'u-1', source })]);

  it('renames a cash row, a transfer leg and an imported one', () => {
    [['manual', 'Coffee with Ana'], ['transfer-leg', 'Cash for the weekend'],
      ['csv:budgetbakers', 'IKEA — kitchen']].forEach(([source, name]) => {
      const c = withSource(source);

      c.appConfirm([{ uid: 'u-1', confirmed: true, description: name }]);
      expect(uidRow(c, 'u-1').description, source).toBe(name);
    });
  });

  it('refuses to rename a synced row, and says why', () => {
    const c = withSource('enablebanking');
    const before = uidRow(c, 'u-1').description;

    const [outcome] = c.appConfirm([{ uid: 'u-1', description: 'Not this' }]).results;
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/bank/);
    expect(uidRow(c, 'u-1').description).toBe(before);
  });

  it('refuses a blank, so a row always says something', () => {
    const c = withSource('manual');
    const before = uidRow(c, 'u-1').description;

    const [outcome] = c.appConfirm([{ uid: 'u-1', description: '   ' }]).results;
    expect(outcome.ok).toBe(false);
    expect(uidRow(c, 'u-1').description).toBe(before);
  });

  it('leaves the description alone when the key is absent', () => {
    // The page omits it unless it changed. Present-and-blank is a refusal and
    // absent is "I did not touch this" — the two must not converge.
    const c = withSource('manual');
    const before = uidRow(c, 'u-1').description;

    c.appConfirm([{ uid: 'u-1', confirmed: true }]);
    expect(uidRow(c, 'u-1').description).toBe(before);
  });

  it('tells the page which rows it may offer the field for', () => {
    // One rule, two readers. The page reads this to decide what to draw and the
    // writer re-asks it to decide what to honour; if they ever disagree, the
    // field appears on a row that will refuse it.
    const c = book();
    expect(c.descriptionIsEditable_('enablebanking')).toBe(false);
    ['manual', 'transfer-leg', 'csv:budgetbakers', ''].forEach((source) => {
      expect(c.descriptionIsEditable_(source), source).toBe(true);
    });
  });

  it('says which rows may be deleted, which is a narrower list than that', () => {
    // Editing a description asks whether a bank will fetch the row again.
    // Deleting asks that *and* whether anything else depends on the row — so a
    // transfer leg and an imported row are editable and not deletable.
    const c = book();
    expect(c.recordIsDeletable_('manual')).toBe(true);
    ['enablebanking', 'transfer-leg', 'csv:budgetbakers', '', null, undefined]
      .forEach((source) => {
        expect(c.recordIsDeletable_(source), String(source)).toBe(false);
      });
  });

  it('tells the page which rows carry the control', () => {
    const c = book([tx({ uid: 'u-bank' }), tx({ uid: 'u-cash', source: 'manual' })]);
    const rows = c.appRecords({ period: { kind: 'last_12' } }, 0).rows;

    expect(rows.find((r) => r.uid === 'u-cash').deletable).toBe(true);
    expect(rows.find((r) => r.uid === 'u-bank').deletable).toBe(false);
  });

  it('does not offer one as a chip from the labels tab', () => {
    const c = book([tx()]);
    const labels = c.__spreadsheet.getSheetByName('labels');
    c.appendRows_(labels, 1, [c.toRow_(c.LABEL_COLUMNS, { label: false })]);

    expect(c.labelNames_()).not.toContain('false');
  });

  it('takes labels as a string too, which is what the tab holds', () => {
    const c = book([tx({ uid: 'u-1' })]);

    c.appConfirm([{ uid: 'u-1', labels: 'travel,kids' }]);
    expect(uidRow(c, 'u-1').labels).toBe('travel, kids');
  });

  it('does not let a label called constructor vanish', () => {
    // `kept.indexOf` rather than a lookup object, because every plain object in
    // JavaScript already answers truthily to `constructor`, `toString` and
    // friends — and those are ordinary words to label a transaction with.
    const c = book([tx({ uid: 'u-1' })]);

    c.appConfirm([{ uid: 'u-1', labels: ['constructor', 'toString'] }]);
    expect(uidRow(c, 'u-1').labels).toBe('constructor, toString');
  });
});

describe('adding a rule from the app', () => {
  const good = (over = {}) => Object.assign({
    field: 'description', match_type: 'contains', pattern: 'esselunga',
    category: 'Food & Drink', subcategory: 'Groceries'
  }, over);

  const rules = (c) => c.readRecords_(c.__spreadsheet.getSheetByName('rules'),
    c.RULE_COLUMNS, c.ANY_COLUMN);

  it('appends a rule without disturbing the seeded ones', () => {
    const c = book([tx()]);
    const before = rules(c).length;

    c.appAddRule(good());
    const after = rules(c);

    expect(after).toHaveLength(before + 1);
    expect(after[after.length - 1]).toMatchObject({
      field: 'description', match_type: 'contains', pattern: 'esselunga',
      category: 'Food & Drink', subcategory: 'Groceries', enabled: true
    });
  });

  it('puts a new rule last, because it is correcting the seed', () => {
    // Rules sort ascending and the first match wins. A rule added from the app
    // has to lose to nothing and win against the seed rule it is fixing.
    const c = book([tx()]);
    c.appAddRule(good());

    const all = rules(c);
    const mine = all[all.length - 1];
    const highest = Math.max(...all.slice(0, -1).map((r) => Number(r.priority) || 0));

    expect(Number(mine.priority)).toBeGreaterThan(highest);
  });

  it('says a new rule changes nothing already in the book', () => {
    // The cascade runs on sync and `frozenVerdict_` holds a confirmed row. A
    // feature that silently does nothing to the ten rows you made it for reads
    // as broken, so the result has to say so.
    const c = book([tx()]);
    expect(c.appAddRule(good()).message).toMatch(/next sync/i);
  });

  /*
    Every refusal below is a rule that would otherwise sit on the tab looking
    correct and matching nothing, for ever. `ruleField_` returns null for a
    field it does not know and `matchesPattern_` returns false for a match type
    it does not know — neither logs, neither throws.
  */
  it('refuses a field the cascade cannot read', () => {
    const c = book([tx()]);
    expect(() => c.appAddRule(good({ field: 'merchant' }))).toThrow(/can only match on/);
  });

  it('refuses a match type the cascade cannot apply', () => {
    const c = book([tx()]);
    expect(() => c.appAddRule(good({ match_type: 'fuzzy' }))).toThrow(/can only match by/);
  });

  it('refuses a pattern too short to be one', () => {
    const c = book([tx()]);
    expect(() => c.appAddRule(good({ pattern: '' }))).toThrow(/Type something/);
    expect(() => c.appAddRule(good({ pattern: 'a' }))).toThrow(/too short/);
  });

  it('refuses a regex that will not compile', () => {
    // A broken regex is caught and returns false, so the rule matches nothing
    // and never says why.
    const c = book([tx()]);
    expect(() => c.appAddRule(good({ match_type: 'regex', pattern: '([unclosed' })))
      .toThrow(/not a pattern/);
  });

  it('refuses a category that is not on the categories tab', () => {
    // The quietest failure of all: the rule matches, writes a category,
    // `typeFormula`'s VLOOKUP finds nothing, and `in_reports` drops the row
    // out of every report with nothing to explain it.
    const c = book([tx()]);
    expect(() => c.appAddRule(good({ category: 'Groceries' })))
      .toThrow(/no category called/);
  });

  it('refuses a subcategory that belongs to a different parent', () => {
    const c = book([tx()]);
    expect(() => c.appAddRule(good({ subcategory: 'Fuel' })))
      .toThrow(/is not under Food & Drink/);
  });

  it('accepts a rule with no subcategory, which is a parent-only rule', () => {
    const c = book([tx()]);
    expect(() => c.appAddRule(good({ subcategory: '' }))).not.toThrow();
  });

  it('writes a rule the cascade then actually reads back', () => {
    // The end-to-end check: the enums agreeing is one thing, `readRules_`
    // accepting the row is the thing that matters.
    const c = book([tx()]);
    c.appAddRule(good({ pattern: 'esselunga' }));

    const loaded = c.readRules_(c.__spreadsheet);
    expect(loaded.some((r) => String(r.pattern) === 'esselunga')).toBe(true);
  });

  it('lands after every seed rule in the one list they share', () => {
    // `readRules_` returns MCC and text rules together, ordered by priority and
    // nothing else, so where an app-added rule ends up is decided entirely by
    // the number `nextRulePriority_` gave it.
    const c = book([tx()]);
    c.appAddRule(good({ pattern: 'esselunga' }));

    const loaded = c.readRules_(c.__spreadsheet);
    const priorities = loaded.map((r) => Number(r.priority));

    expect(loaded.some((r) => String(r.field) === 'mcc')).toBe(true);
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
    expect(String(loaded[loaded.length - 1].pattern)).toBe('esselunga');
  });
});

/*
  A cash withdrawal is one row: the bank debits €100 and nothing credits the
  wallet, because a wallet has no API. Marking it a transfer kept it out of
  spending and left net worth €100 short of the money in your pocket.

  These are the tests where a mistake *creates or destroys money*, so they check
  the arithmetic end to end — both balances, not just that a row appeared.
*/
describe('marking a transfer, with somewhere for the money to go', () => {
  const withAccounts = (rows) => {
    const c = book(rows);
    c.appendRows_(c.__spreadsheet.getSheetByName('accounts'), 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'w-1', name: 'Wallet', kind: 'cash',
        currency: 'EUR', opening_balance: 0, active: true, include_in_net_worth: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'a-1', name: 'Degiro', kind: 'asset',
        currency: 'EUR', balance_manual: 5000, active: true, include_in_net_worth: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'b-2', name: 'Fineco', kind: 'bank',
        currency: 'EUR', balance_api: 900, active: true, include_in_net_worth: true }),
      // The account `tx()` puts its rows on. It had no `accounts` row, which
      // was invisible while a bank could never be a destination and is not now.
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'acc-1', name: 'Revolut', kind: 'bank',
        currency: 'EUR', balance_api: 2400, active: true, include_in_net_worth: true })
    ]);
    return c;
  };

  const withdrawal = () => withAccounts([tx({
    uid: 'w-tx', amount: -100, amount_base: -100, description: 'PRELIEVO ATM',
    category: 'Transfer', subcategory: 'Cash withdrawal', type: 'transfer',
    in_reports: false
  })]);

  const ledger = (c) => c.readRecords_(
    c.__spreadsheet.getSheetByName('transactions'), c.TX_COLUMNS);

  it('writes the leg no bank will ever report', () => {
    const c = withdrawal();
    const before = ledger(c).length;

    const result = c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });
    const after = ledger(c);

    expect(result.linked).toBe(true);
    expect(after).toHaveLength(before + 1);

    const leg = after[after.length - 1];
    expect(leg.account_name).toBe('Wallet');
    expect(leg.amount).toBe(100);
    expect(leg.source).toBe(c.TX_SOURCE_TRANSFER_LEG);
  });

  it('leaves net worth where it was, which is the whole point', () => {
    // €100 moved from a bank to a pocket is not €100 gone.
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });

    const legs = ledger(c).filter((r) => String(r.account_id) === 'w-1');
    const credited = legs.reduce((sum, r) => sum + Number(r.amount), 0);

    expect(credited).toBe(100);
  });

  it('keeps both sides out of spending', () => {
    // The leg is a credit. Filed as anything but a transfer it lands in your
    // ledger as €100 of income.
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });

    ledger(c).filter((r) => ['w-tx'].includes(String(r.uid)) ||
      String(r.source) === c.TX_SOURCE_TRANSFER_LEG).forEach((r) => {
      expect(String(r.category_override)).toBe('Transfer');
    });
  });

  /*
    The subcategory is a guess that is right whenever a wallet account exists
    to withdraw into, and wrong the rest of the time. An ATM withdrawal by
    someone who does not track cash goes to "somewhere outside" and used to file
    as `Between accounts`, which is not what happened — and there was no way to
    say so, because the pane never asked.
  */
  it('guesses the subcategory from the destination when you say nothing', () => {
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });

    expect(ledger(c).find((r) => String(r.uid) === 'w-tx').subcategory_override)
      .toBe('Cash withdrawal');
  });

  it('takes the subcategory you picked over the one it would have guessed', () => {
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: c.TRANSFER_OUTSIDE,
      subcategory: 'Cash withdrawal' });

    expect(ledger(c).find((r) => String(r.uid) === 'w-tx').subcategory_override)
      .toBe('Cash withdrawal');
  });

  it('ignores a subcategory that is not a child of Transfer', () => {
    // A browser can send anything, and a name from another parent would resolve
    // through `VLOOKUP` to that parent's kind — quietly putting the row back
    // into spending, which is the one thing marking a transfer is for.
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet', subcategory: 'Groceries' });

    expect(ledger(c).find((r) => String(r.uid) === 'w-tx').subcategory_override)
      .toBe('Cash withdrawal');
  });

  it('writes no labels, whatever the page sends', () => {
    // This used to accept them to save a round trip — sound about the cost, and
    // about a write it no longer makes. A transfer is excluded from every
    // total, so a label on one is a filter that can never match.
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet', labels: ['travel'] });

    expect(ledger(c).find((r) => String(r.uid) === 'w-tx').labels).toBe('');
  });

  it('writes one leg however many times you tap', () => {
    // A double tap on a slow connection would otherwise credit the wallet
    // twice, and nothing afterwards would say it had happened.
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });
    const after = ledger(c).length;

    const second = c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });
    expect(second.already).toBe(true);
    expect(ledger(c)).toHaveLength(after);
  });

  /*
    A bank destination is paired, never written, and that is the whole of the
    difference between the two halves of this feature.

    The original rule was to refuse a bank outright — right about the leg, and
    wrong about the list, because it left no way to say "this €500 went to my
    other current account", which is the commonest internal move there is. What
    must not change is the reason it was refused: our leg plus the bank's own
    is doubled money, and `08_dedup.gs` cannot catch it, because ours has no
    `entry_reference` and a uid unlike the bank's by construction.

    So the row count is the assertion in all three of these.
  */
  const between = () => withAccounts([
    tx({ uid: 'out-1', amount: -500, amount_base: -500, description: 'BONIFICO A FINECO',
      booking_date: new Date(2026, 6, 15) }),
    tx({ uid: 'in-1', account_id: 'b-2', account_name: 'Fineco',
      amount: 500, amount_base: 500, description: 'BONIFICO DA REVOLUT',
      booking_date: new Date(2026, 6, 16), category: 'Income', subcategory: 'Salary',
      type: 'income', in_reports: true })
  ]);

  it('pairs a bank destination with the row it already reported', () => {
    const c = between();
    const before = ledger(c).length;

    const result = c.appMarkTransfer({ uid: 'out-1', destination: 'Fineco' });

    expect(result.paired).toBe(true);
    expect(ledger(c)).toHaveLength(before);          // nothing was written

    const rows = ledger(c);
    const out = rows.find((r) => String(r.uid) === 'out-1');
    const inn = rows.find((r) => String(r.uid) === 'in-1');

    expect(out.transfer_group).toBe('tr:out-1');
    expect(inn.transfer_group).toBe('tr:out-1');
    expect(inn.category_override).toBe('Transfer');
  });

  it('takes the group id detectTransfers_ would have derived', () => {
    // Both must agree or the nightly run renames the pair, and `transfer_group`
    // stops being something anything can remember. It is keyed on the *debit*.
    const c = between();
    c.appMarkTransfer({ uid: 'in-1', destination: 'Revolut' });

    expect(ledger(c).find((r) => String(r.uid) === 'in-1').transfer_group)
      .toBe('tr:out-1');
  });

  it('marks the row anyway when the other side has not synced yet', () => {
    // The ordinary case on the day you move the money. `transferEligible_`
    // leaves a transfer-categorised row pairable, so the nightly run finishes.
    const c = withdrawal();
    const result = c.appMarkTransfer({ uid: 'w-tx', destination: 'Fineco' });

    expect(result.paired).toBeUndefined();
    expect(result.message).toMatch(/syncs/);
    expect(ledger(c)).toHaveLength(1);
    expect(ledger(c)[0].category_override).toBe('Transfer');
  });

  it('does not steal a row that is already half of another pair', () => {
    // `transfer_group` is the only record that the other pairing happened, so
    // taking its counter-leg would unmake it silently.
    const c = between();
    const tx2 = c.__spreadsheet.getSheetByName('transactions');
    c.writeCell_(tx2, c.uidIndex_(tx2)['in-1'], c.TX_COLUMNS, 'transfer_group', 'tr:other');

    expect(c.appMarkTransfer({ uid: 'out-1', destination: 'Fineco' }).paired)
      .toBeUndefined();
    expect(ledger(c).find((r) => String(r.uid) === 'in-1').transfer_group)
      .toBe('tr:other');
  });

  it('will not pair across a gap wider than transfer_window_days', () => {
    const c = withAccounts([
      tx({ uid: 'out-1', amount: -500, amount_base: -500,
        booking_date: new Date(2026, 6, 1) }),
      tx({ uid: 'in-1', account_id: 'b-2', account_name: 'Fineco',
        amount: 500, amount_base: 500, booking_date: new Date(2026, 6, 20) })
    ]);

    expect(c.appMarkTransfer({ uid: 'out-1', destination: 'Fineco' }).paired)
      .toBeUndefined();
  });

  it('refuses the account the transaction is already on', () => {
    const c = withdrawal();
    expect(() => c.appMarkTransfer({ uid: 'w-tx', destination: 'Revolut' })).toThrow();
  });

  it('takes an asset account as a destination', () => {
    const c = withAccounts([tx({ uid: 't-1', amount: -1500, amount_base: -1500,
      description: 'GIROCONTO A DEGIRO' })]);

    expect(c.appMarkTransfer({ uid: 't-1', destination: 'Degiro' }).linked).toBe(true);
    expect(ledger(c).filter((r) => String(r.account_id) === 'a-1')[0].amount).toBe(1500);
  });

  it('credits the source and debits the destination when the money came in', () => {
    // The other direction: cash paid back into a bank. The leg has to be the
    // debit, or both accounts gain.
    const c = withAccounts([tx({ uid: 'in-1', amount: 250, amount_base: 250,
      description: 'VERSAMENTO CONTANTI' })]);
    c.appMarkTransfer({ uid: 'in-1', destination: 'Wallet' });

    expect(ledger(c).filter((r) => String(r.account_id) === 'w-1')[0].amount).toBe(-250);
  });

  it('marks a transfer out of your tracked accounts without inventing a leg', () => {
    // Money to another bank or to someone else. Nothing here to credit, so net
    // worth falls — correctly: it is the sum of what you track, and it left.
    const c = withdrawal();
    const before = ledger(c).length;

    const result = c.appMarkTransfer({ uid: 'w-tx', destination: c.TRANSFER_OUTSIDE });
    expect(result).toMatchObject({ linked: false, outside: true });
    expect(ledger(c)).toHaveLength(before);
    expect(ledger(c)[0].category_override).toBe('Transfer');
  });

  it('will not read an unanswered field as "it left my accounts"', () => {
    // A blank and the outside sentinel mean opposite things, and a form that
    // serialises an empty select must not silently pick one.
    const c = withdrawal();
    expect(() => c.appMarkTransfer({ uid: 'w-tx', destination: '' }))
      .toThrow(/where the money went/);
  });

  it('says so rather than guessing when the uid has gone', () => {
    const c = withdrawal();
    expect(() => c.appMarkTransfer({ uid: 'nope', destination: 'Wallet' }))
      .toThrow(/no longer in transactions/);
  });

  it('gives the pair the group id the next sync would derive anyway', () => {
    // `detectTransfers_` pairs by amount, sign and date and computes the id
    // from the *debit's* uid. Writing a different one would be silently
    // replaced on the next categorise run.
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });

    const groups = ledger(c).map((r) => String(r.transfer_group)).filter(Boolean);
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).toBe('tr:w-tx');
    expect(groups).toHaveLength(2);
  });

  it('writes a leg only in the code-owned columns, plus the overrides', () => {
    // Same contract every other writer here honours: A–O is the append, and
    // the only columns past it are the three that are yours.
    const c = withdrawal();
    c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet' });

    const leg = ledger(c)[ledger(c).length - 1];
    expect(leg.category_auto).toBeFalsy();
    expect(leg.notes).toBeFalsy();
    expect(leg.entry_reference).toBeFalsy();
  });

  /*
    An amount corrected in the same press as the transfer is marked.

    The sheet's Amount field sits above the tabs, so it is on screen on this
    pane too — and this endpoint builds the leg from the source row's figure,
    so a correction that arrived a round trip later would leave the leg
    mirroring the mistyped one for ever.
  */
  it('builds the leg from an amount corrected in the same press', () => {
    const c = withAccounts([tx({ uid: 'c-1', source: 'manual', account_id: 'w-1',
      account_name: 'Wallet', amount: -100, amount_base: -100,
      description: 'Contanti a Degiro' })]);

    c.appMarkTransfer({ uid: 'c-1', destination: 'Degiro', amount: 120 });

    const rows = ledger(c);
    expect(rows.find((r) => String(r.uid) === 'c-1').amount).toBe(-120);
    expect(rows[rows.length - 1]).toMatchObject({ account_name: 'Degiro', amount: 120 });
  });

  it('refuses an amount on a row that is not cash you typed', () => {
    const c = withdrawal();

    expect(() => c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet', amount: 120 }))
      .toThrow(/cash you typed/);
    expect(ledger(c).find((r) => String(r.uid) === 'w-tx').amount).toBe(-100);
  });

  it('refuses it before writing the category, so nothing lands half-done', () => {
    const c = withdrawal();

    expect(() => c.appMarkTransfer({ uid: 'w-tx', destination: 'Wallet', amount: 120 })).toThrow();
    expect(ledger(c).find((r) => String(r.uid) === 'w-tx').transfer_group).toBe('');
    expect(ledger(c)).toHaveLength(1);
  });
});

describe('asset accounts, which behave like wallets', () => {
  const withAsset = () => {
    const c = book([tx()]);
    c.appendRows_(c.__spreadsheet.getSheetByName('accounts'), 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'a-1', name: 'Degiro', kind: 'asset',
        currency: 'EUR', balance: 14200, balance_manual: 14200, active: true,
        include_in_net_worth: true })
    ]);
    return c;
  };

  it('offers asset accounts with their balances, unlike the other two lists', () => {
    // Setting a value is a *difference*, so the screen cannot ask the question
    // without already knowing the answer it is changing.
    const c = withAsset();
    expect(c.appOpen().lists.assetAccounts)
      .toEqual([{ name: 'Degiro', balance: 14200, currency: 'EUR' }]);
  });

  it('offers no bank or cash account among them', () => {
    const c = withAsset();
    const names = c.appOpen().lists.assetAccounts.map((a) => a.name);
    expect(names).not.toContain('Revolut');
  });

  it('takes an adjustment through the unchanged cash path', () => {
    // `cashEntryProblem_` never checks an account's kind and
    // `resolveCashAccount_` resolves any name, so this needed no new writer.
    const c = withAsset();
    c.appAddCash({ amount: 1500, account: 'Degiro', category: 'Transfer',
      subcategory: 'Valuation change', note: 'up' });

    const rows = c.readRecords_(c.__spreadsheet.getSheetByName('transactions'), c.TX_COLUMNS);
    const written = rows[rows.length - 1];

    expect(written.account_name).toBe('Degiro');
    expect(written.amount).toBe(1500);
    expect(written.category_override).toBe('Transfer');
    expect(written.subcategory_override).toBe('Valuation change');
  });

  /*
    A category the book does not have is a refusal, not a stored row.

    This is the one write in the app that names a category as a *literal* rather
    than picking it off a list the server sent — it is stating what a
    revaluation is rather than asking. So it is also the only one that can name
    something absent, and the way to be absent is ordinary: `setup()` adds seed
    rows and a book set up before `Valuation change` existed does not have it
    until setup runs again.

    Without this check the entry stored fine and did nothing. `category_override`
    held a name `typeFormula`'s VLOOKUP could not resolve, `type` came back
    blank, and the transaction sat in the ledger belonging to nothing — so the
    balance did not move, and the app reported success. That is the report the
    owner sent: "I changed the value and the dashboard did not update."
  */
  it('refuses a category this book does not have, by name', () => {
    const c = withAsset();

    expect(() => c.appAddCash({ amount: 1500, account: 'Degiro',
      category: 'Transfer', subcategory: 'Revaluation' }))
      .toThrow(/Revaluation/);
    expect(() => c.appAddCash({ amount: 1500, account: 'Degiro',
      category: 'Reconciliation' })).toThrow(/Reconciliation/);
  });

  it('names Setup in the refusal, because that is the fix', () => {
    // The realistic way to reach it is a book set up before the category was
    // seeded. "Unknown category" would be true and would not tell you that
    // running Setup adds it.
    const c = withAsset();
    expect(() => c.appAddCash({ amount: 1, account: 'Degiro', category: 'Nope' }))
      .toThrow(/Setup sheet/);
  });

  it('still takes an entry with no category at all', () => {
    // "Uncategorised" is what `renderAdd` offers and what the cascade exists to
    // fill in. Refusing a blank would be refusing the default.
    const c = withAsset();
    expect(() => c.appAddCash({ amount: 3.5, account: 'Degiro' })).not.toThrow();
  });

  it('keeps a gain positive and a loss negative', () => {
    // The sign rule this leans on rather than reimplementing: a positive delta
    // with a `transfer` category stays positive, and a typed minus always wins.
    const c = book();
    expect(c.cashEntryAmount(1500, 'transfer')).toBe(1500);
    expect(c.cashEntryAmount(-800, 'transfer')).toBe(-800);
  });

  it('seeds a valuation subcategory that is a transfer, not income', () => {
    // A €1,500 market gain moves net worth and is emphatically not income this
    // month. `in_reports` excludes transfers from every total.
    const seeded = book().DEFAULT_CATEGORIES
      .filter((row) => row[1] === 'Valuation change');

    expect(seeded).toHaveLength(1);
    expect(seeded[0][0]).toBe('Transfer');
    expect(seeded[0][2]).toBe('transfer');
  });
});

describe('the merchant key a rule is built from', () => {
  it('is sent on every record, computed by the categoriser itself', () => {
    // Not reimplemented in the page: `normalizeMerchant` strips dates, card
    // references, digit runs and a list of Italian POS noise words, and a
    // second copy in JS would be a second thing to keep in step with the
    // cascade it exists to agree with.
    const c = book([tx({ uid: 'u-1', description: 'ESSELUNGA CARTA *1234 12/07' })]);
    const row = c.appRecords({ period: { kind: 'last_12' } }, 0).rows[0];

    expect(row.merchantKey).toBe(c.normalizeMerchant('ESSELUNGA CARTA *1234 12/07', ''));
    expect(row.merchantKey).not.toMatch(/1234/);
  });
});

/*
  The drill, through the entry point the page actually calls.

  `tests/query.test.mjs` proves the filtering and the reconciliation against
  `webAppRecords_`. What is left to prove here is that the three fields survive
  `appRecords` — which is a different question, because they ride inside the
  filter object rather than as arguments of their own, and a screen that
  silently ignores them looks exactly like a screen with nothing to show.
*/
describe('drilling from Charts, through the entry point', () => {
  const drillBook = () => book([
    tx({ uid: 'u-1', description: 'esselunga', amount_base: -40 }),
    tx({ uid: 'u-2', description: 'osteria', amount_base: -60,
         subcategory: 'Restaurants' }),
    tx({ uid: 'u-3', description: 'salary', amount_base: 2000,
         category: 'Income', subcategory: 'Salary', type: 'income' }),
    tx({ uid: 'u-4', description: 'moved money', amount_base: -500,
         category: 'Transfer', subcategory: 'Internal', in_reports: false })
  ]);

  const last12 = { period: { kind: 'last_12' } };

  it('carries the three filters through appRecords, not just through the query', () => {
    const c = drillBook();

    expect(c.appRecords(last12, 0).total).toBe(4);
    expect(c.appRecords({ ...last12, spendOnly: true }, 0).total).toBe(2);
    expect(c.appRecords({ ...last12, spendOnly: true, category: 'Food & Drink' }, 0)
      .rows.map((r) => r.description).sort()).toEqual(['esselunga', 'osteria']);
    expect(c.appRecords({
      ...last12, spendOnly: true, category: 'Food & Drink', subcategory: 'Restaurants'
    }, 0).rows.map((r) => r.description)).toEqual(['osteria']);
  });

  it('adds up to the number on the card that opened it', () => {
    // The same assertion `query.test.mjs` makes, made once through the public
    // surface — these are the two functions the page calls within a second of
    // each other, and they must not be able to disagree.
    const c = drillBook();
    const expenses = c.appAnalytics(last12).totals.expenses;
    const drilled = c.appRecords({ ...last12, spendOnly: true }, 0);

    expect(expenses).toBe(100);
    expect(drilled.rows.reduce((n, r) => n + -r.amount, 0)).toBe(expenses);
  });

  // No gate test here: the drill adds no entry point. `appRecords` was already
  // on `PUBLIC_API`, and the gate is asserted by reading the file rather than by
  // calling it — see 'the gate on every entry point', which derives the list.
});

describe('the periods the picker offers', () => {
  const years = (list) => list.filter((p) => p.kind === 'year').map((p) => p.year);

  it('offers only years the ledger has rows in', () => {
    // A period picker must never offer a window that is empty by construction:
    // an empty result from a period you chose is indistinguishable from a
    // filter bug, and there is nothing on the screen to tell them apart.
    const c = book();
    const ledger = [
      { booking_date: new Date(2024, 3, 2) },
      { booking_date: new Date(2022, 10, 9) },
      { booking_date: new Date(2024, 8, 1) }
    ];

    expect(years(c.appPeriods_(ledger))).toEqual([2024, 2022]);
  });

  it('leaves the current year to year-to-date', () => {
    const c = book();
    const now = new Date().getFullYear();
    const list = c.appPeriods_([{ booking_date: new Date() }]);

    expect(years(list)).not.toContain(now);
    expect(list.some((p) => p.kind === 'ytd')).toBe(true);
  });

  it('gives every entry an id, and every id is distinct', () => {
    // The whole reason `id` exists: the named years all share `kind: "year"`,
    // so a page matching on kind would mark them all selected and send a spec
    // with no year in it — which resolves to the current year.
    const c = book();
    const list = c.appPeriods_([
      { booking_date: new Date(2024, 1, 1) },
      { booking_date: new Date(2023, 1, 1) }
    ]);

    const ids = list.map((p) => p.id);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('year:2024');
  });

  it('survives an empty ledger and a ledger of unreadable dates', () => {
    const c = book();
    [[], [{ booking_date: '' }, { booking_date: 'not a date' }, {}]].forEach((ledger) => {
      const list = c.appPeriods_(ledger);
      expect(years(list)).toEqual([]);
      // The fixed entries are always there, so the picker is never empty.
      expect(list.map((p) => p.id)).toContain('mtd');
      expect(list.map((p) => p.id)).toContain('custom');
    });
  });

  it('offers a month as one entry, not as twelve', () => {
    // The point of the entry, and the one thing about it a test can hold: a
    // month is a year *and* a month, so spelling out the product would put a
    // hundred-odd entries in a picker scrolled with a thumb. The page draws the
    // twelve as chips under this single option — which it can only do while the
    // id is the bare kind, because that is the string `periodOptionId` maps
    // every `{kind: 'month', …}` spec back to.
    const c = book();
    const list = c.appPeriods_([
      { booking_date: new Date(2024, 1, 1) },
      { booking_date: new Date(2023, 1, 1) }
    ]);

    const months = list.filter((p) => p.kind === 'month');
    expect(months).toHaveLength(1);
    expect(months[0].id).toBe('month');
    expect(months[0].year).toBeUndefined();
  });

  it('resolves the spec its month entry stands for', () => {
    // The entry carries no year and no month, so the page fills both in. This
    // is the pair it sends, checked against the resolver rather than assumed —
    // the two live in different files and nothing else makes them agree.
    const c = book();
    const window = c.resolveWindow_({ kind: 'month', year: 2026, month: 3 },
      new Date(2026, 7, 9));

    expect([c.dayKey_(window.from), c.dayKey_(window.to)])
      .toEqual(['2026-03-01', '2026-03-31']);
  });

  it('caps the years, so one corrupt date cannot fill the dropdown', () => {
    const c = book();
    const ledger = [];
    for (let y = 1900; y < 2020; y++) ledger.push({ booking_date: new Date(y, 5, 1) });

    expect(years(c.appPeriods_(ledger)).length).toBe(10);
  });
});

describe('the taxonomy the sheet offers', () => {
  it('carries kind on parents as well as children', () => {
    // The page filters the pickers by kind so a salary is not offered
    // `Groceries`. `children` always had it and `parents` did not, which read
    // as deliberate and was not — both feed the same sheet.
    const c = book([tx()]);
    const choices = c.categoryChoices_();

    const income = choices.parents.filter((p) => p.name === 'Income')[0];
    const transfer = choices.parents.filter((p) => p.name === 'Transfer')[0];

    expect(income.kind).toBe('income');
    expect(transfer.kind).toBe('transfer');
    expect(choices.parents.filter((p) => p.name === 'Food & Drink')[0].kind).toBe('expense');
  });

  it('agrees with the formula about which kind a parent is', () => {
    // `typeFormula()` resolves a row's type by VLOOKUP into categories!A:C,
    // which takes the first matching row. This reads the first row too, so the
    // page and the sheet are wrong in the same direction or not at all.
    const c = book([tx()]);
    const rows = c.readRecords_(c.__spreadsheet.getSheetByName('categories'),
      c.CATEGORY_COLUMNS);

    c.categoryChoices_().parents.forEach((parent) => {
      const first = rows.filter((r) => String(r.category) === parent.name)[0];
      expect(parent.kind, parent.name).toBe(String(first.kind));
    });
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

  it('signs an unsigned amount by the direction the page chose', () => {
    // The page has Expense and Income buttons instead of a sign in the field,
    // because a phone's decimal keypad has no `+`. A typed minus is the same
    // number either way — the button decides.
    const c = cashBook();
    c.appAddCash({ amount: 3.5, direction: 'expense', account: 'Wallet',
      category: 'Food & Drink' });
    c.appAddCash({ amount: -3.5, direction: 'expense', account: 'Wallet' });
    c.appAddCash({ amount: 200, direction: 'income', account: 'Wallet', category: 'Income' });
    c.appAddCash({ amount: -200, direction: 'income', account: 'Wallet', category: 'Income' });
    c.appAddCash({ amount: 50, direction: 'income', account: 'Wallet', category: 'Transfer' });
    c.appAddCash({ amount: 50, direction: 'expense', account: 'Wallet', category: 'Transfer' });

    expect(ledger(c).map((r) => r.amount)).toEqual([-3.5, -3.5, 200, 200, 50, -50]);
  });

  it('refuses an income the drain would record as spending', () => {
    // A positive amount is only kept positive by an Income or Transfer
    // category, so without one the button said Income and the ledger would say
    // an expense of the same size.
    const c = cashBook();
    expect(() => c.appAddCash({ amount: 200, direction: 'income', account: 'Wallet' }))
      .toThrow('Income needs an Income category');
    expect(() => c.appAddCash({ amount: 200, direction: 'income', account: 'Wallet',
      category: 'Food & Drink' })).toThrow('Income needs an Income category');
    expect(ledger(c)).toHaveLength(0);
  });

  it('refuses a direction it does not know rather than guessing one', () => {
    const c = cashBook();
    expect(() => c.appAddCash({ amount: 3, direction: 'sideways', account: 'Wallet' }))
      .toThrow('Choose Expense or Income');
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

  describe('the date', () => {
    const today = (c) => c.dayNumber_(new Date(2026, 8, 15));
    const entry = (date) => ({ amount: '3', account: 'Wallet', date: date });

    it('takes today and any day before it', () => {
      const c = cashBook();
      expect(c.cashEntryProblem_(entry(new Date(2026, 8, 15)), today(c))).toBeNull();
      expect(c.cashEntryProblem_(entry(new Date(2024, 0, 1)), today(c))).toBeNull();
    });

    it('takes tomorrow, because a phone east of the book is already there', () => {
      const c = cashBook();
      expect(c.cashEntryProblem_(entry(new Date(2026, 8, 16)), today(c))).toBeNull();
    });

    it('refuses a day that is not yet today anywhere', () => {
      const c = cashBook();
      expect(c.cashEntryProblem_(entry(new Date(2026, 8, 17)), today(c))).toMatch(/in the future/);
    });

    it('treats a blank date as today rather than as unreadable', () => {
      // `isBlankCell_` before `toDate_`: a cleared date means "today", and a
      // guard that only compared would have no date to compare.
      const c = cashBook();
      expect(c.cashEntryProblem_(entry(''), today(c))).toBeNull();
      expect(c.cashEntryProblem_(entry(undefined), today(c))).toBeNull();
    });

    it('is refused by the endpoint itself, not only by the picker', () => {
      // A native date picker can ignore `max`, and a page can send anything.
      const c = cashBook();
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      expect(() => c.appAddCash(entry(nextWeek))).toThrow('in the future');
      expect(ledger(c)).toHaveLength(0);
    });
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
    expect(c.appOpen().lists.cashAccounts).toEqual(['Wallet']);
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

  /*
    Labels, which the tab has always had a column for and the form never had a
    control for. Stored through `normalizeLabels_`, so a confirmation and an add
    cannot disagree about the shape of the column they both write.
  */
  it('stores labels in the shape splitLabels_ reads back', () => {
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet', labels: ['travel', '', 'travel', 'kids'] });

    expect(ledger(c)[0].labels).toBe('travel, kids');
  });

  it('takes the string the tab holds, as well as the array the chips send', () => {
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet', labels: 'travel,kids' });

    expect(ledger(c)[0].labels).toBe('travel, kids');
  });

  it('refuses a label on a transfer, the way a confirmation does', () => {
    // A label is an axis over spending and a transfer is not spending. Thrown
    // rather than dropped: there is nothing else in this request to save around
    // it, so filing the entry without them would file something else.
    const c = cashBook();

    expect(() => c.appAddCash({ amount: '3', account: 'Wallet',
      category: 'Transfer', subcategory: 'Between accounts', labels: ['travel'] }))
      .toThrow('no labels');
    expect(ledger(c)).toHaveLength(0);
  });

  it('still takes a transfer that carries no labels', () => {
    // The refusal is about labels, not about transfers — "Update balance"
    // writes `Transfer › Valuation change` through this same endpoint.
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet', category: 'Transfer',
      subcategory: 'Between accounts', labels: [] });

    expect(ledger(c)).toHaveLength(1);
  });

  it('stores a real date, not the string the page sent', () => {
    // `drainCashEntries_` copies this cell straight into booking_date, and a
    // string there sorts and filters as text.
    const c = cashBook();
    c.appAddCash({ amount: '3', account: 'Wallet', date: '2026-03-09' });

    expect(ledger(c)[0].booking_date).toBeInstanceOf(Date);
  });
});

describe('deleting a cash transaction', () => {
  /**
   * The only thing in the app that destroys a row, so most of this file is
   * about what it *refuses*. `transactions` is append-only by design and every
   * other source has a reason not to be removable a row at a time — see
   * `recordIsDeletable_`.
   */
  const ledger = (c) => c.readRecords_(
    c.__spreadsheet.getSheetByName('transactions'), c.TX_COLUMNS, 1);

  const removed = (c) => c.readRecords_(
    c.__spreadsheet.getSheetByName('_removed'), c.TX_COLUMNS, 1);

  const cash = (over = {}) => tx(Object.assign({
    uid: 'u-cash', source: 'manual', description: 'Coffee'
  }, over));

  it('removes the row and keeps a copy on _removed', () => {
    const c = book([tx({ uid: 'u-bank' }), cash()]);
    const result = c.appDeleteRecord({ uid: 'u-cash' });

    expect(result.removed).toBe(1);
    expect(result.message).toMatch(/_removed/);
    expect(ledger(c).map((r) => r.uid)).toEqual(['u-bank']);
    expect(removed(c).map((r) => r.uid)).toEqual(['u-cash']);
  });

  it('archives the row before deleting it, not after', () => {
    // Ordered this way so a failure at the delete leaves a spare archive row —
    // noise — rather than leaving nothing at all. Asserted through the archive
    // holding the row's actual contents, which is only true if the copy was
    // taken while the row still existed.
    const c = book([tx({ uid: 'u-bank' }), cash({ description: 'Gelato', amount: 4.5 })]);
    c.appDeleteRecord({ uid: 'u-cash' });

    expect(removed(c)[0].description).toBe('Gelato');
    expect(removed(c)[0].amount).toBe(4.5);
  });

  it('refuses a synced row, which would come back on the next sync', () => {
    const c = book([tx({ uid: 'u-bank' })]);
    expect(() => c.appDeleteRecord({ uid: 'u-bank' })).toThrow(/cash transaction you typed/);
    expect(ledger(c)).toHaveLength(1);
  });

  it('refuses a transfer leg, which would orphan its partner', () => {
    const c = book([cash({ uid: 'u-leg', source: 'transfer-leg' })]);
    expect(() => c.appDeleteRecord({ uid: 'u-leg' })).toThrow(/cash transaction you typed/);
  });

  it('refuses an imported row, which has its own removal path', () => {
    const c = book([cash({ uid: 'u-csv', source: 'csv:budgetbakers' })]);
    expect(() => c.appDeleteRecord({ uid: 'u-csv' })).toThrow(/cash transaction you typed/);
  });

  it('asks the sheet what the source is, not the caller', () => {
    // A page can send anything. `recordIsDeletable_` is consulted twice for the
    // same reason `descriptionIsEditable_` is, and this is the second one.
    const c = book([tx({ uid: 'u-bank' })]);
    expect(() => c.appDeleteRecord({ uid: 'u-bank', source: 'manual' }))
      .toThrow(/cash transaction you typed/);
  });

  it('refuses row 2, which anchors every formula on the tab', () => {
    // Not a delete at all but the destruction of every derived column, and the
    // one case `commitSyncedDuplicates_` also refuses rather than repairs.
    const c = book([cash()]);
    expect(() => c.appDeleteRecord({ uid: 'u-cash' })).toThrow(/row 2/);
    expect(ledger(c)).toHaveLength(1);
  });

  it('refuses a uid it cannot find, and one it was never given', () => {
    const c = book([tx({ uid: 'u-bank' }), cash()]);
    expect(() => c.appDeleteRecord({ uid: 'nope' })).toThrow(/not in transactions/);
    expect(() => c.appDeleteRecord({})).toThrow(/Which transaction/);
  });

  it('re-baselines the row count, so the next sync is not blocked', () => {
    // The row-loss detector has just watched the tab shrink, which it is right
    // to treat as a catastrophe. This shrink was asked for.
    const c = book([tx({ uid: 'u-bank' }), cash()]);
    c.rememberRowCount_();
    c.appDeleteRecord({ uid: 'u-cash' });

    expect(c.checkRowLoss_()).toEqual([]);
  });

  it('invalidates the ledger cache, which deleteRows does not do by itself', () => {
    // `deleteRows` is neither `writeCell_` nor `appendRows_`, and `onEdit` does
    // not fire for a change a script made — so without the explicit bump the
    // app goes on serving the deleted row until the cache expires.
    const c = book([tx({ uid: 'u-bank' }), cash()]);
    const before = c.dataVersion_();
    c.appDeleteRecord({ uid: 'u-cash' });

    expect(c.dataVersion_()).not.toBe(before);
  });
});

describe('editing the amount of a cash transaction', () => {
  /**
   * The second write in the app that touches A–O, and the one with the most
   * reasons to say no: an amount is hashed into a synced row's uid, is half of
   * the `crossSourceKey` that pairs an imported row with its synced twin, and
   * is mirrored by the leg of a transfer. So most of this is about refusals,
   * and about the sign, which the page never sends.
   */
  const ledger = (c) => c.readRecords_(
    c.__spreadsheet.getSheetByName('transactions'), c.TX_COLUMNS, 1);
  const row = (c, uid) => ledger(c).find((r) => String(r.uid) === uid);

  const cash = (over = {}) => book([tx(Object.assign({
    uid: 'u-cash', source: 'manual', amount: -6.5, amount_base: -6.5,
    description: 'Caffè e cornetto', category: 'Food & Drink',
    subcategory: 'Bars & Cafes', type: 'expense'
  }, over))]);

  it('changes how much without changing which way', () => {
    const c = cash();

    c.appConfirm([{ uid: 'u-cash', amount: 8 }]);

    expect(row(c, 'u-cash').amount).toBe(-8);
  });

  it('keeps the direction of a row that goes the other way', () => {
    // A cash entry stored positive — money into the wallet — stays positive.
    // Re-deriving the sign from the category is what this deliberately does
    // not do: `-50` typed under Transfer is cash paid *into* a bank, and
    // deriving from `transfer` would turn a correction into a deposit.
    const c = cash({ amount: 50, amount_base: 50, category: 'Transfer',
      subcategory: 'Between accounts', type: 'transfer', in_reports: false });

    c.appConfirm([{ uid: 'u-cash', amount: 60 }]);

    expect(row(c, 'u-cash').amount).toBe(60);
  });

  it('refuses a typed minus rather than obeying or dropping it', () => {
    // Obeying it makes the field a sign control half the time; dropping it
    // ignores something typed on purpose. Both are worse than saying so.
    const c = cash();

    const [outcome] = c.appConfirm([{ uid: 'u-cash', amount: -8 }]).results;

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toMatch(/without a sign/);
    expect(row(c, 'u-cash').amount).toBe(-6.5);
  });

  it('refuses a blank, a zero and a word', () => {
    // `Number('')` is 0 and `isFinite(0)` is true, which is the guard this
    // project has now written down six times.
    [['', /blank/], [0, /not a transaction/], ['lots', /not a number/]]
      .forEach(([amount, says]) => {
        const c = cash();

        const [outcome] = c.appConfirm([{ uid: 'u-cash', amount }]).results;

        expect(outcome.ok, String(amount)).toBe(false);
        expect(outcome.reason).toMatch(says);
        expect(row(c, 'u-cash').amount).toBe(-6.5);
      });
  });

  it('refuses every source but cash you typed', () => {
    ['enablebanking', 'csv:budgetbakers', 'transfer-leg'].forEach((source) => {
      const c = cash({ source });

      const [outcome] = c.appConfirm([{ uid: 'u-cash', amount: 8 }]).results;

      expect(outcome.ok, source).toBe(false);
      expect(outcome.reason).toMatch(/cash you typed/);
      expect(row(c, 'u-cash').amount).toBe(-6.5);
    });
  });

  it('refuses a cash row that is already half of a transfer', () => {
    // The other leg mirrors this figure. Changing one side alone leaves a
    // transfer that nets to something other than zero.
    const c = cash();
    // Past column O, so the book helper does not carry it in — the same
    // reason `writeCashOverrides_` writes this column on its own.
    c.writeCell_(c.__spreadsheet.getSheetByName('transactions'), 2, c.TX_COLUMNS,
      'transfer_group', 'tr:u-cash');

    const [outcome] = c.appConfirm([{ uid: 'u-cash', amount: 8 }]).results;

    expect(outcome.ok).toBe(false);
    expect(row(c, 'u-cash').amount).toBe(-6.5);
  });

  it('writes nothing at all when it refuses, unlike the description', () => {
    // The check is first in the loop for this reason: a refused amount must
    // not leave the category and the tick behind it written.
    const c = cash();

    c.appConfirm([{ uid: 'u-cash', amount: -8, confirmed: true,
      category_override: 'Housing' }]);

    expect(row(c, 'u-cash')).toMatchObject({ amount: -6.5, confirmed: '',
      category_override: '' });
  });

  it('leaves the amount alone when the key is absent', () => {
    const c = cash();

    c.appConfirm([{ uid: 'u-cash', confirmed: true }]);

    expect(row(c, 'u-cash').amount).toBe(-6.5);
  });

  it('tells the page which rows may offer the field', () => {
    // One rule, two readers, and they must not disagree — the field would
    // appear on a row the writer then refuses.
    const c = book();
    expect(c.amountIsEditable_('manual', '')).toBe(true);
    expect(c.amountIsEditable_('manual', 'tr:u-1')).toBe(false);
    ['enablebanking', 'transfer-leg', 'csv:budgetbakers', '', null, undefined]
      .forEach((source) => {
        expect(c.amountIsEditable_(source, ''), String(source)).toBe(false);
      });
  });

  it('sends that answer with the row', () => {
    const c = book([tx({ uid: 'u-bank' }), tx({ uid: 'u-cash', source: 'manual' })]);
    const rows = c.appRecords({ period: { kind: 'last_12' } }, 0).rows;

    expect(rows.find((r) => r.uid === 'u-cash').editableAmount).toBe(true);
    expect(rows.find((r) => r.uid === 'u-bank').editableAmount).toBe(false);
  });

  it('hands the row back carrying the figure it now holds', () => {
    const c = cash();

    const [outcome] = c.appConfirm([{ uid: 'u-cash', amount: 8 }]).results;

    expect(outcome.ok).toBe(true);
    expect(outcome.record.rawAmount).toBe(-8);
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

  it('lists the banks, then the cash, then the assets', () => {
    // Balance alone put a flat asset valuation between two current accounts.
    // Every balance here is chosen so a pure balance ranking would interleave
    // the kinds — House and Car would open the list — and so that the order
    // inside each group is still the balance one.
    const c = book([]);
    c.appendRows_(c.__spreadsheet.getSheetByName('accounts'), 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'h', name: 'House', kind: 'asset',
        currency: 'EUR', balance: 500000, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'w', name: 'Wallet', kind: 'cash',
        currency: 'EUR', balance: 20, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'b', name: 'Revolut', kind: 'bank',
        currency: 'EUR', balance: 100, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'c', name: 'Car', kind: 'asset',
        currency: 'EUR', balance: 1000, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 't', name: 'Tin', kind: 'cash',
        currency: 'EUR', balance: 300, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'f', name: 'Fineco', kind: 'bank',
        currency: 'EUR', balance: 5, active: true })
    ]);

    expect(c.appOpen().accounts.map((account) => account.name))
      .toEqual(['Revolut', 'Fineco', 'Tin', 'Wallet', 'House', 'Car']);
  });

  it('sorts an account whose kind it does not know to the end', () => {
    // `indexOf` answers -1 for one, and -1 in front of `bank` would put the
    // row with the empty `kind` cell above the banks — the one place a row
    // nobody has finished filling in must not land.
    const c = book([]);
    c.appendRows_(c.__spreadsheet.getSheetByName('accounts'), 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'x', name: 'Unfilled', kind: '',
        currency: 'EUR', balance: 900, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'h', name: 'House', kind: 'asset',
        currency: 'EUR', balance: 500, active: true }),
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'b', name: 'Revolut', kind: 'bank',
        currency: 'EUR', balance: 100, active: true })
    ]);

    expect(c.appOpen().accounts.map((account) => account.name))
      .toEqual(['Revolut', 'House', 'Unfilled']);
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

describe('the two calls the app opens with', () => {
  it('puts the ledger-free half in appOpen and nothing else there', () => {
    // The whole point of the split: this call must not touch `transactions`,
    // or it inherits the 1,600ms it exists to avoid waiting for.
    const c = book([tx()]);
    const open = c.appOpen();

    expect(Object.keys(open).sort()).toEqual(
      ['accounts', 'currency', 'generatedAt', 'lists', 'netWorth']);
    // All three are derived from `accounts`, which this half has already read,
    // so they are free here and would each cost a tab read in the other one.
    expect(Object.keys(open.lists).sort())
      .toEqual(['accounts', 'assetAccounts', 'cashAccounts']);
  });

  it('reads no transaction row for the first paint', () => {
    // Asserted by counting rather than by reading the code, because the way
    // this regresses is somebody adding one convenient field to `appOpen`.
    const c = book([tx()]);
    c.__resetReads();
    c.appOpen();

    expect(c.__reads('transactions')).toBe(0);
  });

  it('carries the month, the queue and the health banner in appOverview', () => {
    const c = book([tx()]);
    const overview = c.appOverview();

    expect(Object.keys(overview).sort()).toEqual(
      ['health', 'lists', 'month', 'pending', 'review', 'screens', 'trend']);
    expect(overview.lists.periods.map((p) => p.kind)).toContain('mtd');
  });

  /*
    The holds reach the dashboard on both calls that draw it, and they reach it
    at the top level rather than through `screens.records`.

    That distinction is the whole reason the field exists twice. `screens` seeds
    the Records *screen*, which has an account filter; the dashboard has none and
    must not inherit one. Reading the dashboard's holds off the prefetch would be
    correct on the first open and wrong the moment a filter was touched — which
    is a bug that never appears in a fresh book and always appears in a used one.
  */
  const withHold = (rows) => {
    const c = book(rows);
    const sheet = c.__spreadsheet.getSheetByName('pending');
    c.appendRows_(sheet, 1, [c.toRow_(c.PENDING_COLUMNS, {
      uid: 'p-1', account_id: 'acc-1', account_name: 'Revolut',
      booking_date: new Date(2026, 6, 22), amount: -18.4, currency: 'EUR',
      description: 'HOTEL BOOKING', source: 'enablebanking'
    })]);
    return c;
  };

  it('sends the holds to the dashboard, not only to Records', () => {
    const overview = withHold([tx()]).appOverview();

    expect(overview.pending.map((p) => p.description)).toEqual(['HOTEL BOOKING']);
    expect(overview.pending[0].pending).toBe(true);
  });

  it('sends them again on the call pull-to-refresh makes', () => {
    // You pull *because* a card payment has not shown up. A refresh that redrew
    // every number except the holds would be the worst version of this.
    expect(withHold([tx()]).appDashboard().pending.map((p) => p.description))
      .toEqual(['HOTEL BOOKING']);
  });

  it('reads the pending tab once for both of them', () => {
    // The top-level field is a second reference to the array `screens.records`
    // already holds, not a second trip to the tab. Same rows, same objects.
    const overview = withHold([tx()]).appOverview();
    expect(overview.pending).toEqual(overview.screens.records.pending);
  });

  it('sends an empty list rather than nothing when there are no holds', () => {
    // The page does `data.pending || []`, so this is belt and braces — but a
    // missing key and an empty list read the same in JS and differently in a
    // test, and only one of them is what the server means.
    expect(book([tx()]).appOverview().pending).toEqual([]);
    expect(book([tx()]).appDashboard().pending).toEqual([]);
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
    const c = book([tx()]);

    [c.appOpen(), c.appOverview()].forEach((payload) => {
      expect(payload.analytics).toBeUndefined();
      expect(payload.records).toBeUndefined();
    });
  });

  it('survives serialisation, because google.script.run has no choice', () => {
    const c = book([tx()]);

    [c.appOpen(), c.appOverview()].forEach((payload) => {
      expect(() => JSON.parse(JSON.stringify(payload))).not.toThrow();
    });
    expect(JSON.parse(JSON.stringify(c.appOverview())).month.from)
      .toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  /*
    The invariant is **a shared name means a shared window**, not "the phone
    offers a subset of the desktop". The two surfaces are different — a picker
    on a phone against two cells on a tab — and the phone has since gained a
    week, year-to-date and one entry per year in the ledger, none of which the
    reports tab has any way to offer.

    Written the other way round, this test missed the drift it existed to
    catch. Both sides had a **"This year"** and they did not agree: the tab's is
    `DATE(YEAR(TODAY()),1,1)` to `TODAY()`, which is year-to-date, and the
    phone's resolved to the whole calendar year including months that have not
    happened. Identical labels, different windows, and a test asserting only
    that the label existed on both. The phone's entry is now called "Year to
    date" and computes what that says — so the label is no longer shared, which
    is why the list below is the assertion rather than a subset check.
  */
  it('gives a period shared with the reports tab the same meaning', () => {
    const c = book([]);
    const onPhone = c.appOverview().lists.periods.map((p) => p.label);
    const onDesktop = c.REPORT_PERIODS.map((p) => p.label);

    const shared = onPhone.filter((label) => onDesktop.indexOf(label) !== -1);
    expect(shared.sort()).toEqual(['Custom', 'Last 12 months', 'Last month', 'This month']);

    // And the one that drifted must not come back by that name.
    expect(onPhone).not.toContain('This year');
    expect(onPhone).toContain('Year to date');
  });

  it('computes each shared period the way the reports tab describes it', () => {
    // The labels agreeing is half of it; this is the half that would have
    // caught "This year". Checked against the tab's own formulas, read as
    // intent rather than evaluated — the harness has no spreadsheet engine.
    const c = book([]);
    const now = new Date(2026, 7, 6, 12);
    const key = (spec) => {
      const w = c.resolveWindow_(spec, now);
      return [c.dayKey_(w.from), c.dayKey_(w.to)];
    };

    // EOMONTH(TODAY(),-1)+1 .. TODAY()
    expect(key({ kind: 'mtd' })).toEqual(['2026-08-01', '2026-08-06']);
    // EOMONTH(TODAY(),-2)+1 .. EOMONTH(TODAY(),-1)
    expect(key({ kind: 'last_month' })).toEqual(['2026-07-01', '2026-07-31']);
    // EOMONTH(TODAY(),-12)+1 .. TODAY()
    expect(key({ kind: 'last_12' })).toEqual(['2025-09-01', '2026-08-06']);
    // The tab's "This year": DATE(YEAR(TODAY()),1,1) .. TODAY()
    expect(key({ kind: 'ytd' })).toEqual(['2026-01-01', '2026-08-06']);
  });

  it('offers a subcategory with the parent it names, since that is one choice', () => {
    const c = book([]);
    const children = c.appOverview().lists.categories.children;
    const groceries = children.find((entry) => entry.name === 'Groceries');

    expect(groceries).toMatchObject({ parent: 'Food & Drink' });
    expect(groceries.icon).toBeTruthy();
  });

  it('works on a book with nothing in it at all', () => {
    const c = book([]);
    expect(() => c.appOpen()).not.toThrow();
    expect(() => c.appOverview()).not.toThrow();
    expect(c.appOverview().review).toEqual([]);
  });

  it('together offers every list the page reads', () => {
    // The lists are split across the two calls purely by which tab they come
    // from, so a name landing in neither is a filter that renders empty.
    const c = book([]);
    const sent = Object.keys(c.appOpen().lists)
      .concat(Object.keys(c.appOverview().lists)).sort();

    expect(sent).toEqual(['accounts', 'assetAccounts', 'cashAccounts',
      'categories', 'labels', 'periods']);
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
    const page = pageSource();
    const called = [...page.matchAll(/call\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]);

    expect(called.length).toBeGreaterThan(0);
    [...new Set(called)].forEach((name) => {
      expect(typeof c[name], name).toBe('function');
    });
  });

  it('writes no HTML entity in any partial, which is what makes one evidence', () => {
    // `checkPageAssembly_` calls the page broken when a partial arrives holding
    // `&lt;`, and that only means anything while no partial contains one to
    // begin with. It is a cheap premise to keep — the page builds nodes and
    // assigns `textContent`, so there is no markup here for an entity to be
    // part of — and an expensive one to lose, because losing it turns the one
    // live check on the assembly into a check that always passes.
    //
    // Asserted per file rather than over the assembly, so the failure names
    // the partial to look in.
    const partials = readdirSync(SRC)
      .filter((name) => name.startsWith('page.') && name !== 'page.html');

    expect(partials.length).toBeGreaterThan(10);
    partials.forEach((name) => {
      expect(readFileSync(join(SRC, name), 'utf8'), name).not.toMatch(/&(lt|gt|amp|quot|#\d+);/);
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
  const page = pageSource();

  /*
    This is the check that would have caught the change that removed the
    prefetch. The bootstrap stopped sending `analytics` and `records`; a page
    still reading `result.records.rows` would have thrown on open, and one
    reading `result.analytics` would have quietly drawn an empty chart.

    Both halves of the open are checked, because splitting one call into two is
    exactly the change that moves a key from one payload to the other and
    leaves the page reading it off the wrong one.
  */
  /*
    The consumer is not always the `.then` any more: `appOpen`'s payload can
    arrive inlined in the document instead of from a fetch, so both paths hand
    it to `applyOpen` and that is where the keys are read.
  */
  const CONSUMERS = {
    appOpen: () => {
      const from = page.indexOf('function applyOpen(');
      return page.slice(from, page.indexOf('\n  }', from));
    },
    appOverview: () => {
      const from = page.indexOf('function applyOverview(');
      return page.slice(from, page.indexOf('\n  }', from));
    }
  };

  Object.keys(CONSUMERS).forEach((name) => {
    it(`reads no key from ${name} that ${name} does not send`, () => {
      const handler = CONSUMERS[name]();
      expect(handler.length, `could not find where ${name} is consumed`).toBeGreaterThan(0);

      const used = [...handler.matchAll(/result\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
      expect(used.length).toBeGreaterThan(0);

      const sent = Object.keys(book([tx()])[name]());
      [...new Set(used)].forEach((key) => expect(sent, key).toContain(key));
    });
  });

  /*
    The two halves must not both claim a key, and between them must cover what
    the merged refresh sends — `appDashboard` distributes its result back into
    both, so a key in neither is a block that silently stops updating after a
    confirm.
  */
  it('splits the dashboard between the two calls without overlap or a gap', () => {
    const c = book([tx()]);

    // `lists` is the one key all three legitimately carry, which is why it is
    // exempt from the overlap rule rather than an exception to it: the two
    // halves each send the lists they are the cheap place to build, and the
    // merge sends both because the page distributes it into one `state.lists`.
    const shared = (result) => Object.keys(result).filter((k) => k !== 'lists');

    const open = shared(c.appOpen());
    const overview = shared(c.appOverview());

    open.forEach((key) => expect(overview, key).not.toContain(key));

    const merged = shared(c.appDashboard());
    merged.forEach((key) => expect(open.concat(overview), key).toContain(key));

    /*
      And the other direction, which is the one that had the gap.

      "No key in neither" was the half written, and it only rejects a merge
      sending something the boot never sent — the harmless direction. A key the
      *boot* sends and the merge does not is the damaging one: the page replaces
      its overview with this payload, so an omitted field is a block that was on
      the screen before you confirmed a row and is gone after. `trend` was
      exactly that, computed by `appOverviewData_` on this very path and dropped
      by the field list that copies out of it — the chart was deleted by the act
      of ticking a transaction.

      `screens` is the only exemption, and by construction rather than by taste:
      it is the first view of Records seeded into the boot, and a refresh that
      re-sent it would throw away the page someone had scrolled to.
    */
    overview.filter((key) => key !== 'screens').forEach((key) => {
      expect(merged, key).toContain(key);
    });
  });

  /*
    The refresh has to carry the lists that hold *values*, not only the ones
    that hold names.

    It used to carry none, and kept whatever `appOpen` had said at boot. That
    was right about `accounts` and `cashAccounts`, which are names and change
    monthly, and wrong about `assetAccounts`, which carries the balance the
    "Update balance" screen reads. Recording 3,000 → 4,500 moved the tile and
    left that screen offering 3,000 as *currently* — and since the field is now
    pre-filled from it, offering it as the new value too. Indistinguishable
    from the write having done nothing.
  */
  it('sends the balance-carrying lists back with a refresh', () => {
    const merged = book([tx()]).appDashboard();

    expect(merged.lists).toBeDefined();
    expect(Object.keys(merged.lists).sort())
      .toEqual(['accounts', 'assetAccounts', 'cashAccounts']);
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

/**
 * The ledger cache, and the invalidation the obvious design gets wrong.
 *
 * Every screen paid ~2,025ms to read the same 4,615 rows, so the ledger is
 * cached — chunked under the 100KB a cache key holds, keyed on a version that
 * every write bumps.
 *
 * **On the version, not the row count.** The row count is the obvious
 * fingerprint and it is blind to exactly the writes this app makes:
 * confirming a transaction sets column AB and appends nothing, so the count is
 * identical before and after. A cache keyed on it would serve the row you just
 * confirmed straight back to you, and the app's own writes would be the ones
 * it could not see. Same for a category override and every edit the review
 * queue exists to make.
 *
 * The tests below write through `appConfirm` rather than poking the sheet,
 * because going through the real entry point is the only way to prove the bump
 * is wired to the path a user actually takes.
 */
describe('the ledger cache', () => {
  /** Edit the sheet behind the cache's back, the way a desktop paste would. */
  function editDescriptionDirectly(c, row, text) {
    const sheet = c.__spreadsheet.getSheetByName('transactions');
    sheet.getRange(row, c.colIndex_(c.TX_COLUMNS, 'description')).setValue(text);
  }

  const descriptions = (c) => c.readLedger_().map((r) => r.description);

  it('serves a second read without going back to the sheet', () => {
    const c = book([tx({ uid: 'u-1', description: 'ORIGINAL' })]);
    expect(descriptions(c)).toEqual(['ORIGINAL']);

    editDescriptionDirectly(c, 2, 'CHANGED BEHIND ITS BACK');
    expect(descriptions(c)).toEqual(['ORIGINAL']);
  });

  /*
    The one the row count would have failed. Confirming writes AB and appends
    nothing at all, so a cache that fingerprints the size of the tab cannot
    tell this happened.
  */
  it('is invalidated by confirming a row, which changes no row count', () => {
    const c = book([tx({ uid: 'u-1', confirmed: '' })]);
    const sheet = c.__spreadsheet.getSheetByName('transactions');
    const before = c.lastRecordRow_(sheet, 1);

    expect(c.readLedger_()[0].confirmed).not.toBe(true);
    c.appConfirm([{ uid: 'u-1', confirmed: true }]);

    expect(c.lastRecordRow_(sheet, 1)).toBe(before);
    expect(c.readLedger_()[0].confirmed).toBe(true);
  });

  it('is invalidated by a category override, for the same reason', () => {
    const c = book([tx({ uid: 'u-1' })]);
    expect(c.readLedger_()[0].category_override).toBe('');

    c.appConfirm([{ uid: 'u-1', category_override: 'Housing' }]);
    expect(c.readLedger_()[0].category_override).toBe('Housing');
  });

  it('is invalidated by an append, which the row count would have caught', () => {
    const c = book([tx({ uid: 'u-1' })]);
    expect(c.readLedger_()).toHaveLength(1);

    const sheet = c.__spreadsheet.getSheetByName('transactions');
    c.appendRows_(sheet, 1, [c.toRow_(c.TX_COLUMNS_CODE, tx({ uid: 'u-2' }))]);
    expect(c.readLedger_()).toHaveLength(2);
  });

  /*
    A pull to refresh is a request whose whole meaning is "I do not believe
    what is on screen". Answering it from the cache would repeat the answer
    being disbelieved, and there is no second thing to try.
  */
  it('goes to the sheet for a pull to refresh', () => {
    const c = book([tx({ uid: 'u-1', description: 'ORIGINAL', amount_base: -5 })]);
    c.appDashboard(true);

    editDescriptionDirectly(c, 2, 'EDITED ON THE DESKTOP');
    c.appDashboard(true);

    expect(descriptions(c)).toEqual(['EDITED ON THE DESKTOP']);
  });

  it('does not go to the sheet after an ordinary write', () => {
    // The same call serves a pull-to-refresh and every write, and only one of
    // them means "I do not believe what is on screen". Forgetting the cache on
    // a write rebuilt the whole ledger per confirmation — and three
    // confirmations in a row queued three of those, which is what the client
    // bridge gives up on with `http connection failure 0`.
    //
    // A write does not need it: `writeCell_` bumps `transactions_version`,
    // which invalidates the cache by construction. This edits the sheet
    // *behind* that mechanism, which is the one case a cache is allowed to
    // miss, and asserts it is not paid for on every tap.
    const c = book([tx({ uid: 'u-1', description: 'ORIGINAL', amount_base: -5 })]);
    c.appDashboard();

    editDescriptionDirectly(c, 2, 'EDITED ON THE DESKTOP');

    expect(descriptions(c)).toEqual(['ORIGINAL']);
  });

  /*
    Chunks expire independently. Concatenating around a hole parses into a
    shorter ledger that is entirely valid JSON and quietly missing rows — so a
    hole has to be a miss.
  */
  it('treats a missing chunk as a miss, not as a shorter ledger', () => {
    const c = book([tx({ uid: 'u-1', description: 'ORIGINAL' })]);
    c.readLedger_();

    [...c.__cache.keys()].filter((k) => k.endsWith(':0')).forEach((k) => c.__cache.delete(k));
    editDescriptionDirectly(c, 2, 'FRESH');

    expect(descriptions(c)).toEqual(['FRESH']);
  });

  /*
    Dropping only the `:n` key used to be enough, on the grounds that orphaned
    chunks expire by themselves. That was true at a five-minute TTL and false
    at six hours, where 3.7MB of unreachable ledger sits in a cache that evicts
    under pressure — and what it evicts is the ledger still in use.
  */
  it('removes the chunks it orphans, not just the count', () => {
    const c = book([tx({ uid: 'u-1' })]);
    c.readLedger_();
    expect([...c.__cache.keys()].length).toBeGreaterThan(1);

    c.forgetLedgerCache_();

    expect([...c.__cache.keys()]).toEqual([]);
  });

  /*
    `ledgerFirst` in the diagnostic is a forced miss, so it can never say
    whether a ledger survived from the last time the app was opened — which is
    the only question a TTL raises. This is what answers it, and it has to
    count the chunks: `:n` present with a chunk missing is a ledger that reads
    as cached and misses on every fetch.
  */
  it('reports the cache state without disturbing it', () => {
    const c = book([tx({ uid: 'u-1' })]);
    expect(c.ledgerCacheState_().cached).toBe(false);

    c.readLedger_();
    const warm = c.ledgerCacheState_();
    expect(warm.cached).toBe(true);
    expect(warm.present).toBe(warm.chunks);

    // Still readable afterwards — a probe that empties the cache is useless.
    expect(c.ledgerCacheState_().cached).toBe(true);
  });

  it('reports a hole rather than calling a broken cache warm', () => {
    const c = book([tx({ uid: 'u-1' })]);
    c.readLedger_();
    [...c.__cache.keys()].filter((k) => k.endsWith(':0')).forEach((k) => c.__cache.delete(k));

    const state = c.ledgerCacheState_();
    expect(state.cached).toBe(true);
    expect(state.present).toBeLessThan(state.chunks);
  });

  /*
    A hit comes back through JSON, where a Date is an ISO string. If a miss
    returned real Dates the two paths would disagree, and the symptom would be
    "it works until it has been open five minutes".
  */
  it('returns the same shape whether it hit or missed', () => {
    const c = book([tx({ uid: 'u-1' })]);
    const miss = c.readLedger_()[0];
    const hit = c.readLedger_()[0];

    expect(typeof miss.booking_date).toBe('string');
    expect(hit.booking_date).toBe(miss.booking_date);
    expect(Object.keys(hit).sort()).toEqual(Object.keys(miss).sort());
  });

  it('still answers when the cache refuses to store anything', () => {
    const c = book([tx({ uid: 'u-1' })]);
    c.CacheService.getScriptCache = () => { throw new Error('no cache today'); };

    expect(c.readLedger_()).toHaveLength(1);
    expect(c.appDashboard().month).toBeDefined();
  });
});

/**
 * The per-request read cache.
 *
 * Counted rather than timed, because a round trip is what a spreadsheet read
 * costs and the harness has no spreadsheet to time. The measurement that
 * prompted this is in `describeDashboardCost`: 35 `getValues` over 7 tabs,
 * ~175ms each, and only the ledger of them had a cache.
 *
 * Two of these tests are about speed and three are about not being wrong,
 * which is the correct ratio for a cache.
 */
/**
 * The first screen, templated into the document instead of fetched.
 *
 * Measured from outside the sandboxed iframe: a `google.script.run` call costs
 * ~2,700ms of Apps Script startup before any of our code runs, and `doGet` is
 * an execution that has already paid it. So the top of the dashboard rides
 * along with the page.
 *
 * Two things can go wrong and both are tested here: the payload escaping out
 * of its `<script>` element, and the payload being absent in a way that leaves
 * a blank screen rather than a fetch.
 */
describe('the first screen', () => {
  it('is served with no data in it at all', () => {
    /*
      The document is the shell and nothing else, which is what lets it arrive
      in ~2,400ms — measured against a `doGet` doing no work: 2,457/2,425/2,102ms
      to `domcontentloaded`. What fills it is the page's own stored copy, drawn
      before anything is asked for; see `hydrate` in `page.boot`.

      The view is the exception and stays, because it is not data — it is what
      *this URL* asked to see, and the alternative is reading the parent
      location asynchronously and drawing the wrong filters first.
    */
    const c = book([tx()]);
    const html = c.webAppHtml_().getContent();

    expect(html).not.toContain('id="boot"');
    expect(html).toContain('id="view"');
    expect(html).not.toContain('<?!=');          // the scriptlets were evaluated
  });

  it('carries the first view of Records and Charts, keyed on the server defaults', () => {
    // The prefetch is back and the page must not decide what "first view"
    // means, or it draws one slice while holding another.
    const c = book([tx()]);
    const screens = c.appOverview().screens;

    expect(screens.filters.records.period.kind).toBe('ytd');
    expect(screens.filters.analytics.period.kind).toBe('mtd');
    expect(screens.records.rows).toBeInstanceOf(Array);
  });

  it('ships the drill filters off rather than absent, because the page assigns the object whole', () => {
    // `applyOverview` does `state.filters.records = result.screens.filters.records`,
    // so a shape short of a key is a shape that drops one. Nothing here ever
    // sets these — they arrive by tapping a number on Charts — but the two
    // shapes have to match.
    const records = book([tx()]).appOverview().screens.filters.records;

    expect(records.spendOnly).toBe(false);
    expect(records.category).toBe('All');
    expect(records.subcategory).toBe('All');
  });

  it('does not precompute Charts, which is not free and not always opened', () => {
    // Measured, best of two against the live app, with appOpen as the fixed
    // round-trip floor: appRecords 2,225ms for 33KB — below the floor, so its
    // work is nil — against appAnalytics 3,045ms for 2KB, which is ~800ms of
    // `balanceSeries_` walking the whole ledger. Paying that on every open to
    // save a trip on a screen opened sometimes is the wrong way round.
    const screens = book([tx()]).appOverview().screens;

    expect(screens.analytics).toBeUndefined();
    expect(screens.filters.analytics).toBeDefined();   // the default still ships
  });

  it('is fetched in two calls, whatever the page already had', () => {
    /*
      The cache buys the *wait*, never the call. A hydrated screen that skipped
      the fetch would be a screen that is never right again — so both round
      trips are unconditional, and the stored copy stands in front of them
      rather than instead of them.

      Asserted as text because the page is invisible to the harness. What that
      can prove is that the two calls are still issued and are not sitting
      behind a condition, which is the shape this mistake would take.
    */
    const page = pageSource();

    expect(page).toContain("whileRefreshing('open', callOrRetry('appOpen'))");
    expect(page).toContain("whileRefreshing('overview', callOrRetry('appOverview'))");
  });

  it('draws what it already holds before it asks for anything', () => {
    const page = pageSource();

    expect(page).toContain('function hydrate()');
    expect(page).toContain('cacheRead()');
    // The write-back, without which the first open is the only fast one.
    expect(page).toContain('cacheWrite(');
  });

  it('discards a stored copy whose shape it does not recognise', () => {
    // A deploy that renames a field would otherwise hydrate a screen out of a
    // shape this code cannot read, from a store nobody holding the phone can
    // clear. The version is checked on the way in and a mismatch drops the
    // whole thing rather than merging what still fits.
    expect(pageSource()).toMatch(/held\.v !== CACHE_SHAPE/);
  });

  it('forgets the stored copy when the owner gate refuses', () => {
    // What is stored belongs to whoever was signed in when it was written.
    // Left alone it would paint their balances again on the next reload, ahead
    // of the refusal that is the entire point of the gate.
    const failed = pageSource().match(/function openFailed\(error\) \{[\s\S]*?\n  \}/);

    expect(failed, 'page.boot no longer declares openFailed').not.toBeNull();
    expect(failed[0]).toContain('cacheForget()');
  });

  /*
    The deep link, and the one thing a file test can prove about it.

    The page writes the query string and `20_webapp.gs` reads it back, and there
    is no handshake between them — a parameter renamed on one side only would
    keep working for the length of a session and lose the filters on the first
    refresh, which is precisely the case nobody tries. `page.html` is invisible
    to the harness, so the names are compared as text against the constants the
    server actually uses.
  */
  /*
    The one subcategory a Records row does not print.

    `recordRow` names a row by its subcategory, and treats the seed's
    `Other › Uncategorised` as if there were none, falling back to `Other` —
    because that child is a real category a rule or an import chose, and
    printing "Uncategorised" on it reads as a row nothing ever answered. The
    page holds the name as a literal, which is a copy of the seed with no
    handshake between them: rename the seed row and the label comes back with
    every test still green. This is the handshake.
  */
  describe('the placeholder subcategory the page hides', () => {
    it('is the only child the seed gives Other', () => {
      const declared = pageSource().match(/var PLACEHOLDER_SUBCATEGORY = '([^']*)';/);
      expect(declared, 'the page no longer declares PLACEHOLDER_SUBCATEGORY').not.toBeNull();

      const other = load().DEFAULT_CATEGORIES.filter((row) => row[0] === 'Other');
      expect(other.map((row) => row[1])).toEqual([declared[1]]);
    });
  });

  describe('the query string the page writes', () => {
    const page = pageSource();

    const written = (() => {
      const block = page.match(/var VIEW_PARAMS = \{([\s\S]*?)\};/);
      expect(block, 'page.html no longer declares VIEW_PARAMS').not.toBeNull();
      return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    })();

    it('is spelled the same on both sides', () => {
      const c = load();
      const read = [c.WEBAPP_VIEW_PARAM, c.WEBAPP_PERIOD_PARAM, c.WEBAPP_FROM_PARAM,
        c.WEBAPP_TO_PARAM, c.WEBAPP_ACCOUNT_PARAM, c.WEBAPP_LABEL_PARAM,
        c.WEBAPP_SEARCH_PARAM, c.WEBAPP_UNCONFIRMED_PARAM].sort();

      expect(written).toEqual(read);
    });

    it('offers the same screens the server will accept', () => {
      // `NAV` is what the page will restore to and what it will write; anything
      // outside it is a URL the server answers and the page then ignores.
      const nav = page.match(/var NAV = \[([^\]]*)\]/);
      const screens = [...nav[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

      expect(screens).toEqual(load().WEBAPP_SCREENS);
    });

    it('reads the view the server templates in, by the id it templates it as', () => {
      expect(page).toContain("document.getElementById('view')");
      expect(page).toContain('id="view"');

      // The one assertion here that wants the *template* rather than the
      // assembly: `pageSource` fills the scriptlets, which is the whole of what
      // it is for, so the placeholder it is asked about is gone by then.
      expect(readFileSync(join(SRC, 'page.html'), 'utf8')).toContain('<?!= view ?>');
    });

    it('writes the URL on both of the two ways a view changes', () => {
      // A screen change and a filter change. A URL that is right most of the
      // time is one you cannot trust enough to bookmark.
      expect(page).toMatch(/function go\(id\) \{[\s\S]*?rememberView\(\)/);
      expect(page).toMatch(/function refreshCurrentScreen\(\) \{[\s\S]*?rememberView\(\)/);
    });

    it('goes through the API that reaches the parent frame', () => {
      // `window.location` here is the sandboxed `userCodeAppPanel` URL, which
      // nothing ever reloads. `google.script.history` is the only route to the
      // `/exec` address a refresh actually re-requests.
      expect(page).toContain('google.script.history.replace');
    });
  });

  /*
    The third thing a *file* test can prove about the page, beside "no string is
    assigned as markup" and "every name it calls exists": that it parses at all.

    Worth having because of what the failure looks like. `page.html` is the one
    file `node:vm` never loads, so a stray bracket in it passes `npm test`,
    passes `clasp push`, and reaches the phone as a blank white screen with the
    error in a console no phone opens — indistinguishable from the owner gate
    refusing, or from Apps Script being slow.

    Parsing only. This deliberately does not *run* it: the script is an IIFE
    that reaches for `document` on its first line, and faking the DOM to the
    depth this page uses would be a second implementation of a browser in
    service of testing drawing, which is the trade the header above rejects.
  */
  /*
    The inverse of the two checks above, and the gap they left.

    They ask "does the page read a key the server stopped sending". This asks
    "does the server send a list the page never picks up" — which is what
    happened to `assetAccounts`: added to `appOpenData_`, asserted in a test,
    serialised over the wire, and dropped on the floor by `applyOpen`, so the
    Set-value action and the transfer destination picker were both silently
    absent. Nothing failed. The list was simply never there.

    Scoped to `lists` because that is the shape with a fixed home: every one of
    them lands in `state.lists.<name>` and is read by name.
  */
  it('picks up every list the two calls send', () => {
    const page = pageSource();
    const c = book([]);

    const sent = Object.keys(c.appOpen().lists)
      .concat(Object.keys(c.appOverview().lists));

    sent.forEach((name) => {
      expect(page, `${name} is sent but never assigned into state.lists`)
        .toContain(`state.lists.${name} =`);
    });
  });

  it('parses as JavaScript', () => {
    const page = pageSource();
    const script = page.slice(page.lastIndexOf('<script>') + '<script>'.length,
      page.lastIndexOf('</script>'));

    expect(script.length, 'no script block found in page.html').toBeGreaterThan(1000);
    // `new Function` compiles without executing, which is exactly the line
    // this test wants to sit on.
    expect(() => new Function(script)).not.toThrow();
  });
});

describe('the per-request read cache', () => {
  /** A book with an account and a consent on it, so every tab has rows to read. */
  const stocked = () => {
    const c = book([tx()]);
    c.appendRows_(c.__spreadsheet.getSheetByName('accounts'), 1, [
      c.toRow_(c.ACCOUNT_COLUMNS, { account_id: 'b', name: 'Revolut', kind: 'bank',
        currency: 'EUR', balance: 100, active: true, include_in_net_worth: true,
        connection_id: 'c-1' })
    ]);
    c.appendRows_(c.__spreadsheet.getSheetByName('_status'), 1, [
      c.toRow_(c.STATUS_COLUMNS, { connection_id: 'c-1', provider: 'Revolut', days_left: 60 })
    ]);
    return c;
  };

  it('reads each tab once for a whole call', () => {
    // `accounts` was fetched four times by four functions that each went and
    // got it for themselves — `appAccounts_`, `netWorthNow_`, `accountNames_`
    // and `cashAccountList_` — and `_config` eight times. Neither is visible
    // at any one call site, which is why this is asserted rather than reviewed.
    const c = stocked();
    c.__resetReads();
    c.appOpen();

    expect(c.__reads('accounts')).toBe(2);   // lastRecordRow_, then the block
    expect(c.__reads('_config')).toBe(2);
    expect(c.__reads('_status')).toBe(2);
  });

  it('is off unless a read-only request switched it on', () => {
    // The default has to be off. `setup()` and the sync write a cell and read
    // it back, repeatedly, and a memo that is always on turns that into a
    // silently stale answer — the worst failure this project has.
    const c = stocked();
    c.__resetReads();
    c.readConfig_();
    c.readConfig_();

    expect(c.__reads('_config')).toBe(4);
  });

  it('does not hand two callers the same record objects', () => {
    // The values are shared; the records built from them are not. Sharing the
    // objects means a field one caller sets appears in another's copy, which
    // surfaces a month later on one tab and is untraceable when it does.
    const c = stocked();
    const sheet = c.__spreadsheet.getSheetByName('accounts');

    c.withReadCache_(() => {
      const first = c.readRecords_(sheet, c.ACCOUNT_COLUMNS, 1);
      const second = c.readRecords_(sheet, c.ACCOUNT_COLUMNS, 1);
      expect(first[0]).not.toBe(second[0]);

      first[0].name = 'mutated';
      expect(second[0].name).not.toBe('mutated');
    });
  });

  it('forgets what it read as soon as anything is written', () => {
    const c = stocked();
    const sheet = c.__spreadsheet.getSheetByName('accounts');

    c.withReadCache_(() => {
      const before = c.readRecords_(sheet, c.ACCOUNT_COLUMNS, 1);
      c.writeCell_(sheet, before[0]._row, c.ACCOUNT_COLUMNS, 'name', 'Renamed');

      expect(c.readRecords_(sheet, c.ACCOUNT_COLUMNS, 1)[0].name).toBe('Renamed');
    });
  });

  it('leaves the writing endpoints unmemoised', () => {
    // `appConfirm` and `appAddCash` read, write, and read again. They are the
    // 22 half of the seam and they deliberately do not switch the cache on —
    // asserted by reading the file, because the failure is a wrapper somebody
    // adds later for symmetry.
    const api = readFileSync(join(SRC, '23_api.gs'), 'utf8');

    ['appConfirm', 'appAddCash'].forEach((name) => {
      const body = api.slice(api.indexOf(`function ${name}(`));
      expect(body.slice(0, body.indexOf('\n}')), name).not.toContain('withReadCache_');
    });
  });
});
