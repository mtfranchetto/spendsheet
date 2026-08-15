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

  it('is a flat map keyed by the merchant key, so a hit costs one lookup', () => {
    // What lets memory sit inside the rule loop at a priority rather than in
    // front of it: it contributes at most one candidate, found without a scan.
    const memory = index([
      { merchant_key: 'esselunga', category: 'Food & Drink', subcategory: 'Groceries', hits: 40 }
    ]);
    expect(memory.esselunga.category).toBe('Food & Drink');
    expect(memory.esselunga.subcategory).toBe('Groceries');
  });

  it('matches a key whole, so a longer key is a different merchant', () => {
    // `esselunga torino` earns its own confirmation rather than inheriting the
    // answer given to `esselunga`. A merchant whose rendering varies more than
    // that is what a `contains` rule is for.
    const memory = index([
      { merchant_key: 'esselunga', category: 'Food & Drink', subcategory: 'Groceries', hits: 40 }
    ]);
    expect(memory['esselunga torino']).toBeUndefined();
  });

  it('lowercases and trims the key, since the tab is yours to edit', () => {
    const memory = index([
      { merchant_key: '  Q8 Rivoli ', category: 'Transport', subcategory: 'Fuel', hits: 9 }
    ]);
    expect(memory['q8 rivoli'].category).toBe('Transport');
  });

  it('skips an entry with no category, which would categorise a row as blank', () => {
    const memory = index([{ merchant_key: 'mystery', category: '', subcategory: '', hits: 3 }]);
    expect(memory.mystery).toBeUndefined();
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
  // One ordered list. `memoryPriority` is the only thing deciding where the
  // learned entry sits in it, which is the point of the arrangement — every
  // test below that changes the answer changes that number and nothing else.
  const context = (memoryPriority = 5) => ({
    memory: ctx.buildMemoryIndex_([
      { merchant_key: 'esselunga', category: 'Food & Drink', subcategory: '', hits: 40 }
    ]),
    memoryPriority,
    rules: [
      { priority: 10, field: 'mcc', match_type: 'equals', pattern: '5411',
        category: 'Food & Drink', subcategory: 'Groceries', enabled: true },
      { priority: 100, field: 'description', match_type: 'contains', pattern: 'NETFLIX',
        category: 'Life & Entertainment', subcategory: 'Streaming', enabled: true }
    ],
    kindByCategory: { Transfer: 'transfer' },
    transferWindowDays: 4
  });

  const record = (over = {}) => Object.assign({
    description: '', counterparty: '', mcc: '', account_id: 'a', account_name: 'A',
    category_override: '', bank_transaction_code: '', _transferGroup: ''
  }, over);

  // The merchant key comes from `counterparty` when the bank filled it, so
  // these rows carry the key on one field and the rule's pattern on another.
  // That is the only way to put memory and a text rule on the same row.
  const esselunga = (over = {}) => record(Object.assign({ counterparty: 'Esselunga' }, over));

  it('puts a matched transfer above everything a rule could say', () => {
    const verdict = ctx.categorizeOne_(
      record({ description: 'NETFLIX', _transferGroup: 'tr:x' }), context());
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.TRANSFER);
    expect(verdict.category).toBe('Transfer');
  });

  it('lets memory decide when its priority is below every rule', () => {
    const verdict = ctx.categorizeOne_(esselunga({ mcc: '5411' }), context(5));
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.MEMORY);
  });

  it('lets a rule win when memory sits below it', () => {
    // The same row and the same list, with one number moved. This is what
    // `memory_priority` buys: the answer to "should a rule beat my own
    // history" is a cell rather than a branch.
    const verdict = ctx.categorizeOne_(esselunga({ mcc: '5411' }), context(1000));
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.MCC);
    expect(verdict.subcategory).toBe('Groceries');
  });

  it('still reaches memory when no rule matches, however low its priority', () => {
    const verdict = ctx.categorizeOne_(esselunga(), context(1000));
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.MEMORY);
    expect(verdict.category).toBe('Food & Drink');
  });

  it('gives a tie to the rule, so ordering never depends on a coincidence', () => {
    // A tie has to break somewhere, and this way `memory_priority` never has to
    // dodge a number the seed already uses.
    const verdict = ctx.categorizeOne_(esselunga({ mcc: '5411' }), context(10));
    expect(verdict.source).toBe(ctx.CATEGORY_SOURCE.MCC);
  });

  it('lets a later rule supply the subcategory memory learned without', () => {
    // An imported row carries its category in category_override and its
    // subcategory nowhere, so memory built from history knows parents. Stopping
    // at the first match would make memory *lose* detail the list already had.
    const verdict = ctx.categorizeOne_(esselunga({ mcc: '5411' }), context(5));
    expect(verdict.category).toBe('Food & Drink');
    expect(verdict.subcategory).toBe('Groceries');
  });

  it('does not borrow a subcategory from a match that disagrees about the parent', () => {
    const verdict = ctx.categorizeOne_(
      esselunga({ description: 'NETFLIX SUBSCRIPTION' }), context(5));
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
    expect(verdict.category).toBe('Life & Entertainment');
  });
});

describe('where memory sits in the list', () => {
  it('defaults to 5, which is below the lowest seed rule', () => {
    const lowest = Math.min(...ctx.DEFAULT_RULES.map((row) => row[0]));
    expect(ctx.configNumber_({}, 'memory_priority')).toBe(5);
    expect(ctx.configNumber_({}, 'memory_priority')).toBeLessThan(lowest);
  });

  it('falls back to 5 rather than 0 when the cell is cleared', () => {
    // `Number('')` is 0 and 0 is a valid priority, so a zero default would make
    // a cleared cell and a working default the same reading — and this test
    // could not tell the guard in configNumber_ from its absence.
    expect(ctx.configNumber_({ memory_priority: '' }, 'memory_priority')).toBe(5);
    expect(ctx.configNumber_({ memory_priority: '   ' }, 'memory_priority')).toBe(5);
  });

  it('takes the number you typed', () => {
    expect(ctx.configNumber_({ memory_priority: 1000 }, 'memory_priority')).toBe(1000);
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

  it('learns nothing from a row a rule confirmed', () => {
    // A rule that taught memory its own answer would go on being obeyed
    // *through memory* after the rule had been corrected — and at the default
    // `memory_priority` memory is offered first, so the `rules` tab would look
    // ignored with the reason on a tab nobody edits. Confirming a rule's answer
    // is a decision that deliberately does not propagate; only overriding teaches.
    expect(ctx.deriveMemory_([row({ category_source: 'rule' })]).entries).toHaveLength(0);
    expect(ctx.deriveMemory_([row({ category_source: 'mcc' })]).entries).toHaveLength(0);
  });

  it('learns from a row where you overrode what a rule said', () => {
    // The case memory exists for: you looked at a rule's answer and disagreed.
    const derived = ctx.deriveMemory_([
      row({ category_source: 'rule', category: '', category_override: 'Housing' })
    ]);
    expect(derived.entries[0].category).toBe('Housing');
  });

  it('still learns from memory and unclassified rows you confirmed', () => {
    expect(ctx.deriveMemory_([row({ category_source: 'memory' })]).entries).toHaveLength(1);
    expect(ctx.deriveMemory_([row({ category_source: 'unclassified' })]).entries).toHaveLength(1);
    expect(ctx.deriveMemory_([row({ category_source: '' })]).entries).toHaveLength(1);
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

  it('keeps a subcategory even when more rows named only the parent', () => {
    // A blank is not a candidate. Counting it as one let three bare parents
    // out-vote two rows that named the child, and the merchant then lost its
    // subcategory on every future row — the opposite of learning.
    const derived = ctx.deriveMemory_([
      row({ subcategory: '' }), row({ subcategory: '' }), row({ subcategory: '' }),
      row({ subcategory: 'Groceries' }), row({ subcategory: 'Groceries' })
    ]);
    expect(derived.entries[0].category).toBe('Food & Drink');
    expect(derived.entries[0].subcategory).toBe('Groceries');
  });

  it('counts the category, not the variant, so hits means what it says', () => {
    const derived = ctx.deriveMemory_([
      row({ subcategory: '' }), row({ subcategory: 'Groceries' })
    ]);
    expect(derived.entries[0].hits).toBe(2);
  });

  it('picks the subcategory given most often within the winning category', () => {
    const derived = ctx.deriveMemory_([
      row({ subcategory: 'Groceries' }), row({ subcategory: 'Groceries' }),
      row({ subcategory: 'Restaurants' })
    ]);
    expect(derived.entries[0].subcategory).toBe('Groceries');
  });

  it('reads a subcategory_override, which is where half a correction lives', () => {
    // On a sheet the `subcategory` formula resolves this first, so only records
    // built anywhere else reach the fallback — and dropping it is how memory
    // learns a bare parent from a row that named both halves.
    const derived = ctx.deriveMemory_([
      row({ category: '', subcategory: '', category_override: 'Housing',
        subcategory_override: 'Rent' })
    ]);
    expect(derived.entries[0].category).toBe('Housing');
    expect(derived.entries[0].subcategory).toBe('Rent');
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
    expect(record.category_auto).toBe('Life & Entertainment');
    expect(record.subcategory_auto).toBe('Streaming');
    expect(record.category_source).toBe('rule');
    expect(record.category_override).toBe('');

    // The "nothing else" the name claims, and the half worth asserting: this
    // row was answered by the `rules` tab, which is the tier with the strongest
    // case for ticking itself — a standing instruction you wrote. It still does
    // not, because confirming *freezes* the row against every later run, so a
    // cascade that confirms is a cascade that can settle a category no one read.
    expect(record.confirmed).toBe('');
  });

  it('changes nothing on a second run', () => {
    const { c, tx } = book([row(1)]);
    c.recategorizeAll();
    const second = c.commitCategorize_(c.planCategorize_());
    expect(second.changed).toBe(0);
    expect(second.writes).toBe(0);
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_auto).toBe('Life & Entertainment');
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
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_auto).toBe('Life & Entertainment');
  });

  it('recomputes underneath an override, since the override is what shows', () => {
    const { c, tx } = book([row(1, { category_override: 'Housing' })]);
    c.recategorizeAll();

    const record = c.readRecords_(tx, c.TX_COLUMNS, 1)[0];
    expect(record.category_auto).toBe('Life & Entertainment');
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
      expect(formula.startsWith('=MAP(')).toBe(true);
      expect(formula).toContain('$A$2:$A');
    });
  });

  /*
    The bug this pair shipped with, and the only half of it a string test can
    reach.

    **`SUMIFS` does not vectorise over its criteria; `COUNTIFS` does.** Written
    as twins inside one `ARRAYFORMULA`, the counts came out per label and every
    total showed the first label's figure repeated down the column — a label
    with 0 transactions reporting -€7,480.20 beside a correct 0.

    A test cannot evaluate either formula, so it cannot catch the wrong answer.
    What it can hold is the construct: one label at a time, so there is nothing
    to broadcast and nothing for a function to decide about. Same lesson as
    `INDEX` inside an `ARRAYFORMULA`, one function along.
  */
  it('hands each formula one label at a time, rather than the column', () => {
    [count, total].forEach((formula) => {
      expect(formula).toContain('LAMBDA(label,');
      expect(formula).toContain('"*"&label&"*"');
      // The column reference appears once, as what MAP walks — never as a
      // criterion, which is where the broadcast decision used to be made.
      expect(formula.match(/\$A\$2:\$A/g)).toHaveLength(1);
    });
  });

  it('builds both from one scaffold, so neither can rely on the other working', () => {
    // The bodies differ — `SUMIFS` takes a sum range and `COUNTIFS` does not —
    // and everything around them is shared by construction. That is the part
    // worth pinning: the first version had two hand-written wrappers that
    // looked identical and behaved differently, which is a thing you cannot see
    // by reading them side by side.
    const scaffold = ctx.labelStatFormula_('AGG(x)');
    const [head, tail] = scaffold.split('AGG(x)');

    [count, total].forEach((formula) => {
      expect(formula.startsWith(head)).toBe(true);
      expect(formula.endsWith(tail)).toBe(true);
    });
  });

  it('short-circuits on a blank, which is what keeps MAP cheap', () => {
    // MAP runs the lambda for every row of an open column. The blank test has
    // to come first or a thousand empty rows each cost a scan of the ledger.
    [count, total].forEach((formula) => {
      expect(formula.indexOf('IF(LEN(label)=0'))
        .toBeLessThan(formula.search(/COUNTIFS|SUMIFS/));
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
    expect(moves['Travel']).toBe('Life & Entertainment');
    expect(moves['Bills & Utilities']).toBe('Housing');
    // Family split between Shopping and Life & Entertainment, so a row naming
    // only the parent cannot be resolved without guessing which.
    expect(moves['Family']).toBeUndefined();
    expect(ctx.ambiguousParents_()).toEqual(['Family']);
  });

  it('resolves a renamed parent, and reads no rename into its children', () => {
    // `Entertainment → Life & Entertainment` is the whole of a parent moving
    // and none of its children: every child keeps its own name, so the entries
    // are seven only because the list is keyed on the pair. The two halves fail
    // in opposite directions — a parent nobody rewrites leaves overrides
    // pointing at a category no report groups by, and a child read as renamed
    // would rewrite `subcategory_override` cells that were always correct.
    expect(ctx.unambiguousParentMoves_()['Entertainment']).toBe('Life & Entertainment');
    expect(ctx.ambiguousParents_()).not.toContain('Entertainment');

    const { moves, stranded } = ctx.childRenames_();
    ['Streaming', 'Hobbies', 'Flights', 'Accommodation', 'Holiday', 'Life events']
      .forEach((child) => {
        expect(moves[child], `${child} was read as renamed`).toBeUndefined();
        expect(stranded).not.toContain(child);
      });
  });

  it('points every retirement at a parent no later retirement removes', () => {
    // The tidy resolves a pair once and does not chase the answer through a
    // second retirement, so a `to` naming a retired pair sends a book that
    // never tidied to a category this same list removes. `Travel / Flights` is
    // one edit away from it: its destination has to follow every parent rename
    // the list picks up afterwards.
    const retired = {};
    ctx.RETIRED_CATEGORIES.forEach((entry) => {
      retired[ctx.pairKey_(entry.category, entry.subcategory)] = true;
    });
    ctx.RETIRED_CATEGORIES.forEach((entry) => {
      expect(retired[ctx.pairKey_(entry.to[0], entry.to[1])],
        `${entry.category} / ${entry.subcategory} lands on a retired pair`).toBeUndefined();
    });
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

    expect(c.readRecords_(map, c.CATEGORY_MAP_COLUMNS, 1)[0].category).toBe('Life & Entertainment');
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_override).toBe('Life & Entertainment');
  });

  it('leaves the derived columns to their formulas', () => {
    // Rewriting the tab full-width erased four ARRAYFORMULA anchors and stored
    // their own spill where they would have expanded — one tidy, and every
    // category dropdown on the book loses its source. A re-run does not undo it.
    const c = load();
    c.setup();
    const ss = c.__spreadsheet;
    const categories = ss.getSheetByName('categories');

    const start = c.lastRecordRow_(categories, 1) + 1;
    categories.getRange(start, 1, 1, 4).setValues([['Travel', 'Flights', 'expense', '✈️']]);

    const anchorsBefore = c.CATEGORY_COLUMNS_DERIVED.map(
      (name) => categories.getRange(`${c.colOf(c.CATEGORY_COLUMNS, name)}2`).getFormula());
    expect(anchorsBefore.every((f) => f.startsWith('='))).toBe(true);

    c.tidyCategories();

    c.CATEGORY_COLUMNS_DERIVED.forEach((name, i) => {
      const col = c.colOf(c.CATEGORY_COLUMNS, name);
      expect(categories.getRange(`${col}2`).getFormula(), `${col}2 lost its anchor`)
        .toBe(anchorsBefore[i]);
      expect(categories.getRange(`${col}3`).getValue(), `${col}3 was written over`).toBe('');
    });
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
