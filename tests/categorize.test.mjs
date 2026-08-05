/**
 * The categorisation cascade.
 *
 * Most of this file is about `normalizeMerchant`, and that is the right shape:
 * tier 3 is the only tier whose output is a *derived key* rather than a lookup,
 * so it is the only one where being subtly wrong produces a plausible answer.
 * Every other tier either matches or does not.
 *
 * The two behaviours worth stating up front, because both are deliberate and
 * both look like bugs until you know why:
 *
 *   - the key keeps the city (`esselunga torino`), and the *lookup* bridges to
 *     a shorter learned key by containment. Stripping cities out of the key
 *     would be a silent, permanent merge of two merchants the day it guessed
 *     wrong.
 *   - `coop` survives noise-stripping despite being a legal form, because it is
 *     also one of the largest supermarket chains in Italy.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();

describe('normalizeMerchant', () => {
  const key = (description, counterparty) => ctx.normalizeMerchant(description, counterparty);

  it('reduces a full Italian POS descriptor to the merchant', () => {
    // The example from the design doc, and the shape most card rows arrive in.
    expect(key('PAGAMENTO POS 12/03 CARTA *1234 ESSELUNGA SPA TORINO')).toBe('esselunga torino');
  });

  it('strips dates, times and card references in the several shapes banks use', () => {
    expect(key('PAGAMENTO TRAMITE POS 25/07/2026 14:32 CARTA 1234 NETFLIX')).toBe('netflix');
    expect(key('ACQUISTO 01-02-26 ORE 09:15 SPOTIFY')).toBe('spotify');
    expect(key('OPERAZIONE 3.4.2026 CARTA N. 5678 IKEA')).toBe('ikea');
  });

  it('drops store numbers and authorisation codes but keeps names with a digit in them', () => {
    // Three digits is where a token stops being a name. Q8 and A2A are real
    // merchants; 4534 is a till.
    expect(key('ESSELUNGA 4534 MILANO')).toBe('esselunga milano');
    expect(key('DISTRIBUTORE Q8 RIVOLI')).toBe('distributore q8 rivoli');
    expect(key('A2A ENERGIA')).toBe('a2a energia');
  });

  it('keeps COOP, which is a supermarket as well as a legal form', () => {
    // Stripping it with the other suffixes would erase hundreds of rows of a
    // real history, and the resulting key would still look plausible.
    expect(key('PAGAMENTO POS COOP LOMBARDIA')).toBe('coop lombardia');
    expect(key('ROSSI SRL')).toBe('rossi');
    expect(key('MUELLER GMBH')).toBe('mueller');
  });

  it('folds accents, so città and citta are one merchant', () => {
    expect(key('CAFFÈ CENTRALE')).toBe(key('CAFFE CENTRALE'));
  });

  it('prefers the counterparty when the bank filled it with a name', () => {
    expect(key('PAGAMENTO POS 12/03 CARTA *1234 ESSELUNGA TORINO', 'Esselunga S.p.A.'))
      .toBe('esselunga');
  });

  it('ignores a counterparty that is an account number, not a name', () => {
    // counterpartyName() falls back to an IBAN when there is no name, and an
    // IBAN is per-payer — using it would give almost every row its own key and
    // memory would never accumulate a second hit on anything.
    expect(key('BONIFICO STIPENDIO ACME', 'IT60X0542811101000000123456')).toBe('stipendio acme');
    expect(key('VERSAMENTO ACME', '00000012345678')).toBe('versamento acme');
  });

  it('returns nothing rather than a junk key when there is nothing to work with', () => {
    expect(key('', '')).toBe('');
    expect(key('12/03 *1234')).toBe('');
    expect(key(null, undefined)).toBe('');
  });

  it('is stable under the noise that varies between two visits to one merchant', () => {
    const a = key('PAGAMENTO POS 12/03 CARTA *1234 ESSELUNGA SPA TORINO');
    const b = key('PAGAMENTO POS 28/06 CARTA *1234 ESSELUNGA S.P.A. TORINO');
    expect(a).toBe(b);
  });

  it('bounds the key length so one rambling description cannot dominate', () => {
    const long = key('BONIFICO ALFA BETA GAMMA DELTA EPSILON ZETA ETA THETA IOTA');
    expect(long.split(' ')).toHaveLength(6);
  });
});

describe('memory lookup', () => {
  const index = (entries) => ctx.buildMemoryIndex_(entries);

  it('takes an exact key first', () => {
    const memory = index([
      { merchant_key: 'esselunga', category: 'Food & Drink', subcategory: 'Groceries', hits: 40 }
    ]);
    expect(ctx.lookupMemory_('esselunga', memory).category).toBe('Food & Drink');
  });

  it('bridges an imported key to a longer bank key by containment', () => {
    // This is what makes the BudgetBakers history pay off. Their export says
    // `Esselunga`; the bank says `PAGAMENTO POS ... ESSELUNGA SPA TORINO`. The
    // keys differ and the merchant does not.
    const memory = index([
      { merchant_key: 'esselunga', category: 'Food & Drink', subcategory: 'Groceries', hits: 40 }
    ]);
    expect(ctx.lookupMemory_('esselunga torino', memory).category).toBe('Food & Drink');
  });

  it('matches whole words only, so a key never lands inside another word', () => {
    const memory = index([
      { merchant_key: 'eatery', category: 'Food & Drink', subcategory: 'Restaurants', hits: 5 }
    ]);
    expect(ctx.lookupMemory_('greateryard supplies', memory)).toBe(null);
  });

  it('prefers the longest match when two keys both fit', () => {
    const memory = index([
      { merchant_key: 'just', category: 'Other', subcategory: 'Uncategorised', hits: 2 },
      { merchant_key: 'just eat', category: 'Food & Drink', subcategory: 'Delivery', hits: 30 }
    ]);
    expect(ctx.lookupMemory_('just eat milano', memory).category).toBe('Food & Drink');
  });

  it('refuses to match a very short key by containment', () => {
    // `q8` inside `q8 rivoli` is fine as an exact key and dangerous as a
    // substring — three characters of coincidence is not evidence.
    const memory = index([
      { merchant_key: 'q8', category: 'Transport', subcategory: 'Fuel', hits: 9 }
    ]);
    expect(ctx.lookupMemory_('q8', memory).category).toBe('Transport');
    expect(ctx.lookupMemory_('q8 rivoli', memory)).toBe(null);
  });

  it('skips an entry with no category, which would categorise a row as blank', () => {
    const memory = index([{ merchant_key: 'mystery', category: '', subcategory: '', hits: 3 }]);
    expect(ctx.lookupMemory_('mystery', memory)).toBeFalsy();
  });
});

describe('rule matching', () => {
  const rule = (over = {}) => Object.assign({
    priority: 100, field: 'description', match_type: 'contains', pattern: 'ESSELUNGA',
    account_filter: '', category: 'Food & Drink', subcategory: 'Groceries',
    type: 'expense', enabled: true
  }, over);

  const record = (over = {}) => Object.assign({
    description: 'PAGAMENTO POS ESSELUNGA TORINO', counterparty: '', mcc: '',
    account_id: 'revolut', account_name: 'Revolut', bank_transaction_code: ''
  }, over);

  it('matches contains, equals, starts_with and regex', () => {
    expect(ctx.ruleMatches_(record(), rule())).toBe(true);
    expect(ctx.ruleMatches_(record({ mcc: '5411' }),
      rule({ field: 'mcc', match_type: 'equals', pattern: '5411' }))).toBe(true);
    expect(ctx.ruleMatches_(record(), rule({ match_type: 'starts_with', pattern: 'PAGAMENTO' }))).toBe(true);
    expect(ctx.ruleMatches_(record(), rule({ match_type: 'regex', pattern: 'ESSE\\w+GA' }))).toBe(true);
  });

  it('ignores case, because a bank changing its capitalisation is not a new merchant', () => {
    expect(ctx.ruleMatches_(record({ description: 'pagamento pos esselunga' }), rule())).toBe(true);
  });

  it('honours an account filter by id or by name', () => {
    expect(ctx.ruleMatches_(record(), rule({ account_filter: 'revolut' }))).toBe(true);
    expect(ctx.ruleMatches_(record(), rule({ account_filter: 'Revolut' }))).toBe(true);
    expect(ctx.ruleMatches_(record(), rule({ account_filter: 'fineco' }))).toBe(false);
  });

  it('matches nothing when the field name is a typo', () => {
    // The dangerous alternative is returning '' for an unknown field, which
    // makes `contains ""` true for every row — one typo recategorising the
    // whole sheet, quietly.
    expect(ctx.ruleMatches_(record(), rule({ field: 'descriptoin' }))).toBe(false);
  });

  it('survives a half-typed regex instead of breaking the run that reads it', () => {
    expect(ctx.ruleMatches_(record(), rule({ match_type: 'regex', pattern: '([' }))).toBe(false);
  });

  it('never matches on an empty pattern', () => {
    expect(ctx.ruleMatches_(record(), rule({ pattern: '' }))).toBe(false);
  });
});

describe('transfer detection', () => {
  const context = { transferWindowDays: 4, kindByCategory: { Transfer: 'transfer', Housing: 'expense' } };

  const leg = (over = {}) => Object.assign({
    uid: 'u' + Math.random(), account_id: 'a', amount: -100,
    booking_date: new Date(2026, 4, 10), category_override: ''
  }, over);

  it('pairs equal and opposite legs in different accounts', () => {
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250 });
    const inn = leg({ uid: 'in', account_id: 'revolut', amount: 250 });

    expect(ctx.detectTransfers_([out, inn], context)).toBe(1);
    expect(out._transferGroup).toBe('tr:out');
    expect(inn._transferGroup).toBe('tr:out');
  });

  it('pairs across the window a real export actually needed', () => {
    // The two legs of one move were three days apart in the BudgetBakers
    // export this was built against. A same-day-only rule would have found none.
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250 });
    const inn = leg({ uid: 'in', account_id: 'revolut', amount: 250,
      booking_date: new Date(2026, 4, 13) });

    expect(ctx.detectTransfers_([out, inn], context)).toBe(1);
  });

  it('leaves legs further apart than the window alone', () => {
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250 });
    const inn = leg({ uid: 'in', account_id: 'revolut', amount: 250,
      booking_date: new Date(2026, 4, 20) });

    expect(ctx.detectTransfers_([out, inn], context)).toBe(0);
    expect(out._transferGroup).toBe('');
  });

  it('never pairs a debit and credit inside one account', () => {
    // That is a correction or a reversal, not a move.
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250 });
    const inn = leg({ uid: 'in', account_id: 'fineco', amount: 250 });

    expect(ctx.detectTransfers_([out, inn], context)).toBe(0);
  });

  it('pairs the nearest candidate and uses each row at most once', () => {
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250 });
    const far = leg({ uid: 'far', account_id: 'revolut', amount: 250,
      booking_date: new Date(2026, 4, 13) });
    const near = leg({ uid: 'near', account_id: 'revolut', amount: 250,
      booking_date: new Date(2026, 4, 11) });

    expect(ctx.detectTransfers_([out, far, near], context)).toBe(1);
    expect(near._transferGroup).toBe('tr:out');
    expect(far._transferGroup).toBe('');
  });

  it('gives a pair the same group id on every run', () => {
    // A churning group id would make transfer_group useless to anything that
    // remembers it, and it would rewrite two cells on every sync for nothing.
    const build = () => [
      leg({ uid: 'out', account_id: 'fineco', amount: -250 }),
      leg({ uid: 'in', account_id: 'revolut', amount: 250 })
    ];

    const first = build();
    const second = build();
    ctx.detectTransfers_(first, context);
    ctx.detectTransfers_(second, context);
    expect(first[0]._transferGroup).toBe(second[0]._transferGroup);
  });

  it('leaves a row you categorised as something other than a transfer alone', () => {
    // Your override outranks this tier, so marking it anyway would leave a
    // transfer_group contradicting the category next to it.
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250, category_override: 'Housing' });
    const inn = leg({ uid: 'in', account_id: 'revolut', amount: 250 });

    expect(ctx.detectTransfers_([out, inn], context)).toBe(0);
  });

  it('still pairs a row you categorised as a transfer', () => {
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250, category_override: 'Transfer' });
    const inn = leg({ uid: 'in', account_id: 'revolut', amount: 250 });

    expect(ctx.detectTransfers_([out, inn], context)).toBe(1);
  });

  it('does not pair amounts that merely round to the same figure', () => {
    const out = leg({ uid: 'out', account_id: 'fineco', amount: -250.01 });
    const inn = leg({ uid: 'in', account_id: 'revolut', amount: 250 });

    expect(ctx.detectTransfers_([out, inn], context)).toBe(0);
  });
});

describe('the cascade order', () => {
  const context = () => ({
    memory: ctx.buildMemoryIndex_([
      { merchant_key: 'esselunga', category: 'Food & Drink', subcategory: '', hits: 40 }
    ]),
    mccRules: [{ priority: 10, field: 'mcc', match_type: 'equals', pattern: '5411',
      category: 'Food & Drink', subcategory: 'Groceries', enabled: true }],
    textRules: [{ priority: 100, field: 'description', match_type: 'contains', pattern: 'NETFLIX',
      category: 'Entertainment', subcategory: 'Streaming', enabled: true }],
    kindByCategory: { Transfer: 'transfer' },
    transferWindowDays: 4
  });

  const record = (over = {}) => Object.assign({
    description: '', counterparty: '', mcc: '', account_id: 'a', account_name: 'A',
    category_override: '', bank_transaction_code: '', _transferGroup: ''
  }, over);

  it('puts a matched transfer above everything a rule could say', () => {
    const verdict = ctx.categorizeOne_(
      record({ description: 'NETFLIX', _transferGroup: 'tr:x' }), context());
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.TRANSFER);
    expect(verdict.category).toBe('Transfer');
  });

  it('puts memory above MCC', () => {
    const verdict = ctx.categorizeOne_(
      record({ description: 'ESSELUNGA TORINO', mcc: '5411' }), context());
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.MEMORY);
  });

  it('lets a rule supply the subcategory memory learned without', () => {
    // An imported row carries its category in category_override and its
    // subcategory nowhere, so memory built from history knows parents. Throwing
    // away a rule's subcategory when it agrees about the parent would make
    // tier 3 *lose* detail tier 4 already had.
    const verdict = ctx.categorizeOne_(
      record({ description: 'ESSELUNGA TORINO', mcc: '5411' }), context());
    expect(verdict.category).toBe('Food & Drink');
    expect(verdict.subcategory).toBe('Groceries');
  });

  it('does not borrow a subcategory from a rule that disagrees about the parent', () => {
    const verdict = ctx.categorizeOne_(
      record({ description: 'ESSELUNGA TORINO NETFLIX' }), context());
    expect(verdict.category).toBe('Food & Drink');
    expect(verdict.subcategory).toBe('');
  });

  it('falls through to a text rule when nothing above it fires', () => {
    const verdict = ctx.categorizeOne_(record({ description: 'NETFLIX.COM' }), context());
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.RULE);
    expect(verdict.subcategory).toBe('Streaming');
  });

  it('lands unclassified rather than in "Other"', () => {
    // "Other" is where miscategorised spending goes to die. Unclassified is a
    // queue that shrinks; Other is a total nobody questions.
    const verdict = ctx.categorizeOne_(record({ description: 'QUALCOSA DI NUOVO' }), context());
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.UNCLASSIFIED);
    expect(verdict.category).toBe('');
  });

  it('marks the source as override while still recording what it would have guessed', () => {
    // The guess stays visible in category_auto, which is how a rule worth
    // adding gets noticed. What the sheet displays is unaffected — the
    // `category` formula takes the override whenever there is one.
    const verdict = ctx.categorizeOne_(
      record({ description: 'NETFLIX.COM', category_override: 'Housing' }), context());
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.OVERRIDE);
    expect(verdict.category).toBe('Entertainment');
  });
});

describe('deriveMemory_', () => {
  const row = (over = {}) => Object.assign({
    description: 'PAGAMENTO POS ESSELUNGA TORINO', counterparty: '',
    booking_date: new Date(2026, 4, 10), confirmed: true,
    category: 'Food & Drink', subcategory: 'Groceries',
    category_override: '', category_auto: '', subcategory_auto: ''
  }, over);

  it('learns only from confirmed rows', () => {
    // The whole point. Learning from every row trains the cascade on its own
    // output, and one wrong guess about a frequent merchant reinforces itself.
    const derived = ctx.deriveMemory_([row({ confirmed: false })]);
    expect(derived.entries).toHaveLength(0);
  });

  it('counts an override as confirmation without the tick', () => {
    const derived = ctx.deriveMemory_([
      row({ confirmed: false, category: '', category_override: 'Housing' })
    ]);
    expect(derived.entries[0].category).toBe('Housing');
  });

  it('keeps the category given most often, not the most recent', () => {
    const derived = ctx.deriveMemory_([
      row({ category: 'Food & Drink' }),
      row({ category: 'Food & Drink' }),
      row({ category: 'Shopping', booking_date: new Date(2026, 6, 1) })
    ]);
    expect(derived.entries[0].category).toBe('Food & Drink');
    expect(derived.entries[0].hits).toBe(2);
  });

  it('breaks a tie with the most recent, since a merchant can change', () => {
    const derived = ctx.deriveMemory_([
      row({ category: 'Food & Drink', booking_date: new Date(2026, 0, 1) }),
      row({ category: 'Shopping', booking_date: new Date(2026, 6, 1) })
    ]);
    expect(derived.entries[0].category).toBe('Shopping');
  });

  it('records the winner\'s count, so a contested entry looks weak', () => {
    // hits is the evidence behind the answer given, not the number of times the
    // merchant was seen. 20 rows split 11/9 is not a 20-row certainty.
    const derived = ctx.deriveMemory_([
      row({ category: 'Food & Drink' }),
      row({ category: 'Shopping' })
    ]);
    expect(derived.entries[0].hits).toBe(1);
  });

  it('refuses to learn anything from a transfer', () => {
    // Both legs carry whatever the other account is called, so learning them
    // would file real spending at that merchant as a move between accounts.
    const derived = ctx.deriveMemory_([row({ category: 'Transfer', subcategory: 'Between accounts' })]);
    expect(derived.entries).toHaveLength(0);
  });

  it('skips a row whose description yields no key', () => {
    const derived = ctx.deriveMemory_([row({ description: '12/03 *1234', counterparty: '' })]);
    expect(derived.entries).toHaveLength(0);
  });

  it('orders by evidence, so the strongest entries are at the top of the tab', () => {
    const derived = ctx.deriveMemory_([
      row({ description: 'CONAD' }),
      row({ description: 'ESSELUNGA' }),
      row({ description: 'ESSELUNGA' })
    ]);
    expect(derived.entries[0].merchant_key).toBe('esselunga');
  });
});

describe('running the cascade over the sheet', () => {
  /** A built book with `rows` in transactions, bypassing sync. */
  function book(rows, options = {}) {
    const c = load(options);
    c.setup();
    const tx = c.__spreadsheet.getSheetByName('transactions');
    const values = rows.map((row) => c.TX_COLUMNS.map((name) => (name in row ? row[name] : '')));
    tx.getRange(2, 1, values.length, c.TX_COLUMNS.length).setValues(values);
    return { c, tx };
  }

  const row = (i, over = {}) => Object.assign({
    uid: 'u' + i, account_id: 'revolut', account_name: 'Revolut',
    booking_date: new Date(2026, 4, i), amount: -10, currency: 'EUR',
    description: 'PAGAMENTO POS NETFLIX', counterparty: ''
  }, over);

  it('writes the three derived columns and nothing else', () => {
    const { c, tx } = book([row(1)]);
    c.recategorizeAll();

    const record = c.readRecords_(tx, c.TX_COLUMNS, 1)[0];
    expect(record.category_auto).toBe('Entertainment');
    expect(record.subcategory_auto).toBe('Streaming');
    expect(record.category_source).toBe('rule');
    expect(record.category_override).toBe('');
  });

  it('changes nothing on a second run', () => {
    const { c, tx } = book([row(1)]);
    c.recategorizeAll();
    const second = c.commitCategorize_(c.planCategorize_());
    expect(second.changed).toBe(0);
    expect(second.writes).toBe(0);
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_auto).toBe('Entertainment');
  });

  it('writes only the rows that moved, in contiguous runs', () => {
    // A free Google account keeps 30 days of history or 100 revisions,
    // whichever runs out first, so a nightly job that rewrites four thousand
    // unchanged rows burns the history a real mistake would need.
    const { c } = book([row(1), row(2), row(3)]);
    c.recategorizeAll();
    expect(c.commitCategorize_(c.planCategorize_()).writes).toBe(0);
  });

  it('leaves a confirmed row with the category it was confirmed with', () => {
    const { c, tx } = book([row(1, {
      confirmed: true, category_auto: 'Housing', subcategory_auto: 'Subscriptions',
      category_source: 'memory'
    })]);
    c.recategorizeAll();

    const record = c.readRecords_(tx, c.TX_COLUMNS, 1)[0];
    expect(record.category_auto).toBe('Housing');
  });

  it('still categorises a confirmed row that has never been categorised', () => {
    // Otherwise an imported history — confirmed on arrival, guessed at never —
    // would stay blank forever.
    const { c, tx } = book([row(1, { confirmed: true })]);
    c.recategorizeAll();
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_auto).toBe('Entertainment');
  });

  it('recomputes underneath an override, since the override is what shows', () => {
    const { c, tx } = book([row(1, { category_override: 'Housing' })]);
    c.recategorizeAll();

    const record = c.readRecords_(tx, c.TX_COLUMNS, 1)[0];
    expect(record.category_auto).toBe('Entertainment');
    expect(record.category_source).toBe('override');
  });

  it('writes nothing at all when the confirmation is declined', () => {
    const { c, tx } = book([row(1)], { alertResponse: 'NO' });
    c.recategorizeAll();
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_auto).toBe('');
  });

  it('rebuilds memory from the sheet and then categorises from it', () => {
    const { c, tx } = book([
      row(1, { description: 'BAR DA GINO', category_override: 'Food & Drink' }),
      row(2, { description: 'PAGAMENTO POS BAR DA GINO 12/03' })
    ]);

    c.learnFromCorrections();
    const memory = c.__spreadsheet.getSheetByName('_memory');
    // `da` is one of the noise words, so both rows reduce to the same key —
    // which is the point: the descriptor differs and the merchant does not.
    expect(c.readColumn_(memory, 1)).toContain('bar gino');

    c.recategorizeAll();
    const second = c.readRecords_(tx, c.TX_COLUMNS, 1)[1];
    expect(second.category_auto).toBe('Food & Drink');
    expect(second.category_source).toBe('memory');
  });
});

describe('confirming', () => {
  function book(count) {
    const c = load();
    c.setup();
    const tx = c.__spreadsheet.getSheetByName('transactions');
    const rows = [];
    for (let i = 1; i <= count; i++) {
      rows.push(c.TX_COLUMNS.map((name) => (name === 'uid' ? 'u' + i : '')));
    }
    tx.getRange(2, 1, rows.length, c.TX_COLUMNS.length).setValues(rows);
    return { c, tx };
  }

  it('refuses to confirm everything when nothing is selected or filtered', () => {
    // Ticking four thousand rows by accident is exactly the mistake worth a
    // wall in front of it: the flag claims a human looked, and there is no undo
    // that restores that meaning.
    const { c, tx } = book(3);
    const target = c.confirmableRows_(tx);
    expect(target.error).toMatch(/Select the rows/);
  });

  it('confirms a multi-row selection', () => {
    const { c, tx } = book(4);
    tx.getRange(2, 1, 2, 1).activate();

    c.confirmVisibleRows();
    const records = c.readRecords_(tx, c.TX_COLUMNS, 1);
    expect(records[0].confirmed).toBe(true);
    expect(records[2].confirmed).toBe('');
  });
});

describe('imported rows arrive confirmed', () => {
  it('marks them, because they were categorised once already', () => {
    const c = load();
    c.setup();

    const staged = c.__spreadsheet.getSheetByName('_import_staged');
    const values = [c.STAGED_COLUMNS.map((name) => {
      if (name === 'uid') return 'csv:budgetbakers:b1#2';
      if (name === 'account_id') return 'revolut';
      if (name === 'account_name') return 'Revolut';
      if (name === 'booking_date') return new Date(2026, 4, 1);
      if (name === 'amount') return -12.5;
      if (name === 'category_override') return 'Food & Drink';
      if (name === 'include') return true;
      return '';
    })];
    staged.getRange(2, 1, 1, c.STAGED_COLUMNS.length).setValues(values);

    c.importStagedRows();

    const tx = c.__spreadsheet.getSheetByName('transactions');
    const record = c.readRecords_(tx, c.TX_COLUMNS, 1)[0];
    expect(record.confirmed).toBe(true);
    expect(record.category_override).toBe('Food & Drink');
  });
});

describe('column visibility on transactions', () => {
  it('leaves the columns you review with visible and hides the machinery', () => {
    // Reviewing a row means reading the description and setting two columns,
    // and those two are twenty-two apart in the schema.
    const c = load();
    c.setup();
    const tx = c.__spreadsheet.getSheetByName('transactions');

    const hidden = (name) => tx.isColumnHiddenByUser(c.TX_COLUMNS.indexOf(name) + 1);

    expect(hidden('description')).toBe(false);
    expect(hidden('category_override')).toBe(false);
    expect(hidden('confirmed')).toBe(false);
    expect(hidden('labels')).toBe(false);

    expect(hidden('uid')).toBe(true);
    expect(hidden('entry_reference')).toBe(true);
    expect(hidden('category_auto')).toBe(true);
  });

  it('never re-hides a column you unhid', () => {
    // The reason to unhide one is usually that you are mid-way through
    // chasing something, and setup() undoing that is the worst possible moment.
    const c = load();
    c.setup();
    const tx = c.__spreadsheet.getSheetByName('transactions');
    const uid = c.TX_COLUMNS.indexOf('uid') + 1;

    tx.showColumns(uid);
    c.setup();

    expect(tx.isColumnHiddenByUser(uid)).toBe(false);
  });

  it('keeps every visible column in the schema, so a rename cannot orphan one', () => {
    ctx.TX_VISIBLE_COLUMNS.forEach((name) => {
      expect(ctx.TX_COLUMNS, `${name} is not a column`).toContain(name);
    });
  });
});

describe('the label report', () => {
  const count = ctx.labelCountFormula();
  const total = ctx.labelTotalFormula();

  it('reads the labels column of transactions, with its "!"', () => {
    // `TABS.TRANSACTIONS + '$AA$2:$AA'` reads correctly at the call site and
    // produces `transactions$AA$2:$AA`, which does not parse.
    const column = ctx.colOf(ctx.TX_COLUMNS, 'labels');
    expect(count).toContain(`transactions!$${column}$2:$${column}`);
    expect(total).toContain(`transactions!$${column}$2:$${column}`);
  });

  it('sums amount_base, which is what every report reads', () => {
    const amount = ctx.colOf(ctx.TX_COLUMNS, 'amount_base');
    expect(total).toContain(`transactions!$${amount}$2:$${amount}`);
    expect(total).not.toContain(`transactions!$${ctx.colOf(ctx.TX_COLUMNS, 'amount')}$2`);
  });

  it('anchors at row 2 and spills, so a label added later is covered', () => {
    [count, total].forEach((formula) => {
      expect(formula.startsWith('=ARRAYFORMULA(')).toBe(true);
      expect(formula).toContain('$A$2:$A');
    });
  });

  it('survives translation into a decimal-comma locale', () => {
    [count, total].forEach((formula) => {
      const localized = ctx.localizeFormula(formula, ';');
      expect(localized).not.toContain(',');
      // The wildcards are inside string literals and must come through intact.
      expect(localized).toContain('"*"');
    });
  });

  it('builds balanced parentheses and quotes', () => {
    [count, total].forEach((formula) => {
      const depth = [...formula].reduce((d, ch) => (ch === '(' ? d + 1 : ch === ')' ? d - 1 : d), 0);
      expect(depth).toBe(0);
      expect([...formula].filter((ch) => ch === '"').length % 2).toBe(0);
    });
  });
});

describe('tidying a retired category', () => {
  it('names a replacement for every retirement', () => {
    // A retirement with nowhere to go would strand every row using it.
    ctx.RETIRED_CATEGORIES.forEach((entry) => {
      expect(entry.to).toHaveLength(2);
      const exists = ctx.DEFAULT_CATEGORIES.some(
        (row) => row[0] === entry.to[0] && row[1] === entry.to[1]);
      expect(exists, `${entry.to.join(' / ')} is not in the taxonomy`).toBe(true);
    });
  });

  it('never retires a category that is still in the defaults', () => {
    ctx.RETIRED_CATEGORIES.forEach((entry) => {
      const stillThere = ctx.DEFAULT_CATEGORIES.some(
        (row) => row[0] === entry.category && row[1] === entry.subcategory);
      expect(stillThere, `${entry.category} / ${entry.subcategory} is both retired and current`)
        .toBe(false);
    });
  });

  it('resolves a parent only when its children agree where they went', () => {
    const moves = ctx.unambiguousParentMoves_();
    expect(moves['Travel']).toBe('Entertainment');
    expect(moves['Bills & Utilities']).toBe('Housing');
    // Family split between Shopping and Entertainment, so a row naming only
    // the parent cannot be resolved without guessing which.
    expect(moves['Family']).toBeUndefined();
    expect(ctx.ambiguousParents_()).toEqual(['Family']);
  });

  it('does not call a parent retired when only a child of it was renamed', () => {
    // `Insurance / Home → Insurance / Home insurance` keeps the parent. Read as
    // a move it is Insurance → Insurance, which offers a rewrite that changes
    // nothing; suppressed without this distinction it becomes a parent whose
    // children disagree, and the dialog tells you to retype correct rows.
    expect(ctx.unambiguousParentMoves_()['Insurance']).toBeUndefined();
    expect(ctx.ambiguousParents_()).not.toContain('Insurance');
    expect(ctx.ambiguousParents_()).not.toContain('Education');
  });

  it('ignores a retirement that kept its child name', () => {
    // Most of the list moves a child and keeps its name. `Electricity` resolves
    // its parent through a lookup, so such a cell is already correct and must
    // not be reported as anything.
    const { moves, stranded } = ctx.childRenames_();
    expect(moves['Electricity']).toBeUndefined();
    expect(stranded).not.toContain('Electricity');
  });

  it('refuses to guess a renamed child whose old name is still in use', () => {
    // The rename existed because two parents shared the name. Rewriting `Home`
    // would be asserting which of them you meant.
    const { moves, stranded } = ctx.childRenames_();
    expect(moves['Home']).toBeUndefined();
    expect(moves['Books']).toBeUndefined();
    expect(stranded).toEqual(['Home', 'Books']);
  });

  it('rewrites a renamed child once its old name is gone from the taxonomy', () => {
    // The case the mechanism exists for. Faked rather than waiting for a real
    // one, because whether it works must not depend on the seed of the day.
    const c = load();
    c.RETIRED_CATEGORIES.push(
      { category: 'Housing', subcategory: 'Broadband', to: ['Housing', 'Internet'] });

    const { moves, stranded } = c.childRenames_();
    expect(moves['Broadband']).toBe('Internet');
    expect(stranded).not.toContain('Broadband');
  });

  it('migrates subcategory_override, which is where corrections now live', () => {
    const c = load();
    c.setup();
    const ss = c.__spreadsheet;
    c.RETIRED_CATEGORIES.push(
      { category: 'Housing', subcategory: 'Broadband', to: ['Housing', 'Internet'] });

    const categories = ss.getSheetByName('categories');
    const start = c.lastRecordRow_(categories, 1) + 1;
    categories.getRange(start, 1, 1, 4).setValues([['Housing', 'Broadband', 'expense', '🌐']]);

    // One row to migrate, and one naming a child that two parents still share.
    const tx = ss.getSheetByName('transactions');
    const rows = [['t1', 'Broadband'], ['t2', 'Home']].map(([uid, sub]) =>
      c.TX_COLUMNS.map((name) => {
        if (name === 'uid') return uid;
        if (name === 'subcategory_override') return sub;
        return '';
      }));
    tx.getRange(2, 1, rows.length, c.TX_COLUMNS.length).setValues(rows);

    const result = c.tidyCategories();

    const after = c.readRecords_(tx, c.TX_COLUMNS, 1);
    expect(after[0].subcategory_override).toBe('Internet');
    expect(after[1].subcategory_override).toBe('Home');
    expect(result.stranded).toEqual([{ name: 'Home', count: 1 }]);
  });

  it('removes the retired rows and repoints what pointed at them', () => {
    const c = load();
    c.setup();
    const ss = c.__spreadsheet;

    // A book built by an older version: the retired rows are still present,
    // and a mapping and a transaction still name them.
    const categories = ss.getSheetByName('categories');
    const start = c.lastRecordRow_(categories, 1) + 1;
    categories.getRange(start, 1, 2, 4).setValues([
      ['Travel', 'Flights', 'expense', '✈️'],
      ['Bills & Utilities', 'Phone', 'expense', '📱']
    ]);

    const map = ss.getSheetByName('_category_map');
    map.getRange(2, 1, 1, 4).setValues([['budgetbakers', 'Long distance', 'Travel', 'Flights']]);

    const tx = ss.getSheetByName('transactions');
    const row = c.TX_COLUMNS.map((name) => {
      if (name === 'uid') return 'u1';
      if (name === 'category_override') return 'Travel';
      return '';
    });
    tx.getRange(2, 1, 1, c.TX_COLUMNS.length).setValues([row]);

    const result = c.tidyCategories();
    expect(result.removed).toBe(2);

    const remaining = c.readRecords_(categories, c.CATEGORY_COLUMNS, 1)
      .map((r) => `${r.category} / ${r.subcategory}`);
    expect(remaining).not.toContain('Travel / Flights');
    expect(remaining).not.toContain('Bills & Utilities / Phone');

    expect(c.readRecords_(map, c.CATEGORY_MAP_COLUMNS, 1)[0].category).toBe('Entertainment');
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_override).toBe('Entertainment');
  });

  it('says there is nothing to do on a book that is already current', () => {
    const c = load();
    c.setup();
    expect(c.planCategoryTidy_(c.__spreadsheet).error).toMatch(/Nothing to tidy/);
  });
});

/**
 * The dropdowns and the code behind them.
 *
 * A validation list written out where it is applied is a second copy of the
 * vocabulary, and the way a second copy drifts is that the sheet offers a value
 * nothing understands — which fails as "the rule just doesn't match", with no
 * error anywhere to find. These assert the list and its reader are in step.
 */
describe('the closed vocabularies', () => {
  const c = load();

  it('offers only rule fields the cascade can actually read', () => {
    c.RULE_FIELDS.forEach((field) => {
      expect(c.ruleField_({ description: 'x', counterparty: 'x', mcc: 1,
        bank_transaction_code: 'x' }, field), field).not.toBeNull();
    });
    expect(c.ruleField_({}, 'not_a_field')).toBeNull();
  });

  it('offers only match types matchesPattern_ implements', () => {
    // `contains` is the fallback, so a bogus type behaves like it — which is
    // exactly why an unvalidated column here fails invisibly.
    c.RULE_MATCH_TYPES.forEach((type) => {
      expect(c.matchesPattern_('ACME', type, 'ACME'), type).toBe(true);
    });
  });

  it('keeps the type list and the type enum the same three values', () => {
    expect(c.TX_TYPES.slice().sort())
      .toEqual(Object.values(c.TX_TYPE).slice().sort());
    expect(c.ACCOUNT_KINDS.slice().sort())
      .toEqual(Object.values(c.ACCOUNT_KIND).slice().sort());
  });

  it('seeds no rule that its own dropdowns would reject', () => {
    // The seed data is the largest body of values in the project and the one
    // nobody re-reads. A typo here ships as a rule that never fires.
    c.DEFAULT_RULES.forEach((row) => {
      const [, field, matchType, , , , , type] = row;
      expect(c.RULE_FIELDS, `field ${field}`).toContain(field);
      expect(c.RULE_MATCH_TYPES, `match_type ${matchType}`).toContain(matchType);
      expect(c.TX_TYPES, `type ${type}`).toContain(type);
    });
  });

  it('seeds no category whose kind is not a type', () => {
    c.DEFAULT_CATEGORIES.forEach((row) => {
      expect(c.TX_TYPES, `kind ${row[2]}`).toContain(row[2]);
    });
  });
});

/**
 * A subcategory has to name exactly one parent.
 *
 * `category` resolves a `subcategory_override` through a VLOOKUP, which takes
 * the first match. And `child_list` — the range every subcategory dropdown
 * points at — is a SORTED UNIQUE list, so two parents sharing a child name are
 * one indistinguishable entry before the lookup is even reached.
 *
 * The seed had two: `Home` under both Shopping and Insurance, `Books` under
 * both Shopping and Education. Renamed rather than disambiguated at lookup
 * time, because "which Home did you mean" is not a question a dropdown asks.
 */
describe('the subcategory vocabulary', () => {
  const c = load();

  it('gives every subcategory exactly one parent', () => {
    const parents = new Map();
    c.DEFAULT_CATEGORIES.forEach(([category, subcategory]) => {
      if (!parents.has(subcategory)) parents.set(subcategory, new Set());
      parents.get(subcategory).add(category);
    });

    const ambiguous = [...parents.entries()]
      .filter(([, set]) => set.size > 1)
      .map(([child, set]) => `${child} under ${[...set].join(' and ')}`);

    expect(ambiguous).toEqual([]);
  });

  it('leaves no seeded rule or mapping pointing at a name that was renamed', () => {
    const known = new Set(c.DEFAULT_CATEGORIES.map(([parent, child]) => `${parent}|${child}`));

    // A rule carries category at 5 and subcategory at 6; a category map row
    // carries them at 2 and 3. Either would quietly stop matching the tab.
    c.DEFAULT_RULES.forEach((rule) => {
      if (!rule[6]) return;
      expect(known, `rule ${rule[0]}: ${rule[5]} / ${rule[6]}`)
        .toContain(`${rule[5]}|${rule[6]}`);
    });
    c.DEFAULT_CATEGORY_MAP.forEach((row) => {
      if (!row[3]) return;
      expect(known, `${row[1]}: ${row[2]} / ${row[3]}`).toContain(`${row[2]}|${row[3]}`);
    });
  });
});
