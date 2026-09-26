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
  requireInteractive_();
  var results = [];
  var env = ebEnvironment_();

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
    var app = ebGetApplication_();
    return app.name || app.kid || 'ok';
  }));

  results.push(smokeTest_('api', 'GET /aspsps', function () {
    var banks = ebListAspsps_();
    if (!banks.length) throw new Error('no banks returned');
    return banks.length + ' banks, e.g. ' + banks[0].name;
  }));

  // Named for what it checks rather than for the bug that prompted it. It was
  // called "formulas parse in this locale", which is one of the two things it
  // finds, and the label sent a column-alignment failure to be fixed as a
  // localisation failure twice.
  results.push(smokeTest_('sheet', 'every formula anchor evaluates', function () {
    var broken = brokenFormulaCells_();
    if (broken.length) throw new Error(broken.join(', ') +
      ' — #ERROR! means the formula is wrong (fix the code), ' +
      '#REF! means something is in the column under it (fix the sheet)');
    return formulaAnchors_().length + ' formula cells evaluate';
  }));

  results.push(smokeTest_('sheet', 'in_reports is a boolean, not text', function () {
    return describeInReports_();
  }));

  // `textSafe_` rests entirely on a claim about the live runtime that no fake
  // can settle: that Sheets consumes a leading apostrophe as a "this is text"
  // marker, so the value comes back out of `getValue` without it. If that is
  // wrong the guard is not merely useless — it silently rewrites every bank
  // description that happens to start with a minus sign. The harness agrees
  // with production here because it was told to; this asks the spreadsheet.
  results.push(smokeTest_('sheet', 'a formula-shaped description stores as text', function () {
    return checkTextSafeRoundTrip_();
  }));

  results.push(smokeTest_('sheet', 'every subcategory names one category', function () {
    return describeSubcategoryParents_();
  }));

  // A book whose `owner_email` is blank refuses everyone, including you, and
  // the symptom is a page that says "not available" with nothing to read. That
  // is a live-runtime fact — `setup()` fills the row from `getEffectiveUser()`,
  // which the harness can only fake — so it belongs here rather than in a test.
  results.push(smokeTest_('web app', 'the phone app has an owner', function () {
    var owner = webAppOwner_();
    if (!owner) {
      throw new Error('owner_email is blank in _config, so the web app refuses everyone. ' +
        'Re-run Setup sheet, or type your address into that row.');
    }
    if (!webAppAccessDecision_(owner, activeUserEmail_()).ok) {
      throw new Error('owner_email is ' + owner + ', which is not the account running this. ' +
        'The web app will refuse you. Diagnostics → Check web app access has the detail.');
    }
    return owner + ' can open the web app';
  }));

  // The one check here that writes something outside the book, and the only
  // kind of check that could have caught the snapshot: whether Google permits
  // the write is a fact about this book's consent, invisible to a fake. The
  // trigger failed weekly for months, mailed each failure to the same address
  // as every other alert, and nothing in the sheet disagreed with it.
  results.push(smokeTest_('backup', 'Drive accepts a file from this script', function () {
    return checkSnapshotPermitted_();
  }));

  // The page is assembled by Google, from files this project only ever hands
  // over — so whether a partial arrives as JavaScript or as HTML *about*
  // JavaScript is not a fact the harness holds. It read the same files off
  // disk and passed on a page whose every screen was a syntax error.
  results.push(smokeTest_('web app', 'the page arrives as JavaScript', function () {
    return checkPageAssembly_();
  }));

  results.push(smokeTest_('sheet', 'every chart points at data', function () {
    var empty = emptyCharts_();
    if (empty.length) throw new Error('nothing to plot in ' + empty.join(', '));
    return chartsInBook_().length + ' charts have data behind them';
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

/**
 * Every cell setup() writes a formula into, as `tab!A1`.
 *
 * Listed rather than discovered, because a formula that failed to *land* is
 * exactly as broken as one that failed to parse, and scanning for whatever
 * happens to be there cannot tell the difference.
 *
 * The dashboard and reports entries are the ones that matter most: almost
 * everything on those two tabs is a generated string, and the harness cannot
 * hand one to a spreadsheet. This is the only check in the project that can.
 */
function formulaAnchors_() {
  // Derived from the list `applyFormulas_` writes, not kept beside it.
  //
  // This was a hand-maintained copy and it was wrong in the way a hand-
  // maintained copy is always eventually wrong: it named
  // `categories.parent_list` and none of the three columns next to it, so a
  // book where all four had stopped spilling was reported as having one broken
  // anchor — and the other three went on being blank while a check called
  // "every formula anchor evaluates" passed on them by never looking.
  var anchors = schemaFormulas_().map(function (entry) {
    return [entry.tab, colOf(entry.columns, entry.column) + '2'];
  });

  if (typeof REPORT !== 'undefined') {
    ['E' + REPORT.WINDOW_ROW, 'E' + (REPORT.WINDOW_ROW + 1),
      'E' + REPORT.QUERY_ROW, 'E' + (REPORT.QUERY_ROW + 1),
      'A' + REPORT.RESULT_ROW, 'C' + REPORT.RESULT_ROW,
      REPORT.MONTH_COL + REPORT.MONTH_ROW,
      nextColumn_(REPORT.MONTH_COL, 3) + REPORT.MONTH_ROW,
      nextColumn_(REPORT.MONTH_COL, 4) + REPORT.MONTH_ROW,
      nextColumn_(REPORT.YOY_COL, 1) + REPORT.YOY_ROW
    ].forEach(function (a1) { anchors.push([TABS.REPORTS, a1]); });
  }

  return anchors;
}

/**
 * The anchors that errored, or that have no formula in them at all, each with
 * the error it is actually showing.
 *
 * A blank anchor is reported too. `setValues` one column too wide silently
 * deletes an ARRAYFORMULA, and the symptom of that is a cell holding nothing
 * — which reads as "no data yet" rather than as damage.
 *
 * The error **text** is part of the report because the two that turn up here
 * demand opposite repairs and this check cannot tell them apart on its own:
 *
 *   `#ERROR!` is a parse failure — the formula is wrong, or was written with
 *   commas into a decimal-comma locale. Fix the code.
 *
 *   `#REF!` in an anchor is a refused expansion — the formula is fine and
 *   something is sitting in the column under it. Fix the sheet, and see
 *   `spillReason_` for what to look at.
 *
 * Reporting only the cell reference sent two repairs down the wrong path: a
 * column shifted out from under its header read as a locale bug, because the
 * check that found it is named after the locale bug.
 */
function brokenFormulaCells_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  return formulaAnchors_().map(function (anchor) {
    var where = anchor[0] + '!' + anchor[1];

    var sheet = ss.getSheetByName(anchor[0]);
    if (!sheet) return where + ' (no such tab)';

    var cell = sheet.getRange(anchor[1]);
    if (!cell.getFormula()) return where + ' (no formula in it at all)';

    var value = String(cell.getValue());
    if (value.indexOf('#') !== 0) return null;

    // A `#REF!` in a row-2 anchor has a blocking cell, and naming it is the
    // difference between a repair and a search. `describeInReports_` proved
    // that on the one column wired to call it; every ARRAYFORMULA anchor in
    // the book has the same failure mode and deserves the same answer.
    if (value.indexOf('#REF') === 0 && cell.getRow() === 2) {
      return where + ' ' + value + ' — ' +
        spillReason_(sheet, cell.getColumn(), cell.getA1Notation().replace(/\d+$/, ''));
    }
    return where + ' ' + value;
  }).filter(function (entry) { return entry; });
}

/**
 * Whether `in_reports` really produced booleans.
 *
 * The single most fragile assumption in the reporting layer, and one no unit
 * test can reach: QUERY infers a column's type from what is in it, and
 * `where AC = true` against a column Sheets decided was text matches nothing
 * — silently, and only on some books. Reading the cell back is the only way
 * to know which kind of column it built.
 */
function describeInReports_() {
  var sheet = sheetOrThrow_(TABS.TRANSACTIONS);
  var column = colOf(TX_COLUMNS, 'in_reports');

  var first = sheet.getRange(column + '2').getValue();
  if (typeof first !== 'boolean') {
    throw new Error(column + '2 holds ' + (typeof first) + ' "' + first +
      '", not a boolean — every report gated on it will be empty. ' +
      spillReason_(sheet, colIndex_(TX_COLUMNS, 'in_reports'), column));
  }

  var last = lastRecordRow_(sheet, colIndex_(TX_COLUMNS, 'uid'));
  if (last < 2) return 'no transactions yet, and the column is still a boolean';

  var included = sheet.getRange(2, colIndex_(TX_COLUMNS, 'in_reports'), last - 1, 1)
    .getValues().filter(function (row) { return row[0] === true; }).length;

  return included + ' of ' + (last - 1) + ' rows count as spending';
}

/**
 * Whether a subcategory still identifies exactly one parent.
 *
 * `category` resolves a `subcategory_override` to its parent through a
 * VLOOKUP, which takes the **first** match and says nothing about the second.
 * Two parents sharing a child name therefore produce a category that is right
 * for one of them and quietly wrong for the other — and `child_list`, which
 * every subcategory dropdown points at, is a SORTED UNIQUE list, so the two
 * are already one indistinguishable entry before the lookup is reached.
 *
 * The seed is held to this by `tests/categorize.test.mjs`. This exists because
 * the tab is yours to extend, and the natural way to extend it — a `Home`
 * under a new parent, an `Other` under everything — is exactly the collision.
 */
function describeSubcategoryParents_() {
  var sheet = sheetOrThrow_(TABS.CATEGORIES);
  var last = lastRecordRow_(sheet, colIndex_(CATEGORY_COLUMNS, 'subcategory'));
  if (last < 2) return 'no categories yet';

  var parents = {};
  sheet.getRange(2, 1, last - 1, 2).getValues().forEach(function (row) {
    var child = String(row[1] || '').trim();
    var parent = String(row[0] || '').trim();
    if (!child || !parent) return;

    if (!parents[child]) parents[child] = [];
    if (parents[child].indexOf(parent) === -1) parents[child].push(parent);
  });

  var names = Object.keys(parents);
  var ambiguous = names.filter(function (child) { return parents[child].length > 1; });

  if (ambiguous.length) {
    throw new Error(ambiguous.map(function (child) {
      return '"' + child + '" sits under ' + parents[child].join(' and ');
    }).join('; ') + '. Picking it cannot say which, so the category takes the first ' +
      'and the rest are silently wrong. Rename all but one.');
  }
  return names.length + ' subcategories, each naming one category';
}

/**
 * Why an array formula anchored at row 2 produced one cell instead of a column.
 *
 * `#REF!` in the anchor of an ARRAYFORMULA means one thing: Sheets refused to
 * expand it because something is already in the way. The cell says `#REF!` and
 * the reason lives in a tooltip — which is exactly the kind of thing you find
 * by hovering a cell on a laptop and cannot find at all on a phone, so the
 * check that noticed the column is broken names the blocking cell too.
 *
 * The blocker is almost always a column you added yourself at the position the
 * schema has since grown into: `buildTable_` writes the header row over it, so
 * the symptom is one broken formula and a header that changed name, neither of
 * which points at the other.
 *
 * The message has to say the **type** and the **extent**, not just the cell.
 * A boolean `false` and the text `"false"` print identically once they are
 * concatenated into a string, and they mean opposite things: one is a column
 * of ours that got frozen into values, the other is something typed or pasted.
 * Nor does one cell distinguish a whole column from a single stray paste. The
 * first version of this message said `AC3 already holds "false"` and was
 * compatible with four different repairs, which is not a diagnosis.
 *
 * Reads the whole column in one call — a scan looking for the first non-empty
 * cell, one `getValue()` at a time, is a thousand round-trips on a book that
 * has nothing wrong with it.
 */
function spillReason_(sheet, index, column) {
  var height = sheet.getMaxRows() - 2;
  if (height < 1) return 'There is no room below ' + column + '2 to expand into.';

  var below = sheet.getRange(3, index, height, 1).getValues();
  var formulas = sheet.getRange(3, index, height, 1).getFormulas();

  var first = -1;
  var filled = 0;
  var written = 0;
  for (var i = 0; i < below.length; i++) {
    if (isBlankCell_(below[i][0])) continue;
    if (first === -1) first = i;
    filled++;
    if (formulas[i][0]) written++;
  }
  if (first === -1) {
    return 'Nothing below it is blocking the expansion, so the formula in ' + column +
      '2 is itself what failed — read it there.';
  }

  return 'The array cannot expand: ' + column + (first + 3) + ' holds ' +
    describeCell_(below[first][0]) + ', and ' + filled + ' of the ' + height +
    ' cells below ' + column + '2 are not empty (' + written + ' of them formulas). ' +
    'If that column is yours, move it to the right of the schema; if it is left ' +
    'over, clear ' + column + '3:' + column + '. Then re-run Setup sheet.';
}

/**
 * A cell value with its type, because the two that matter here print alike.
 *
 * `'' + false` and `'' + 'false'` are both `false` on screen, and the first
 * means a boolean column of ours turned into values while the second means
 * text arrived from somewhere else.
 */
function describeCell_(value) {
  if (value instanceof Date) return 'the date ' + value.toISOString().slice(0, 10);
  if (typeof value === 'string') return 'the text "' + value + '"';
  return 'the ' + (typeof value) + ' ' + value;
}

/** Every chart in the book, with the tab it sits on. */
function chartsInBook_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var found = [];

  [TABS.REPORTS].forEach(function (name) {
    var sheet = ss.getSheetByName(name);
    if (!sheet) return;
    sheet.getCharts().forEach(function (chart) {
      found.push({ tab: name, sheet: sheet, chart: chart });
    });
  });
  return found;
}

/**
 * Charts whose ranges are entirely empty.
 *
 * A chart pointed at nothing draws nothing, forever, and says nothing about
 * why — which is indistinguishable from "you have not spent anything yet".
 * The ranges are fixed when the chart is created, so this is the check that
 * catches a block that moved out from under one.
 */
function emptyCharts_() {
  return chartsInBook_().filter(function (entry) {
    var ranges = entry.chart.getRanges ? entry.chart.getRanges() : [];
    var filled = 0;

    ranges.forEach(function (range) {
      range.getValues().forEach(function (row) {
        row.forEach(function (cell) { if (!isBlankCell_(cell)) filled++; });
      });
    });
    return filled === 0;
  }).map(function (entry) {
    var options = entry.chart.getOptions ? entry.chart.getOptions() : null;
    return entry.tab + ': ' + (options ? options.get('title') : 'a chart');
  });
}

/**
 * Write a formula-shaped string through the guard and read it back.
 *
 * The probe goes far to the right of `_tests`, on a tab nothing formats,
 * nothing charts and nothing queries, and is cleared whichever way this ends —
 * a diagnostic that leaves a cell behind on failure is a diagnostic that gets
 * blamed for the next run's mystery.
 *
 * Two things have to hold and they fail differently. The cell must not carry a
 * *formula*, which is the attack; and `getValue` must return the original text,
 * which is whether the guard is lossless. Reporting them separately matters,
 * because "stored safely but mangled" and "stored as a live formula" are
 * opposite bugs with the same one-line cause.
 */
function checkTextSafeRoundTrip_() {
  var sheet = sheetOrThrow_(TABS.TESTS);
  var probe = sheet.getRange(1, 26);
  var sample = '=1+1';

  try {
    probe.setValue(textSafe_(sample));
    var formula = probe.getFormula();
    var value = probe.getValue();

    if (formula) {
      throw new Error('Sheets kept "' + formula + '" as a formula despite the ' +
        'apostrophe, so textSafe_ does not defuse anything on this book');
    }
    if (value !== sample) {
      throw new Error('read back "' + value + '" rather than "' + sample +
        '" — textSafe_ is altering the text it guards');
    }
    return 'stored as text and read back unchanged';
  } finally {
    probe.clearContent();
  }
}

/**
 * The partials reach the page as JavaScript, and not as markup about it.
 *
 * `page.html` is a shell of `include_` scriptlets over a dozen files of bare
 * JavaScript, and the first `<` in one of those is a less-than rather than a
 * tag. Read a partial through an `HtmlOutput` — which is what
 * `createHtmlOutputFromFile(name).getContent()` does, the include idiom out of
 * Google's own documentation — and it comes back as HTML, so that `<` returns
 * escaped. `page.core`'s first loop arrived as `i &lt; arguments.length`,
 * which is a syntax error, and one syntax error discards the entire block: the
 * app kept the `Loading…` its shell ships with and no screen ever drew.
 *
 * **Nothing in the harness can settle this**, and that is the point of the
 * check. Its `HtmlService` reads the same files off disk and has no HTML
 * parser to escape anything with, so both the broken call and the working one
 * return the file — the suite passed, green, on a page that could not run.
 * Whether Google escapes a character is a fact about Google, exactly as
 * whether Drive permits a write is a fact about this book's consent.
 *
 * The partials are read out of `page.html` rather than listed here. A list
 * would be a hand-maintained copy of the shell, and a copy is wrong the first
 * time a partial is added — silently, by checking eleven of twelve.
 *
 * `&lt;` is the whole assertion because no partial contains one to begin with:
 * `tests/app.test.mjs` pins that, which is what makes its presence here proof
 * of a round trip through markup rather than something someone typed.
 */
function checkPageAssembly_() {
  if (typeof include_ !== 'function') {
    throw new Error('include_ is not in this project, so no page is being served');
  }

  var shell = HtmlService.createTemplateFromFile('page').getRawContent();
  var names = [];
  var pattern = /include_\(\s*['"]([\w.-]+)['"]\s*\)/g;
  var found;
  while ((found = pattern.exec(shell)) !== null) names.push(found[1]);

  if (!names.length) {
    throw new Error('page.html includes no partials — the shell is not the shell');
  }

  var escaped = [];
  var characters = 0;
  names.forEach(function (name) {
    var content = include_(name);
    characters += content.length;
    if (content.indexOf('&lt;') !== -1) escaped.push(name);
  });

  if (escaped.length) {
    throw new Error(escaped.join(', ') + ' arrived HTML-escaped, so the page is a ' +
      'syntax error and every screen is blank. include_ must read through ' +
      'getRawContent(), not through an HtmlOutput.');
  }

  return names.length + ' partials, ' + characters + ' characters, none escaped';
}

function writeTestResults_(results) {
  var sheet = sheetOrThrow_(TABS.TESTS);
  var now = new Date();
  appendRows_(sheet, 1, results.map(function (r) {
    return [now, r.suite, r.name, r.result, r.detail];
  }));
}

// ---------------------------------------------------------------------------
// The web app
// ---------------------------------------------------------------------------

/**
 * Who this deployment thinks you are, from the deployment itself.
 *
 * The mobile web app is served from a second deployment of this project with a
 * different access setting, and the owner gate turns entirely on what
 * `Session.getActiveUser().getEmail()` returns *there*. The documentation on
 * that is a maze of caveats — same domain, consumer account, execute-as — and
 * every one of them is a claim about a deployment rather than about code. So
 * this reports what actually happens, and you run it from both URLs.
 *
 * What each door should say:
 *
 *   Door 1 (the consent redirect, access Anyone) — `activeUser` blank when
 *   opened signed out, and `allowed` false. That is the negative test: it is
 *   the URL a stranger could find.
 *
 *   Door 2 (the app, access Only myself) — `activeUser` equal to `owner`, and
 *   `allowed` true.
 *
 * There is deliberately **no query parameter that runs this from a URL**. Such
 * a parameter would have to answer before the gate, to be worth anything from
 * Door 1, and what it answers with includes the owner address. What Door 1
 * gives you instead is the refusal page itself, which is the same finding
 * stated as a behaviour rather than as a report — and the only one an
 * anonymous visitor should ever see.
 */
function describeWebAppContext() {
  requireInteractive_();
  var report = {
    activeUser: safeEmail_(function () { return Session.getActiveUser().getEmail(); }),
    effectiveUser: safeEmail_(function () { return Session.getEffectiveUser().getEmail(); }),
    owner: typeof webAppOwner_ === 'function' ? webAppOwner_() : '(20_webapp.gs not loaded)',
    deploymentUrl: detectedWebAppUrl_(),
    pinnedRedirectUrl:
      PropertiesService.getScriptProperties().getProperty(EB_PROP.REDIRECT_URL) || ''
  };

  report.allowed = typeof webAppAccessDecision_ === 'function'
    ? webAppAccessDecision_(report.owner, report.activeUser).ok
    : false;

  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'web app context', report);

  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Owner: ' + (report.owner || '(none — the app refuses everyone)') +
    '\nYou: ' + report.activeUser +
    '\nThis context would ' + (report.allowed ? 'be let in' : 'be refused') +
    '.\n\nFull detail in _anomalies.', 'Web app access', 30);

  return report;
}

/** A Session call that answers rather than throws, since a throw is the finding. */
function safeEmail_(fn) {
  try {
    return fn() || '(blank)';
  } catch (e) {
    return '(threw: ' + e.message + ')';
  }
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
  requireInteractive_();
  var status = sheetOrThrow_(TABS.STATUS);
  var ids = readColumn_(status, colIndex_(STATUS_COLUMNS, 'session_id'))
    .filter(function (id) { return id; });
  if (!ids.length) throw new Error('No connection in _status yet.');

  var sessions = [];
  ids.forEach(function (id) {
    try {
      var session = ebGetSession_(id);
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
  requireInteractive_();
  var sheet = sheetOrThrow_(TABS.ACCOUNTS);
  // The provider's current uid, not our frozen one — this calls the API.
  var uids = readRecords_(sheet, ACCOUNT_COLUMNS)
    .map(function (row) { return row.provider_account_id || row.account_id; })
    .filter(function (uid) { return uid; });
  if (!uids.length) throw new Error('No accounts yet.');

  uids.forEach(function (uid) {
    try {
      var details = ebGetAccountDetails_(uid);
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
  requireInteractive_();
  var accounts = listSyncableAccounts_();
  if (!accounts.length) throw new Error('No bank accounts to inspect.');

  accounts.forEach(function (account) {
    try {
      var page = ebGetTransactionsPage_(account.uid, {
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
