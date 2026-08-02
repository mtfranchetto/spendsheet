/**
 * 18_diagnostics.gs — the tools for when the code says it worked and the
 * sheet disagrees.
 *
 * These are not features and none of them runs unattended. They exist because
 * every real bug in this project so far was solved the same way: stop
 * theorising about what the API or the sheet is doing, and go and print it.
 * Guessing had a poor record; dumping the raw response settled it every time.
 *
 * They live together so they can be recognised as a set and, once a provider
 * is understood, ignored as a set.
 */

// ---------------------------------------------------------------------------
// Smoke tests
// ---------------------------------------------------------------------------

/**
 * Checks that need the Google runtime and a live API, so they cannot run in
 * CI. Results go to the `_tests` tab.
 *
 * The unit tests prove the logic against fakes; these prove the parts a fake
 * cannot — that the credentials are installed, the JWT is accepted, and the
 * spreadsheet takes what we hand it. The locale `#ERROR!` bug passed every
 * unit test there was, which is the argument for this file existing.
 */
function runSmokeTests() {
  var results = [];
  var env = ebEnvironment();

  results.push(smokeTest_('credentials', 'installed for ' + env, function () {
    var creds = ebCredentials_();
    return 'application ' + creds.applicationId.slice(0, 8) + '…';
  }));

  results.push(smokeTest_('jwt', 'signs and decodes', function () {
    var payload = decodeJwtPayload(ebJwt_());
    if (payload.aud !== JWT_AUDIENCE) throw new Error('unexpected audience ' + payload.aud);
    return 'expires in ' + (payload.exp - Math.floor(Date.now() / 1000)) + 's';
  }));

  results.push(smokeTest_('api', 'GET /application', function () {
    var app = ebGetApplication();
    return app.name || app.kid || 'ok';
  }));

  results.push(smokeTest_('api', 'GET /aspsps', function () {
    var banks = ebListAspsps();
    if (!banks.length) throw new Error('no banks returned');
    return banks.length + ' banks, e.g. ' + banks[0].name;
  }));

  results.push(smokeTest_('sheet', 'formulas parse in this locale', function () {
    // A localisation failure shows up as #ERROR! in the cell and as nothing
    // at all anywhere else.
    var broken = brokenFormulaCells_();
    if (broken.length) throw new Error('#ERROR! in ' + broken.join(', '));
    return 'all formula cells evaluate';
  }));

  writeTestResults_(results);

  var failed = results.filter(function (r) { return r.result !== 'PASS'; }).length;
  SpreadsheetApp.getActiveSpreadsheet().toast(
    failed ? failed + ' of ' + results.length + ' checks failed — see the _tests tab'
           : 'All ' + results.length + ' checks passed',
    'Smoke tests', 10);

  return results;
}

function smokeTest_(suite, name, fn) {
  try {
    return { suite: suite, name: name, result: 'PASS', detail: String(fn()) };
  } catch (e) {
    return { suite: suite, name: name, result: 'FAIL', detail: e.message };
  }
}

/** Every anchor cell setup() writes a formula into, reported if it errored. */
function brokenFormulaCells_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var anchors = [
    [TABS.TRANSACTIONS, colOf(TX_COLUMNS, 'amount_eur')],
    [TABS.TRANSACTIONS, colOf(TX_COLUMNS, 'category')],
    [TABS.TRANSACTIONS, colOf(TX_COLUMNS, 'subcategory')],
    [TABS.TRANSACTIONS, colOf(TX_COLUMNS, 'type')],
    [TABS.ACCOUNTS, colOf(ACCOUNT_COLUMNS, 'balance')],
    [TABS.STATUS, colOf(STATUS_COLUMNS, 'days_left')],
    [TABS.STATUS, colOf(STATUS_COLUMNS, 'state')]
  ];

  return anchors.filter(function (anchor) {
    var sheet = ss.getSheetByName(anchor[0]);
    if (!sheet) return true;
    return String(sheet.getRange(anchor[1] + '2').getValue()).indexOf('#') === 0;
  }).map(function (anchor) { return anchor[0] + '!' + anchor[1] + '2'; });
}

function writeTestResults_(results) {
  var sheet = sheetOrThrow_(TABS.TESTS);
  var now = new Date();
  appendRows_(sheet, 1, results.map(function (r) {
    return [now, r.suite, r.name, r.result, r.detail];
  }));
}

// ---------------------------------------------------------------------------
// Raw dumps
// ---------------------------------------------------------------------------

/**
 * Dump every session's raw JSON into _anomalies.
 *
 * Response shape varies by bank, and this is the probe that settles it. Every
 * entry in docs/PROVIDERS.md came from here.
 *
 * All of them rather than the first, because the questions worth asking are
 * comparisons: whether two sessions for the same bank describe the same
 * accounts, and which fields survive between them.
 */
function inspectSession() {
  var status = sheetOrThrow_(TABS.STATUS);
  var ids = readColumn_(status, colIndex_(STATUS_COLUMNS, 'session_id'))
    .filter(function (id) { return id; });
  if (!ids.length) throw new Error('No connection in _status yet.');

  var sessions = [];
  ids.forEach(function (id) {
    try {
      var session = ebGetSession(id);
      sessions.push({ id: id, session: session });
      logAnomaly_(ANOMALY_KIND.RAW_DUMP, '',
        'GET /sessions/' + id + ' — top-level keys: ' + Object.keys(session || {}).join(', '),
        session);
    } catch (e) {
      logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'GET /sessions/' + id + ' failed: ' + e.message, '');
    }
  });

  var stability = compareAccountIdentity_(sessions);
  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'account identity across ' + sessions.length +
    ' session(s): ' + stability.verdict, stability);

  SpreadsheetApp.getActiveSpreadsheet()
    .toast(stability.verdict + '\n\nDetail in _anomalies.', 'Sessions inspected', 30);
  return stability;
}

/**
 * Whether anything about an account survives a new consent.
 *
 * `uid` demonstrably does not — reconnecting a bank produces a fresh one for
 * the same IBAN, which is what makes every account row duplicate and every
 * transaction hash differently. The question this answers is whether
 * `identification_hash` is the stable key the name suggests, because if it is,
 * it is a far better thing to key on than anything we could infer ourselves.
 *
 * Reports rather than decides. A probe that guessed would be how the wrong
 * key got baked into transaction identity.
 */
function compareAccountIdentity_(sessions) {
  var byHash = {};
  var byIban = {};
  var accounts = [];

  sessions.forEach(function (entry) {
    var data = (entry.session && entry.session.accounts_data) || [];
    data.forEach(function (account) {
      var hash = account.identification_hash ||
        (account.identification_hashes || [])[0] || '';
      var iban = (account.account_id && account.account_id.iban) || account.iban || '';

      accounts.push({
        session: entry.id,
        uid: account.uid || '',
        identification_hash: hash,
        iban_masked: maskIban(iban),
        currency: account.currency || ''
      });

      if (hash) (byHash[hash] = byHash[hash] || []).push(account.uid || '');
      if (iban) (byIban[maskIban(iban)] = byIban[maskIban(iban)] || []).push(account.uid || '');
    });
  });

  var withHash = accounts.filter(function (a) { return a.identification_hash; }).length;
  var reused = Object.keys(byHash).filter(function (h) {
    return unique_(byHash[h]).length > 1;
  });

  var verdict;
  if (!accounts.length) verdict = 'No accounts_data in any session.';
  else if (!withHash) verdict = 'No identification_hash on any account — it cannot be the key.';
  else if (sessions.length < 2) verdict = 'identification_hash present, but only one session: ' +
    'reconnect a bank and run this again to see whether it survives.';
  else if (reused.length) verdict = 'identification_hash is STABLE — ' + reused.length +
    ' hash(es) span more than one uid. Key on it.';
  else verdict = 'identification_hash present but no hash spans two uids. ' +
    'Either the sessions cover different accounts, or it is not stable.';

  return { verdict: verdict, accounts: accounts, byHash: byHash, byIban: byIban };
}

function unique_(values) {
  var seen = {};
  var out = [];
  (values || []).forEach(function (value) {
    if (seen[value]) return;
    seen[value] = true;
    out.push(value);
  });
  return out;
}

/**
 * Dump the raw /details response for every account.
 *
 * Which field carries a usable account label varies by provider and is not
 * something documentation settles. Mock ASPSP, for instance, puts the account
 * *holder* in `name` and leaves `product` null.
 */
function inspectAccountDetails() {
  var sheet = sheetOrThrow_(TABS.ACCOUNTS);
  // The provider's current uid, not our frozen one — this calls the API.
  var uids = readRecords_(sheet, ACCOUNT_COLUMNS)
    .map(function (row) { return row.provider_account_id || row.account_id; })
    .filter(function (uid) { return uid; });
  if (!uids.length) throw new Error('No accounts yet.');

  uids.forEach(function (uid) {
    try {
      var details = ebGetAccountDetails(uid);
      logAnomaly_(ANOMALY_KIND.RAW_DUMP, uid,
        'GET /accounts/{uid}/details — keys: ' + Object.keys(details || {}).join(', '), details);
    } catch (e) {
      logAnomaly_(ANOMALY_KIND.RAW_DUMP, uid, 'GET /accounts/{uid}/details failed: ' + e.message, '');
    }
  });

  SpreadsheetApp.getActiveSpreadsheet()
    .toast(uids.length + ' account(s) inspected. See _anomalies.', 'Details dumped', 10);
  return uids.length;
}

/**
 * Dump one page of raw transactions for every account.
 *
 * The phase 3b probe question, in code: does this bank populate
 * `entry_reference` and `merchant_category_code`, and what does it actually
 * put in `remittance_information`? Those three determine whether dedup uses
 * the strong key and whether MCC rules fire at all — and no documentation
 * answers them per bank.
 */
function inspectTransactions() {
  var accounts = listSyncableAccounts_();
  if (!accounts.length) throw new Error('No bank accounts to inspect.');

  accounts.forEach(function (account) {
    try {
      var page = ebGetTransactionsPage(account.uid, {
        dateFrom: isoDay_(new Date(), -30),
        status: TX_STATUS.BOOKED
      });
      var list = page.transactions || [];
      logAnomaly_(ANOMALY_KIND.RAW_DUMP, account.uid,
        list.length + ' booked in 30 days. ' + summariseCoverage_(list),
        list.slice(0, 5));
    } catch (e) {
      logAnomaly_(ANOMALY_KIND.RAW_DUMP, account.uid, 'transactions probe failed: ' + e.message, '');
    }
  });

  SpreadsheetApp.getActiveSpreadsheet()
    .toast(accounts.length + ' account(s) probed. See _anomalies.', 'Transactions dumped', 10);
  return accounts.length;
}

/** The three fields whose presence changes how the rest of the system behaves. */
function summariseCoverage_(list) {
  function pct(predicate) {
    if (!list.length) return 'n/a';
    return Math.round(100 * list.filter(predicate).length / list.length) + '%';
  }
  return 'entry_reference ' + pct(function (t) { return t && t.entry_reference; }) +
    ', mcc ' + pct(function (t) { return t && t.merchant_category_code; }) +
    ', remittance_information ' + pct(function (t) {
      return t && t.remittance_information && t.remittance_information.length;
    });
}

/**
 * Report what the accounts tab actually looks like to the script, including
 * whether a write to it survives.
 *
 * For when the code reports success and the sheet disagrees — at that point
 * every remaining explanation is about the sheet rather than the logic.
 */
function diagnoseAccounts() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(TABS.ACCOUNTS);

  var report = {
    tabsInBook: ss.getSheets().map(function (s) { return s.getName(); }),
    accountsTabFound: Boolean(sheet)
  };

  if (sheet) {
    var idColumn = colIndex_(ACCOUNT_COLUMNS, 'account_id');
    report.lastRow = sheet.getLastRow();
    report.lastColumn = sheet.getLastColumn();
    report.maxRows = sheet.getMaxRows();
    report.maxColumns = sheet.getMaxColumns();
    report.hidden = sheet.isSheetHidden();
    report.headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn() || 1).getValues()[0];
    report.firstRows = sheet.getRange(1, 1, Math.min(6, sheet.getMaxRows()), 3).getValues();
    report.lastRecordRow = lastRecordRow_(sheet, idColumn);
    report.computedAppendRow = nextEmptyRow_(sheet, idColumn);

    // Does a write to that cell actually stick?
    var probeRow = report.computedAppendRow;
    sheet.getRange(probeRow, idColumn).setValue('__probe__');
    SpreadsheetApp.flush();
    report.probeReadBack = sheet.getRange(probeRow, idColumn).getValue();
    sheet.getRange(probeRow, idColumn).clearContent();
    report.probeWrittenToRow = probeRow;
  }

  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'accounts tab diagnosis', report);
  ss.toast('Written to _anomalies.', 'Diagnosed', 10);
  return report;
}
