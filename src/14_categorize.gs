/**
 * 14_categorize.gs — the categorisation cascade.
 *
 * Six tiers, first hit wins, and every row records which tier decided it in
 * `category_source` so "why is this Groceries?" is always answerable:
 *
 *   1 override      you typed it
 *   2 transfer      the row is one leg of a pair, and leaves spending entirely
 *   3 memory        merchant key → the category you have most often given it
 *   4 mcc           merchant_category_code → category, language-independent
 *   5 rule          contains/regex over description or counterparty
 *   6 unclassified  goes to a review queue, never silently "Other"
 *
 * **Tier 3 is the workhorse and it is a lookup, not a model.** `_memory` is
 * mined from your own confirmed history by `learnFromCorrections()`, which is
 * why this phase lands after the import rather than before it: four thousand
 * rows you already categorised are a better training signal than any ruleset
 * shipped in this file.
 *
 * Tier 4 is a bonus rather than a foundation — PSD2 banks populate MCC
 * inconsistently, which is exactly why memory sits above it instead of
 * depending on it.
 *
 * Nothing here writes `category_override`, `category` or `type`. The first is
 * yours, the other two are formulas over what this file computes. Recategorising
 * is therefore always safe to re-run: it rewrites three derived columns and one
 * pairing column, and touches nothing a human put in the sheet.
 */

// ---------------------------------------------------------------------------
// Merchant keys
// ---------------------------------------------------------------------------

/**
 * Words that describe the plumbing rather than the merchant.
 *
 * Italian POS descriptors are mostly this: `PAGAMENTO POS 12/03 CARTA *1234
 * ESSELUNGA SPA TORINO` carries one word of signal and eight of ceremony.
 *
 * `coop` is deliberately **not** here despite being a legal form (`soc. coop.`),
 * because Coop is also one of the largest supermarket chains in the country.
 * Stripping it would erase a merchant that appears hundreds of times in a real
 * history, and it would do so silently — the key would still look plausible.
 */
var MERCHANT_NOISE_WORDS = [
  'pagamento', 'pagamenti', 'pos', 'carta', 'cartasi', 'operazione', 'acquisto',
  'addebito', 'accredito', 'bonifico', 'disposizione', 'tramite', 'contactless',
  'ecommerce', 'commercio', 'elettronico', 'del', 'della', 'dello', 'di', 'da',
  'per', 'presso', 'favore', 'ordinante', 'beneficiario', 'causale', 'rif',
  'riferimento', 'aut', 'autorizzazione', 'ref', 'trn', 'importo', 'valuta',
  'data', 'ore', 'ora', 'sepa', 'sdd', 'bancomat', 'pagobancomat', 'istantaneo',
  'eur', 'usd', 'gbp', 'chf', 'nr', 'num', 'numero', 'conto', 'nostro', 'vostro',
  'il', 'lo', 'la', 'le', 'gli', 'un', 'una', 'and', 'the', 'srl', 'spa', 'sas',
  'snc', 'sa', 'bv', 'nv', 'gmbh', 'ltd', 'inc', 'llc', 'plc'
];

/** Longest key we will build. Bounds the cell and the comparison cost. */
var MERCHANT_KEY_MAX_TOKENS = 6;

/**
 * A memory key must be at least this long before it is allowed to match by
 * containment. `q8` as a substring would hit `q8 milano` and also `xq8y`;
 * four characters is where an accidental hit stops being plausible.
 */
var MEMORY_CONTAINMENT_MIN_CHARS = 4;

/**
 * The stable part of what a transaction says it was.
 *
 * Deliberately does **not** strip city names, and that is the one judgement
 * call in this file worth defending. Stripping them would merge
 * `esselunga torino` and `esselunga milano` into one key, which is right until
 * the day it merges two genuinely different merchants — and a wrong merge is
 * permanent, silent, and teaches the cascade something false about every future
 * row. Leaving the city in costs one extra confirmation per city per merchant,
 * once. The asymmetry is not close.
 *
 * The gap that leaves — imported BudgetBakers rows carry a clean `esselunga`
 * where a synced row carries `esselunga torino` — is closed at lookup time by
 * containment matching, not by making the key more aggressive.
 */
function normalizeMerchant(description, counterparty) {
  var text = merchantSource_(description, counterparty);
  if (!text) return '';

  var cleaned = String(text).toLowerCase();

  // Accents first: `città` and `citta` must not be two merchants.
  cleaned = cleaned
    .replace(/[àáâä]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
    .replace(/[òóôö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/[ç]/g, 'c');

  // Dates and times, in the several shapes Italian banks write them.
  cleaned = cleaned
    .replace(/\b\d{1,2}[\/.\-]\d{1,2}([\/.\-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');

  // Card references, before the digits they contain are considered on their own.
  cleaned = cleaned.replace(/carta\s*n?\.?\s*\*?\s*\d+/g, ' ').replace(/\*+\s*\d+/g, ' ');

  cleaned = cleaned.replace(/[^a-z0-9]+/g, ' ');

  var tokens = cleaned.split(' ').filter(function (token) {
    if (!token) return false;
    if (token.length < 2) return false;
    if (/^\d+$/.test(token)) return false;

    // Store numbers, authorisation codes, truncated IBANs. Three digits is
    // where a token stops being a name that happens to contain a number — Q8
    // and A2A survive, `4534` and `it60x054` do not.
    if ((token.replace(/\D/g, '')).length >= 3) return false;

    return MERCHANT_NOISE_WORDS.indexOf(token) === -1;
  });

  return tokens.slice(0, MERCHANT_KEY_MAX_TOKENS).join(' ');
}

/**
 * Which field to build the key from.
 *
 * `counterparty` is the cleaner signal when the bank fills it — it is the
 * merchant's own name rather than the terminal's rendering of it. But
 * `counterpartyName` falls back to an IBAN when there is no name, and an IBAN
 * is a per-payer identifier that would give every row its own key.
 */
function merchantSource_(description, counterparty) {
  var party = String(counterparty === null || counterparty === undefined ? '' : counterparty).trim();
  if (party && !looksLikeAccountNumber_(party)) return party;
  return String(description === null || description === undefined ? '' : description).trim();
}

function looksLikeAccountNumber_(value) {
  var compact = String(value).replace(/\s+/g, '');
  if (/^[A-Za-z]{2}\d{2}[A-Za-z0-9]{8,}$/.test(compact)) return true;   // IBAN
  return /^\d{6,}$/.test(compact);
}

// ---------------------------------------------------------------------------
// The context the cascade reads
// ---------------------------------------------------------------------------

/**
 * Everything the cascade needs, read once.
 *
 * Built up front rather than looked up per row: at four thousand rows, a
 * per-row `getRange` is the difference between two seconds and the six-minute
 * execution limit.
 */
function buildCascadeContext_(config) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cfg = config || readConfig_();

  return {
    memory: buildMemoryIndex_(readMemoryRecords_(ss)),
    mccRules: readRules_(ss, true),
    textRules: readRules_(ss, false),
    kindByCategory: readCategoryKinds_(ss),
    transferWindowDays: configNumber_(cfg, 'transfer_window_days')
  };
}

function readMemoryRecords_(ss) {
  var sheet = ss.getSheetByName(TABS.MEMORY);
  if (!sheet) return [];
  return readRecords_(sheet, MEMORY_COLUMNS, colIndex_(MEMORY_COLUMNS, 'merchant_key'))
    .filter(function (row) { return String(row.merchant_key || '').trim(); });
}

/**
 * Memory, indexed twice.
 *
 * `byKey` is the exact hit. `byFirstToken` is what makes containment cheap: a
 * memory key that appears inside a transaction key as a whole run of words must
 * start at one of that key's tokens, so only the entries sharing a first token
 * are ever compared.
 */
function buildMemoryIndex_(records) {
  var byKey = {};
  var byFirstToken = {};

  records.forEach(function (row) {
    var key = String(row.merchant_key).trim().toLowerCase();
    if (!key) return;

    var entry = {
      key: key,
      category: String(row.category || ''),
      subcategory: String(row.subcategory || ''),
      hits: Number(row.hits) || 0
    };
    if (!entry.category) return;

    byKey[key] = entry;

    if (key.length >= MEMORY_CONTAINMENT_MIN_CHARS) {
      var first = key.split(' ')[0];
      (byFirstToken[first] = byFirstToken[first] || []).push(entry);
    }
  });

  return { byKey: byKey, byFirstToken: byFirstToken };
}

function readRules_(ss, wantMcc) {
  var sheet = ss.getSheetByName(TABS.RULES);
  if (!sheet) return [];

  return readRecords_(sheet, RULE_COLUMNS, colIndex_(RULE_COLUMNS, 'priority'))
    .filter(function (row) { return isTruthyCell_(row.enabled); })
    .filter(function (row) { return String(row.pattern || '').length > 0; })
    .filter(function (row) { return (String(row.field || '') === 'mcc') === !!wantMcc; })
    .sort(function (a, b) { return (Number(a.priority) || 0) - (Number(b.priority) || 0); });
}

/** category → kind, so transfer detection can tell an override it must respect. */
function readCategoryKinds_(ss) {
  var sheet = ss.getSheetByName(TABS.CATEGORIES);
  var kinds = {};
  if (!sheet) return kinds;

  readRecords_(sheet, CATEGORY_COLUMNS, colIndex_(CATEGORY_COLUMNS, 'category'))
    .forEach(function (row) {
      if (row.category && !kinds[row.category]) kinds[row.category] = String(row.kind || '');
    });
  return kinds;
}

// ---------------------------------------------------------------------------
// The cascade
// ---------------------------------------------------------------------------

/**
 * One row's verdict: `{ category, subcategory, source }`.
 *
 * `record._transferGroup` is set by `detectTransfers_` beforehand — tier 2
 * needs the whole tab to see both legs, so it cannot be decided here.
 *
 * An override does not short-circuit the rest. The guess is computed anyway and
 * left in `category_auto`, so a row where your override and the cascade
 * disagree is visible — which is how you notice a rule worth adding. What the
 * sheet *shows* is unaffected either way: the `category` formula takes the
 * override whenever there is one.
 */
function categorizeOne_(record, context) {
  var guess = guessCategory_(record, context);
  if (!isBlankCell_(record.category_override)) guess.source = CATEGORY_SOURCE.OVERRIDE;
  return guess;
}

function guessCategory_(record, context) {
  if (record._transferGroup) {
    return {
      category: 'Transfer',
      subcategory: 'Between accounts',
      source: CATEGORY_SOURCE.TRANSFER
    };
  }

  var key = normalizeMerchant(record.description, record.counterparty);
  var remembered = key ? lookupMemory_(key, context.memory) : null;

  var byMcc = matchRules_(record, context.mccRules);
  var byText = matchRules_(record, context.textRules);

  if (remembered) {
    return {
      category: remembered.category,
      // History teaches parents more often than children: an imported row
      // carries its category in `category_override` and its subcategory
      // nowhere, because `subcategory` blanks itself when an override is
      // present. So when memory knows the parent and a rule agrees about it,
      // the rule's subcategory is adopted rather than thrown away — the
      // alternative is memory *losing* detail that tier 4 or 5 would have had.
      subcategory: remembered.subcategory || refiningSubcategory_(remembered.category, byMcc, byText),
      source: CATEGORY_SOURCE.MEMORY
    };
  }

  if (byMcc) {
    return { category: byMcc.category, subcategory: byMcc.subcategory, source: CATEGORY_SOURCE.MCC };
  }
  if (byText) {
    return { category: byText.category, subcategory: byText.subcategory, source: CATEGORY_SOURCE.RULE };
  }

  return { category: '', subcategory: '', source: CATEGORY_SOURCE.UNCLASSIFIED };
}

function refiningSubcategory_(category, byMcc, byText) {
  var candidates = [byMcc, byText];
  for (var i = 0; i < candidates.length; i++) {
    var rule = candidates[i];
    if (rule && rule.category === category && rule.subcategory) return rule.subcategory;
  }
  return '';
}

/**
 * Memory, exact first and by containment second.
 *
 * Containment is what lets a history imported as `esselunga` categorise a bank
 * row that arrives as `esselunga torino`. It matches on whole words only — a
 * key must line up with a token boundary at both ends — and the longest match
 * wins, so `just eat` beats `just` when both are known.
 */
function lookupMemory_(key, memory) {
  var exact = memory.byKey[key];
  if (exact) return exact;

  var tokens = key.split(' ');
  var best = null;

  for (var i = 0; i < tokens.length; i++) {
    var candidates = memory.byFirstToken[tokens[i]];
    if (!candidates) continue;

    for (var c = 0; c < candidates.length; c++) {
      var entry = candidates[c];
      if (!startsWithTokens_(tokens, i, entry.key)) continue;
      if (!best || entry.key.length > best.key.length) best = entry;
    }
  }

  return best;
}

/** Do the tokens from `start` spell out `phrase` exactly? */
function startsWithTokens_(tokens, start, phrase) {
  var wanted = phrase.split(' ');
  if (start + wanted.length > tokens.length) return false;
  for (var i = 0; i < wanted.length; i++) {
    if (tokens[start + i] !== wanted[i]) return false;
  }
  return true;
}

function matchRules_(record, rules) {
  for (var i = 0; i < rules.length; i++) {
    if (ruleMatches_(record, rules[i])) {
      return {
        category: String(rules[i].category || ''),
        subcategory: String(rules[i].subcategory || '')
      };
    }
  }
  return null;
}

function ruleMatches_(record, rule) {
  var filter = String(rule.account_filter || '').trim();
  if (filter && filter !== String(record.account_id) && filter !== String(record.account_name)) {
    return false;
  }

  var value = ruleField_(record, String(rule.field || ''));
  if (value === null) return false;

  return matchesPattern_(value, String(rule.match_type || 'contains'), String(rule.pattern));
}

/**
 * A rule reads one field, and an unknown field name matches nothing.
 *
 * Returning `null` rather than `''` matters: an empty string would make
 * `contains ""` true for every row, so a typo in the `field` column would
 * quietly recategorise the whole sheet.
 */
function ruleField_(record, field) {
  if (field === 'mcc') return String(record.mcc === null || record.mcc === undefined ? '' : record.mcc);
  if (field === 'description') return String(record.description || '');
  if (field === 'counterparty') return String(record.counterparty || '');
  if (field === 'bank_transaction_code') return String(record.bank_transaction_code || '');
  return null;
}

function matchesPattern_(value, matchType, pattern) {
  if (!pattern) return false;

  var haystack = value.toUpperCase();
  var needle = pattern.toUpperCase();

  if (matchType === 'equals') return haystack === needle;
  if (matchType === 'starts_with') return haystack.indexOf(needle) === 0;
  if (matchType === 'regex') {
    try {
      return new RegExp(pattern, 'i').test(value);
    } catch (e) {
      // A rule you are still typing must not break the run that reads it.
      return false;
    }
  }
  return haystack.indexOf(needle) !== -1;
}

// ---------------------------------------------------------------------------
// Tier 2 — transfers
// ---------------------------------------------------------------------------

/**
 * Pair the two legs of a move between your own accounts.
 *
 * A transfer is money leaving one of your accounts and arriving in another, so
 * it is not spending and not income — and a system that counts it as either
 * inflates both sides by the same amount, which is invisible in the net figure
 * and wrong in every category total. Pairing them is what lets `type=transfer`
 * take both rows out of the reports.
 *
 * BudgetBakers marks that a row *is* a transfer but not which two rows are one
 * transfer, so pairing has to work by amount and proximity regardless — in a
 * real export the two legs of one move were booked three days apart.
 *
 * The guards are all about not inventing a pair:
 *
 *   - amounts equal to the cent, and opposite in sign
 *   - different accounts, since a debit and credit in one account is a
 *     correction, not a move
 *   - inside `transfer_window_days`, nearest date first
 *   - each row pairs at most once
 *   - a row you have categorised as something that is *not* a transfer is left
 *     alone entirely — your override outranks this, and marking it anyway would
 *     leave a `transfer_group` that contradicts the category next to it
 *
 * Sets `_transferGroup` on the records in place and returns how many pairs it
 * made.
 */
function detectTransfers_(records, context) {
  var window = context.transferWindowDays;
  if (!(window >= 0)) window = 4;

  var byAmount = {};
  records.forEach(function (record) {
    record._transferGroup = '';
    if (!transferEligible_(record, context)) return;

    var amount = Number(record.amount);
    if (!isFinite(amount) || amount === 0) return;

    var key = Math.abs(amount).toFixed(2);
    (byAmount[key] = byAmount[key] || []).push(record);
  });

  var pairs = 0;

  Object.keys(byAmount).forEach(function (key) {
    var group = byAmount[key];
    var debits = group.filter(function (r) { return Number(r.amount) < 0; });
    var credits = group.filter(function (r) { return Number(r.amount) > 0; });

    debits.forEach(function (debit) {
      var match = nearestCounterLeg_(debit, credits, window);
      if (!match) return;

      // Derived from the debit's uid so the same pair keeps the same group id
      // on every re-run — a group id that churns would make `transfer_group`
      // useless for anything that remembers it.
      var group_id = 'tr:' + String(debit.uid);
      debit._transferGroup = group_id;
      match._transferGroup = group_id;
      pairs++;
    });
  });

  return pairs;
}

function transferEligible_(record, context) {
  var override = record.category_override;
  if (isBlankCell_(override)) return true;
  return context.kindByCategory[String(override)] === TX_TYPE.TRANSFER;
}

function nearestCounterLeg_(debit, credits, windowDays) {
  var best = null;
  var bestDistance = null;

  for (var i = 0; i < credits.length; i++) {
    var credit = credits[i];
    if (credit._transferGroup) continue;
    if (String(credit.account_id) === String(debit.account_id)) continue;

    var distance = dayDistance_(debit.booking_date, credit.booking_date);
    if (distance === null || distance > windowDays) continue;

    if (bestDistance === null || distance < bestDistance) {
      best = credit;
      bestDistance = distance;
    }
  }

  return best;
}

function dayDistance_(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return null;
  return Math.abs(Math.round((a.getTime() - b.getTime()) / 86400000));
}

// ---------------------------------------------------------------------------
// Running it over the sheet
// ---------------------------------------------------------------------------

/** Menu → Re-categorise all. */
function recategorizeAll() {
  var ui = SpreadsheetApp.getUi();
  var preview = planCategorize_();

  if (preview.error) {
    ui.alert('Re-categorise all', preview.error, ui.ButtonSet.OK);
    return preview;
  }

  var answer = ui.alert('Re-categorise all', describeCategorizePlan_(preview), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Nothing changed.', 'Cancelled', 5);
    return preview;
  }

  var result = commitCategorize_(preview);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    result.changed + ' rows updated, ' + result.pairs + ' transfer pairs.', 'Re-categorised', 10);
  return result;
}

/**
 * What a run would write, computed without writing any of it.
 *
 * Same split as the staged import: the confirmation describes the work that
 * will actually run rather than a second guess at it.
 */
function planCategorize_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TABS.TRANSACTIONS);
  if (!sheet) return { error: 'No ' + TABS.TRANSACTIONS + ' tab. Run Setup sheet first.' };

  var records = readRecords_(sheet, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'));
  if (!records.length) return { error: 'No transactions yet — nothing to categorise.' };

  var context = buildCascadeContext_();
  var pairs = detectTransfers_(records, context);

  var rows = records.map(function (record) {
    var frozen = frozenVerdict_(record);
    var verdict = frozen || categorizeOne_(record, context);

    return {
      _row: record._row,
      frozen: !!frozen,
      category: verdict.category,
      subcategory: verdict.subcategory,
      source: verdict.source,
      transferGroup: record._transferGroup || '',
      was: {
        category: cellText_(record.category_auto),
        subcategory: cellText_(record.subcategory_auto),
        source: cellText_(record.category_source),
        transferGroup: cellText_(record.transfer_group)
      }
    };
  });

  var changed = rows.filter(function (row) {
    return row.category !== row.was.category ||
      row.subcategory !== row.was.subcategory ||
      row.source !== row.was.source ||
      row.transferGroup !== row.was.transferGroup;
  });

  return {
    sheet: sheet,
    rows: rows,
    changed: changed.length,
    frozen: rows.filter(function (row) { return row.frozen; }).length,
    pairs: pairs,
    bySource: tallyBy_(rows, 'source')
  };
}

/**
 * A confirmed row keeps the category it was confirmed with.
 *
 * Confirming means you looked at the row and agreed. Recomputing its guess
 * afterwards would let a later rule change silently move it to a different
 * category while the tick still claims a human agreed with the new one — which
 * makes the flag worth less than not having it.
 *
 * Only applies once there is something to freeze: a confirmed row that has
 * never been categorised at all (a blank `category_auto`) still runs, or an
 * imported history would stay uncategorised forever.
 *
 * An override is a different case and is not frozen — the override is what the
 * sheet displays, so recomputing the guess underneath it changes nothing except
 * how visible the disagreement is.
 */
function frozenVerdict_(record) {
  if (!isConfirmedRow_(record)) return null;
  if (!isBlankCell_(record.category_override)) return null;
  if (isBlankCell_(record.category_auto)) return null;

  return {
    category: cellText_(record.category_auto),
    subcategory: cellText_(record.subcategory_auto),
    source: cellText_(record.category_source) || CATEGORY_SOURCE.MEMORY
  };
}

/** Ticked, or carrying an override — see the `confirmed` note in 00_config. */
function isConfirmedRow_(record) {
  if (isTruthyCell_(record.confirmed)) return true;
  return !isBlankCell_(record.category_override);
}

function cellText_(value) {
  return value === null || value === undefined ? '' : String(value);
}

function tallyBy_(rows, field) {
  var counts = {};
  rows.forEach(function (row) {
    var key = row[field] || '(none)';
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

function describeCategorizePlan_(plan) {
  var lines = [
    'Recompute the category columns for ' + plan.rows.length + ' rows.',
    plan.changed + ' would change.',
    ''
  ];

  Object.keys(plan.bySource).sort().forEach(function (source) {
    lines.push('  ' + source + ': ' + plan.bySource[source]);
  });
  lines.push('');

  if (plan.pairs) lines.push(plan.pairs + ' transfer pairs matched.');
  if (plan.frozen) {
    lines.push(plan.frozen + ' confirmed rows are left exactly as they are.');
  }

  lines.push('');
  lines.push('Only category_auto, subcategory_auto, category_source and transfer_group ' +
    'are written. Your overrides, labels and notes are not touched.');
  lines.push('');
  lines.push('Continue?');
  return lines.join('\n');
}

/**
 * Write only what changed.
 *
 * A free Google account keeps 30 days of version history **or 100 revisions**,
 * whichever runs out first — so a nightly job that rewrites four thousand
 * identical rows burns the history that a real mistake would need. Changed rows
 * are grouped into contiguous runs and written a run at a time, which on a
 * routine sync is the handful of rows that arrived.
 */
function commitCategorize_(plan) {
  var sheet = plan.sheet;
  var first = colIndex_(TX_COLUMNS, 'category_auto');
  var transferColumn = colIndex_(TX_COLUMNS, 'transfer_group');

  var changedRows = plan.rows.filter(function (row) {
    return row.category !== row.was.category ||
      row.subcategory !== row.was.subcategory ||
      row.source !== row.was.source;
  });

  runsOf_(changedRows).forEach(function (run) {
    var values = run.map(function (row) { return [row.category, row.subcategory, row.source]; });
    sheet.getRange(run[0]._row, first, values.length, 3).setValues(values);
  });

  var changedTransfers = plan.rows.filter(function (row) {
    return row.transferGroup !== row.was.transferGroup;
  });

  runsOf_(changedTransfers).forEach(function (run) {
    var values = run.map(function (row) { return [row.transferGroup]; });
    sheet.getRange(run[0]._row, transferColumn, values.length, 1).setValues(values);
  });

  return {
    changed: plan.changed,
    pairs: plan.pairs,
    frozen: plan.frozen,
    bySource: plan.bySource,
    writes: runsOf_(changedRows).length + runsOf_(changedTransfers).length
  };
}

/** Consecutive `_row` values grouped together, so one setValues covers many rows. */
function runsOf_(rows) {
  var runs = [];
  var current = null;

  rows.slice().sort(function (a, b) { return a._row - b._row; }).forEach(function (row) {
    if (current && row._row === current[current.length - 1]._row + 1) {
      current.push(row);
      return;
    }
    current = [row];
    runs.push(current);
  });

  return runs;
}

/**
 * Called by the sync once new rows have landed.
 *
 * Runs the same full pass rather than a cheaper one over just the new rows,
 * because tier 2 has to see both legs of a transfer and the older leg may
 * already be in the sheet. The write is still small — `commitCategorize_` only
 * writes rows whose verdict actually moved.
 *
 * Never throws into the sync: a categorisation that fails must not lose the
 * transactions that were fetched successfully.
 */
function categorizeAfterSync_(config) {
  if (!configFlag_(config, 'categorize_on_sync')) return null;

  try {
    var plan = planCategorize_();
    if (plan.error) return null;
    return commitCategorize_(plan);
  } catch (e) {
    Logger.log('categorizeAfterSync_: ' + e.message);
    logAnomaly_('categorize_failed', '', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

/**
 * Menu → Learn from corrections.
 *
 * Rebuilds `_memory` from the rows you have confirmed. Wholesale rather than
 * incrementally, because the result is the same and a rebuild cannot drift:
 * memory is derived, and the place to record a categorisation you want to
 * *impose* is `rules`, which is yours and is never re-seeded.
 *
 * The confirmed-only filter is the whole point. Learning from every row would
 * train the cascade on its own output — one wrong guess about a frequent
 * merchant becomes a memory entry, which generates more rows carrying the same
 * wrong guess, which reinforces the entry.
 */
function learnFromCorrections() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  var memory = ss.getSheetByName(TABS.MEMORY);
  if (!tx || !memory) {
    ui.alert('Learn from corrections', 'Run Setup sheet first — a tab is missing.', ui.ButtonSet.OK);
    return null;
  }

  var records = readRecords_(tx, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'));
  var derived = deriveMemory_(records);

  if (!derived.entries.length) {
    ui.alert('Learn from corrections',
      'Nothing to learn from yet.\n\n' + derived.considered + ' rows were confirmed, and none ' +
      'produced a usable merchant key. Confirm some rows first — tick `confirmed`, or type a ' +
      '`category_override`, which counts on its own.', ui.ButtonSet.OK);
    return null;
  }

  var answer = ui.alert('Learn from corrections', describeMemoryPlan_(derived), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    ss.toast('Memory left as it was.', 'Cancelled', 5);
    return null;
  }

  writeMemory_(memory, derived.entries);
  ss.toast(derived.entries.length + ' merchants learned from ' + derived.considered +
    ' confirmed rows.', 'Memory rebuilt', 10);
  return derived;
}

/**
 * Confirmed rows → one memory entry per merchant key.
 *
 * The category kept is the one you have given that merchant most often, with
 * ties broken by the most recent — which is the right tiebreak, because a
 * merchant you have started filing differently is usually a merchant that has
 * changed rather than one you keep getting wrong.
 *
 * `hits` records the winner's count rather than the key's total, so an entry
 * built from a disagreement is visibly weak instead of looking as solid as one
 * built from forty consistent rows.
 *
 * Pure: takes records, returns entries. No sheet, so it is tested directly.
 */
function deriveMemory_(records) {
  var buckets = {};
  var considered = 0;

  (records || []).forEach(function (record) {
    if (!isConfirmedRow_(record)) return;

    var category = effectiveCategory_(record);
    if (!category) return;

    // A transfer teaches nothing about a merchant — both legs of one move
    // carry whatever the other account is called, and learning that would
    // categorise real spending at that merchant as a transfer.
    if (String(category) === 'Transfer') return;

    var key = normalizeMerchant(record.description, record.counterparty);
    if (!key) return;

    considered++;
    var subcategory = effectiveSubcategory_(record);
    var bucket = buckets[key] = buckets[key] || { key: key, counts: {}, lastSeen: null };
    var variant = category + '\u0000' + subcategory;

    var seen = bucket.counts[variant] = bucket.counts[variant] ||
      { category: category, subcategory: subcategory, hits: 0, lastSeen: null };
    seen.hits++;

    var date = record.booking_date instanceof Date ? record.booking_date : null;
    if (date && (!seen.lastSeen || date > seen.lastSeen)) seen.lastSeen = date;
    if (date && (!bucket.lastSeen || date > bucket.lastSeen)) bucket.lastSeen = date;
  });

  var entries = Object.keys(buckets).map(function (key) {
    var bucket = buckets[key];
    var winner = null;

    Object.keys(bucket.counts).forEach(function (variant) {
      var candidate = bucket.counts[variant];
      if (!winner || candidate.hits > winner.hits) { winner = candidate; return; }
      if (candidate.hits === winner.hits && candidate.lastSeen && winner.lastSeen &&
        candidate.lastSeen > winner.lastSeen) {
        winner = candidate;
      }
    });

    return {
      merchant_key: key,
      category: winner.category,
      subcategory: winner.subcategory,
      hits: winner.hits,
      last_seen: bucket.lastSeen || ''
    };
  });

  entries.sort(function (a, b) {
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.merchant_key < b.merchant_key ? -1 : 1;
  });

  return { entries: entries, considered: considered };
}

/**
 * What the row is actually categorised as.
 *
 * `category` is a formula column, so on a sheet it is already override-or-auto.
 * Falling back to the two source columns keeps this function usable against
 * records built in a test, where no formula has run.
 */
function effectiveCategory_(record) {
  if (!isBlankCell_(record.category)) return String(record.category);
  if (!isBlankCell_(record.category_override)) return String(record.category_override);
  return isBlankCell_(record.category_auto) ? '' : String(record.category_auto);
}

function effectiveSubcategory_(record) {
  if (!isBlankCell_(record.subcategory)) return String(record.subcategory);
  if (!isBlankCell_(record.category_override)) return '';
  return isBlankCell_(record.subcategory_auto) ? '' : String(record.subcategory_auto);
}

function describeMemoryPlan_(derived) {
  var top = derived.entries.slice(0, 8).map(function (entry) {
    return '  ' + entry.merchant_key + ' → ' + entry.category +
      (entry.subcategory ? ' / ' + entry.subcategory : '') + '  (' + entry.hits + ')';
  });

  var weak = derived.entries.filter(function (entry) { return entry.hits === 1; }).length;

  var lines = [
    'Rebuild ' + TABS.MEMORY + ' from ' + derived.considered + ' confirmed rows.',
    derived.entries.length + ' merchants, most frequent first:',
    ''
  ].concat(top);

  if (derived.entries.length > top.length) {
    lines.push('  … and ' + (derived.entries.length - top.length) + ' more.');
  }
  lines.push('');
  if (weak) lines.push(weak + ' were seen exactly once, so they are a guess with one example behind it.');
  lines.push(TABS.MEMORY + ' is derived — it is replaced, not merged. Put a categorisation you ' +
    'want to impose in ' + TABS.RULES + ' instead, which is never rewritten.');
  lines.push('');
  lines.push('Continue?');
  return lines.join('\n');
}

function writeMemory_(sheet, entries) {
  clearDataRows_(sheet, colIndex_(MEMORY_COLUMNS, 'merchant_key'), MEMORY_COLUMNS.length);
  if (!entries.length) return 0;

  var rows = entries.map(function (entry) { return toRow_(MEMORY_COLUMNS, entry); });
  sheet.getRange(2, 1, rows.length, MEMORY_COLUMNS.length).setValues(rows);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Confirming
// ---------------------------------------------------------------------------

/**
 * Menu → Confirm visible rows.
 *
 * Confirming has to be cheap in bulk or it stops happening. Filter to a
 * merchant, glance down the column, confirm forty rows at once — anything that
 * costs one interaction per row is abandoned by the second month, and then the
 * flag means nothing.
 *
 * A selection of two or more rows wins, because it is the more explicit
 * statement; otherwise the sheet's filter decides. With neither, this refuses
 * rather than confirming everything: ticking four thousand rows by accident is
 * precisely the mistake worth a wall in front of it, and it is not undoable in
 * any way that leaves the flag meaning what it claims.
 */
function confirmVisibleRows() {
  var ui = SpreadsheetApp.getUi();
  var sheet = sheetOrThrow_(TABS.TRANSACTIONS);
  var target = confirmableRows_(sheet);

  if (target.error) {
    ui.alert('Confirm visible rows', target.error, ui.ButtonSet.OK);
    return target;
  }

  var answer = ui.alert('Confirm visible rows',
    'Mark ' + target.rows.length + ' rows as confirmed (' + target.via + ').\n\n' +
    'Confirmed rows keep the category they have now, and are the only rows ' +
    '"Learn from corrections" reads.\n\nContinue?', ui.ButtonSet.YES_NO);

  if (answer !== ui.Button.YES) {
    SpreadsheetApp.getActiveSpreadsheet().toast('Nothing confirmed.', 'Cancelled', 5);
    return target;
  }

  var column = colIndex_(TX_COLUMNS, 'confirmed');
  runsOf_(target.rows.map(function (row) { return { _row: row }; })).forEach(function (run) {
    var values = run.map(function () { return [true]; });
    sheet.getRange(run[0]._row, column, values.length, 1).setValues(values);
  });

  SpreadsheetApp.getActiveSpreadsheet().toast(
    target.rows.length + ' rows confirmed.', 'Confirmed', 10);
  return { confirmed: target.rows.length, via: target.via };
}

function confirmableRows_(sheet) {
  var last = lastRecordRow_(sheet, colIndex_(TX_COLUMNS, 'uid'));
  if (last < 2) return { error: 'No transactions yet.' };

  var selected = selectedDataRows_(sheet, last);
  if (selected.length >= 2) return { rows: selected, via: 'selected' };

  var filtered = filterVisibleRows_(sheet, last);
  if (filtered) return { rows: filtered, via: 'visible under the current filter' };

  return {
    error: 'Select the rows to confirm, or put a filter on ' + TABS.TRANSACTIONS + ' first.\n\n' +
      'Confirming every row at once is deliberately not offered — it would mark ' +
      (last - 1) + ' rows as reviewed by a human, which is the one thing this flag is ' +
      'supposed to mean.'
  };
}

function selectedDataRows_(sheet, last) {
  var range = sheet.getActiveRange && sheet.getActiveRange();
  if (!range) return [];

  var start = Math.max(range.getRow(), 2);
  var end = Math.min(range.getRow() + range.getNumRows() - 1, last);

  var rows = [];
  for (var row = start; row <= end; row++) rows.push(row);
  return rows;
}

function filterVisibleRows_(sheet, last) {
  if (!sheet.getFilter || !sheet.getFilter()) return null;

  var rows = [];
  for (var row = 2; row <= last; row++) {
    if (!sheet.isRowHiddenByFilter(row)) rows.push(row);
  }
  return rows;
}
