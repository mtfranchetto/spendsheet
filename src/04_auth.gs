/**
 * 04_auth.gs — connecting a bank, without a server.
 *
 * PSD2 authorisation is a browser round-trip: you are sent to your bank,
 * you authenticate there, and the bank redirects back to an address the
 * application nominated. That address normally implies hosting something.
 *
 * Here it is the Apps Script web app deployment — `doGet` receives the
 * callback, exchanges the code for a session and writes it to `_status`.
 * No localhost, no tunnel, no VPS, nothing to keep patched.
 *
 * The cost of that is a publicly reachable endpoint. It has to be: the
 * bank's redirect arrives with no Google session attached, so it cannot
 * require a login. What protects it is a single-use random `state` nonce
 * that startAuth() mints and doGet() verifies — without which anyone who
 * knew the URL could attach a bank session of their choosing to your sheet.
 */

var AUTH_STATE_PROPERTY = 'EB_AUTH_STATE';

/** How long you have to finish SCA before the nonce is refused. */
var AUTH_STATE_TTL_MS = 30 * 60 * 1000;

/** PSD2 permits up to 180 days; banks grant less and we find out per bank. */
var CONSENT_DAYS = 180;

// ---------------------------------------------------------------------------
// Starting authorisation
// ---------------------------------------------------------------------------

/** Menu → Connect a bank. */
function startAuth() {
  var html = HtmlService.createHtmlOutput(bankPickerHtml_())
    .setWidth(560)
    .setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connect a bank');
}

/** Called from the picker dialog. */
function listBanks(country) {
  return ebListAspsps(country).map(function (aspsp) {
    return {
      name: aspsp.name,
      country: aspsp.country,
      logo: aspsp.logo || '',
      psuTypes: aspsp.psu_types || []
    };
  });
}

/**
 * Mint a nonce, ask Enable Banking to begin authorisation, and hand back the
 * bank's URL for the user to open.
 *
 * The nonce is stored *before* the request goes out, so a callback can never
 * arrive for a flow we have no record of.
 */
function beginAuthorization(aspspName, country, psuType) {
  if (!aspspName) throw new Error('Pick a bank first.');

  var redirectUrl = webAppUrl();
  if (!redirectUrl) {
    throw new Error(
      'This script has no web app deployment yet. Deploy → New deployment → Web app, ' +
      'with access set to "Anyone", then try again.');
  }

  var state = generateState_();
  var payload = buildAuthPayload({
    aspspName: aspspName,
    country: country,
    redirectUrl: redirectUrl,
    state: state,
    validUntil: consentValidUntil(Date.now(), CONSENT_DAYS),
    psuType: psuType || 'personal'
  });

  PropertiesService.getScriptProperties().setProperty(AUTH_STATE_PROPERTY, JSON.stringify({
    state: state,
    aspspName: aspspName,
    country: country,
    createdAt: Date.now()
  }));

  var response;
  try {
    response = ebStartAuthorization(payload);
  } catch (err) {
    // The redirect URL is the usual culprit on a 400: it must match one
    // registered for the application exactly, and the value here comes from
    // the *active deployment* — which is a /dev URL when the script is run
    // in test mode, and a /exec URL only once deployed. Showing it turns a
    // guessing game into a comparison.
    var isPinned = Boolean(
      PropertiesService.getScriptProperties().getProperty(EB_PROP.REDIRECT_URL));

    err.message += '\n\nredirect_url sent: ' + redirectUrl +
      '\n\nThis must match a redirect URL registered for the ' + ebEnvironment() +
      ' application, and must be the URL of your ACTIVE deployment ' +
      '(Deploy → Manage deployments → Web app → URL).' +
      (isPinned
        ? '\n\nThis URL is pinned. If it is wrong, re-pin it via Install credentials.'
        : '\n\nNothing is pinned, so this value was guessed by the runtime — which returns ' +
          'an archived deployment often enough to be worth not trusting. Pin the right one ' +
          'via Spendsheet → Install credentials.');
    throw err;
  }

  if (!response.url) throw new Error('Enable Banking did not return an authorisation URL.');

  return { url: response.url, aspsp: aspspName };
}

/**
 * The /auth request body.
 *
 * `redirect_url` must be one of the URLs registered for the application, or
 * the API refuses it — which is the single most common setup mistake, since
 * the deployment URL changes when you create a *new* deployment rather than
 * updating the existing one.
 */
function buildAuthPayload(options) {
  return {
    access: { valid_until: options.validUntil },
    aspsp: { name: options.aspspName, country: options.country },
    state: options.state,
    redirect_url: options.redirectUrl,
    psu_type: options.psuType
  };
}

/** ISO 8601 UTC, which is what the API expects for consent validity. */
function consentValidUntil(nowMs, days) {
  return new Date(nowMs + days * 24 * 60 * 60 * 1000).toISOString();
}

/** 244 bits from two UUIDs. Guessing it is not a realistic attack. */
function generateState_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/**
 * The redirect URL to hand the bank.
 *
 * An explicitly saved value wins over `ScriptApp.getService().getUrl()`,
 * because that is not reliable once deployments have churned: it can return
 * the URL of a deployment that has since been replaced, which resolves to
 * nothing and lands the callback on a Google Drive error page. The one URL
 * that matters is whichever is registered with Enable Banking, and only you
 * can know which that is.
 */
function webAppUrl() {
  var saved = PropertiesService.getScriptProperties().getProperty(EB_PROP.REDIRECT_URL);
  if (saved) return saved;
  return detectedWebAppUrl();
}

/** What the runtime thinks the URL is. A starting guess, not an authority. */
function detectedWebAppUrl() {
  try {
    return ScriptApp.getService().getUrl() || '';
  } catch (e) {
    return '';
  }
}

/**
 * Pin the redirect URL. Called from the credentials dialog.
 *
 * Validated rather than trusted: a `/dev` URL or a stray trailing slash both
 * fail late, at `/auth`, with an error that points at the bank rather than
 * at the typo.
 */
function saveRedirectUrl(url) {
  var error = validateRedirectUrl(url);
  if (error) throw new Error(error);

  PropertiesService.getScriptProperties().setProperty(EB_PROP.REDIRECT_URL, String(url).trim());
  return 'Saved. Register this exact URL for the ' + ebEnvironment() + ' application.';
}

function validateRedirectUrl(url) {
  if (!url || !String(url).trim()) return 'Paste the /exec URL of your web app deployment.';

  var text = String(url).trim();
  if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(text)) {
    if (/\/dev$/.test(text)) {
      return 'That is the test deployment (/dev). Use the /exec URL from Manage deployments.';
    }
    if (/\/exec\/$/.test(text)) {
      return 'Remove the trailing slash — the URL must end in /exec.';
    }
    return 'That does not look like an Apps Script web app URL. It should look like ' +
      'https://script.google.com/macros/s/…/exec';
  }
  return null;
}

/** Clear the pin and fall back to detection. */
function clearRedirectUrl() {
  PropertiesService.getScriptProperties().deleteProperty(EB_PROP.REDIRECT_URL);
  return 'Cleared. Falling back to ' + (detectedWebAppUrl() || 'no detected URL') + '.';
}

// ---------------------------------------------------------------------------
// The callback
// ---------------------------------------------------------------------------

/**
 * Where the bank sends the browser after SCA.
 *
 * Everything here is deliberately terse in what it reveals. A response that
 * explained *why* a callback was rejected would be a probing oracle for
 * anyone who found the URL, and there is nothing a legitimate user learns
 * from the detail that they don't learn from "this didn't work".
 */
function doGet(e) {
  var params = (e && e.parameter) || {};

  try {
    if (params.error) {
      return authPage_('Not connected',
        'Your bank reported: ' + String(params.error).slice(0, 200));
    }

    var stored = readAuthState_();
    var check = validateAuthState(stored, params.state, Date.now(), AUTH_STATE_TTL_MS);
    if (!check.ok) {
      // Consumed regardless, so a rejected attempt cannot be retried against
      // a still-live nonce.
      clearAuthState_();
      return authPage_('Not connected',
        'This authorisation link is no longer valid. Start again from Spendsheet → Connect a bank.');
    }

    if (!params.code) {
      clearAuthState_();
      return authPage_('Not connected', 'Your bank did not return an authorisation code.');
    }

    clearAuthState_();
    var session = ebCreateSession(params.code);
    var summary = recordConnection(session, stored.aspspName);

    return authPage_('Connected',
      summary.accountCount + ' account' + (summary.accountCount === 1 ? '' : 's') +
      ' linked at ' + summary.provider + '. You can close this tab and go back to your spreadsheet.');
  } catch (err) {
    clearAuthState_();
    return authPage_('Not connected', 'Something went wrong completing the connection.');
  }
}

function readAuthState_() {
  var raw = PropertiesService.getScriptProperties().getProperty(AUTH_STATE_PROPERTY);
  return raw ? safeJsonParse(raw) : null;
}

function clearAuthState_() {
  PropertiesService.getScriptProperties().deleteProperty(AUTH_STATE_PROPERTY);
}

/**
 * Is this callback one we started?
 *
 * Pure, and separated from doGet precisely because it is the security
 * boundary — the part worth being able to test exhaustively without a
 * spreadsheet or a network in the way.
 */
function validateAuthState(stored, received, nowMs, ttlMs) {
  if (!stored || !stored.state) return { ok: false, reason: 'no authorization in progress' };
  if (!received) return { ok: false, reason: 'no state returned' };
  if (String(received) !== String(stored.state)) return { ok: false, reason: 'state mismatch' };
  if (!(stored.createdAt > 0)) return { ok: false, reason: 'malformed state record' };
  if (nowMs - stored.createdAt > ttlMs) return { ok: false, reason: 'authorization expired' };
  return { ok: true, reason: null };
}

function authPage_(title, message) {
  var ok = title === 'Connected';
  return HtmlService.createHtmlOutput(
    '<div style="font:15px/1.6 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;' +
    'max-width:420px;margin:80px auto;padding:0 24px;text-align:center;color:#202124">' +
    '<div style="font-size:44px">' + (ok ? '&#9989;' : '&#9888;&#65039;') + '</div>' +
    '<h1 style="font-size:20px;margin:16px 0 8px">' + title + '</h1>' +
    '<p style="color:#5f6368">' + message + '</p>' +
    '</div>'
  ).setTitle(title + ' — spendsheet');
}

// ---------------------------------------------------------------------------
// Recording what we connected
// ---------------------------------------------------------------------------

/** Write the session to _status and its accounts to the accounts tab. */
function recordConnection(session, fallbackProvider) {
  var accounts = extractAccounts(session);
  var provider = (session.aspsp && session.aspsp.name) || fallbackProvider || 'unknown';

  // A session with no readable accounts means our idea of the response shape
  // is wrong. Keeping the raw response is the difference between a fixable
  // bug and a mystery — this is what _anomalies is for.
  if (!accounts.length) {
    logAnomaly_(ANOMALY_KIND.NO_ACCOUNTS, '',
      'Session created, but no accounts could be read from the response. ' +
      'Keys present: ' + Object.keys(session || {}).join(', '),
      session);
  }

  upsertStatusRow_(mapSessionToStatusRow(session, provider, new Date()));
  var result = upsertAccounts_(accounts, provider);

  return {
    provider: provider,
    accountCount: accounts.length,
    accountsAdded: result.added,
    written: result.written
  };
}

/**
 * Record something we could not interpret, rather than dropping it.
 *
 * Never throws: a failure to log an anomaly must not become the thing that
 * breaks the run it was reporting on.
 */
function logAnomaly_(kind, accountId, detail, raw) {
  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ANOMALIES);
    if (!sheet) return;

    var json = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (json && json.length > MAX_CELL_CHARS) json = json.slice(0, MAX_CELL_CHARS) + '…[truncated]';

    sheet.appendRow([new Date(), accountId || '', kind, detail || '', json || '']);
  } catch (e) {
    Logger.log('logAnomaly_ failed: ' + e.message);
  }
}

/**
 * Re-read every live session and rewrite what it says about accounts.
 *
 * Useful beyond first connection: a bank can expose an account later, or
 * change what it reports about one, and neither should require redoing SCA.
 * Names you have given accounts are preserved, as on any reconnect.
 */
function refreshAccounts() {
  var status = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STATUS);
  if (!status || status.getLastRow() < 2) throw new Error('No connections in _status yet.');

  var idColumn = colIndex_(STATUS_COLUMNS, 'session_id');
  var ids = status.getRange(2, idColumn, status.getLastRow() - 1, 1).getValues()
    .map(function (row) { return row[0]; })
    .filter(function (id) { return id; });

  var total = 0;
  var failures = [];
  var trace = [];

  ids.forEach(function (sessionId) {
    try {
      var summary = recordConnection(ebGetSession(sessionId));
      total += summary.accountCount;
      trace.push({ sessionId: sessionId, summary: summary });
    } catch (e) {
      failures.push(String(sessionId).slice(0, 8) + '…: ' + e.message);
      trace.push({ sessionId: sessionId, error: e.message, stack: e.stack });
    }
  });

  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '', 'refreshAccounts trace', trace);

  var message = total + ' account' + (total === 1 ? '' : 's') + ' across ' + ids.length + ' connection' +
    (ids.length === 1 ? '' : 's') + (failures.length ? '. Failed: ' + failures.join(' | ') : '');
  SpreadsheetApp.getActiveSpreadsheet().toast(message, 'Accounts refreshed', 10);
  return { accounts: total, connections: ids.length, failures: failures };
}

/**
 * Report what the accounts tab actually looks like to the script, including
 * whether a write to it survives.
 *
 * For when the code reports success and the sheet disagrees — at that point
 * every remaining explanation is about the sheet rather than the logic, and
 * guessing between them has a poor record.
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

/**
 * Dump the current session's raw JSON into _anomalies.
 *
 * A diagnostic for working out what a provider actually returns, since the
 * response shape varies by bank and is the thing the phase 3b probe exists
 * to settle. Run it from the editor when accounts don't appear.
 */
function inspectSession() {
  var status = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STATUS);
  if (!status || status.getLastRow() < 2) throw new Error('No connection in _status yet.');

  var sessionId = status.getRange(2, colIndex_(STATUS_COLUMNS, 'session_id')).getValue();
  if (!sessionId) throw new Error('No session_id in the first _status row.');

  var session = ebGetSession(sessionId);
  logAnomaly_(ANOMALY_KIND.RAW_DUMP, '',
    'GET /sessions/' + sessionId + ' — top-level keys: ' + Object.keys(session || {}).join(', '),
    session);

  SpreadsheetApp.getActiveSpreadsheet()
    .toast('Written to _anomalies. Unhide that tab to read it.', 'Session inspected', 10);
  return session;
}

/**
 * Shape a session into a _status row.
 *
 * Only the columns code owns — `state` and `days_left` are formulas, so
 * they are left alone here and stay truthful between syncs.
 */
function mapSessionToStatusRow(session, provider, now) {
  var validUntil = (session.access && session.access.valid_until) || session.valid_until || '';
  return {
    connection_id: session.session_id || session.id || '',
    provider: provider,
    session_id: session.session_id || session.id || '',
    valid_until: validUntil ? new Date(validUntil) : '',
    last_success: now,
    last_error: '',
    accounts_covered: extractAccounts(session).length
  };
}

/**
 * Pull account objects out of a session response.
 *
 * Deliberately tolerant about shape. The session may carry full account
 * resources or bare UID strings depending on the endpoint and the bank, and
 * this is one of the things phase 3b's probe against real providers is meant
 * to settle. Anything unrecognisable is preserved rather than dropped, so a
 * wrong guess here shows up as a row to look at instead of a silent absence.
 */
function extractAccounts(session) {
  if (!session) return [];

  // Confirmed against a live session: `accounts` is a list of UID *strings*
  // and the descriptive fields live alongside it in `accounts_data`. Reading
  // only the first gives accounts with no name, currency or IBAN; reading
  // only the second misses any UID the bank listed without details.
  var details = {};
  (session.accounts_data || []).forEach(function (entry) {
    if (entry && entry.uid) details[entry.uid] = entry;
  });

  var uids = [];
  function addUid(uid) {
    if (uid && uids.indexOf(uid) === -1) uids.push(uid);
  }

  (session.accounts || []).forEach(function (entry) {
    if (typeof entry === 'string') addUid(entry);
    else if (entry) addUid(entry.uid || entry.resource_id || entry.identification_hash);
  });
  Object.keys(details).forEach(addUid);

  return uids.map(function (uid) {
    var detail = details[uid] || {};
    var identifiers = detail.account_id || {};
    return {
      uid: uid,
      name: detail.name || detail.product || detail.details || '',
      currency: detail.currency || '',
      iban: identifiers.iban || (identifiers.other && identifiers.other.identification) || ''
    };
  });
}

/** Show enough of an IBAN to recognise the account, not enough to use it. */
function maskIban(iban) {
  if (!iban) return '';
  var text = String(iban).replace(/\s/g, '');
  if (text.length <= 8) return text;
  return text.slice(0, 4) + '…' + text.slice(-4);
}

function upsertStatusRow_(row) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.STATUS);
  var idColumn = colIndex_(STATUS_COLUMNS, 'connection_id');
  var existing = findRowByValue_(sheet, idColumn, row.connection_id);
  var target = existing || nextEmptyRow_(sheet, idColumn);

  writeCell_(sheet, target, STATUS_COLUMNS, 'connection_id', row.connection_id);
  writeCell_(sheet, target, STATUS_COLUMNS, 'provider', row.provider);
  writeCell_(sheet, target, STATUS_COLUMNS, 'session_id', row.session_id);
  writeCell_(sheet, target, STATUS_COLUMNS, 'valid_until', row.valid_until);
  writeCell_(sheet, target, STATUS_COLUMNS, 'last_success', row.last_success);
  writeCell_(sheet, target, STATUS_COLUMNS, 'last_error', row.last_error);
  writeCell_(sheet, target, STATUS_COLUMNS, 'accounts_covered', row.accounts_covered);
}

/**
 * Add newly discovered accounts.
 *
 * An account already listed keeps the name you gave it — reconnecting a bank
 * must not undo a rename. Only the bank-owned facts are refreshed.
 */
function upsertAccounts_(accounts, provider) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TABS.ACCOUNTS);
  var idColumn = colIndex_(ACCOUNT_COLUMNS, 'account_id');
  var added = 0;
  // Each write records where it went and what came back, so "reported
  // success but the sheet is empty" is answerable rather than arguable.
  var written = [];

  accounts.forEach(function (account) {
    var existing = findRowByValue_(sheet, idColumn, account.uid);
    var row = existing || nextEmptyRow_(sheet, idColumn);

    if (!existing) {
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'account_id', account.uid);
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'name', account.name || provider + ' account');
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'kind', ACCOUNT_KIND.BANK);
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'include_in_net_worth', true);
      writeCell_(sheet, row, ACCOUNT_COLUMNS, 'active', true);
      added++;
    }

    writeCell_(sheet, row, ACCOUNT_COLUMNS, 'provider', provider);
    writeCell_(sheet, row, ACCOUNT_COLUMNS, 'iban_masked', maskIban(account.iban));
    if (account.currency) writeCell_(sheet, row, ACCOUNT_COLUMNS, 'currency', account.currency);

    written.push({
      uid: account.uid,
      row: row,
      existed: Boolean(existing),
      readBack: sheet.getRange(row, idColumn).getValue()
    });
  });

  return { added: added, written: written };
}

function colIndex_(headers, name) {
  var index = headers.indexOf(name);
  if (index === -1) throw new Error('colIndex_: no column named "' + name + '"');
  return index + 1;
}

function writeCell_(sheet, row, headers, name, value) {
  sheet.getRange(row, colIndex_(headers, name)).setValue(value);
}

/**
 * The first row whose key column is empty.
 *
 * Not `getLastRow() + 1`: several tabs carry an ARRAYFORMULA in row 2, so
 * the sheet reports content there even with no records, and appending after
 * it leaves a permanent blank first row. The key column is the honest
 * measure of how many records exist.
 */
function nextEmptyRow_(sheet, column) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 2;

  var values = sheet.getRange(2, column, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (values[i][0] === '' || values[i][0] === null) return i + 2;
  }
  return lastRow + 1;
}

function findRowByValue_(sheet, column, value) {
  if (!value) return null;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var values = sheet.getRange(2, column, lastRow - 1, 1).getValues();
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]) === String(value)) return i + 2;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The picker dialog
// ---------------------------------------------------------------------------

function bankPickerHtml_() {
  var env = ebEnvironment();
  return [
    '<style>',
    ' body{font:13px/1.5 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;margin:0;padding:16px;color:#202124}',
    ' input{width:100%;box-sizing:border-box;padding:8px;border:1px solid #dadce0;border-radius:4px;font-size:13px}',
    ' ul{list-style:none;margin:12px 0 0;padding:0;max-height:330px;overflow:auto;border:1px solid #e8eaed;border-radius:4px}',
    ' li{padding:9px 12px;border-bottom:1px solid #f1f3f4;cursor:pointer;display:flex;justify-content:space-between}',
    ' li:hover{background:#f8f9fa}',
    ' li .c{color:#80868b;font-size:11px}',
    ' .env{background:#e8f0fe;padding:6px 10px;border-radius:4px;font-size:12px;margin-bottom:12px}',
    ' .count{color:#5f6368;font-size:11px;margin-top:8px}',
    ' .msg{margin-top:14px;font-size:12px;white-space:pre-wrap}.err{color:#c5221f}',
    ' a.go{display:inline-block;margin-top:14px;padding:10px 18px;background:#1a73e8;color:#fff;',
    '   text-decoration:none;border-radius:4px;font-size:13px}',
    '</style>',
    '<div class="env"><b>' + env + '</b> — ' +
      (env === 'SANDBOX' ? 'test banks only. Look for “Mock ASPSP”.' : 'your real banks.') + '</div>',
    '<input id="q" placeholder="Search banks…" oninput="render()" autocomplete="off">',
    '<div class="count" id="count">Loading…</div>',
    '<ul id="list"></ul>',
    '<div class="msg" id="msg"></div>',
    '<script>',
    ' var banks=[], LIMIT=500;',
    ' google.script.run.withSuccessHandler(function(b){banks=b;render();})',
    '   .withFailureHandler(fail).listBanks();',
    ' function fail(e){document.getElementById("msg").className="msg err";',
    '   document.getElementById("msg").textContent=e.message;',
    '   document.getElementById("count").textContent="";',
    '   document.getElementById("list").innerHTML="";}',
    ' function render(){',
    '   var q=document.getElementById("q").value.toLowerCase();',
    '   var shown=banks.filter(function(b){return b.name.toLowerCase().indexOf(q)>-1});',
    '   document.getElementById("count").textContent =',
    '     shown.length===banks.length',
    '       ? banks.length+" banks available"',
    '       : shown.length+" of "+banks.length+" match";',
    '   document.getElementById("list").innerHTML = shown.length',
    '     ? shown.slice(0,LIMIT).map(function(b){return "<li onclick=\\"pick("+banks.indexOf(b)+")\\">"+',
    '         "<span>"+b.name+"</span><span class=\\"c\\">"+(b.country||"")+"</span></li>"}).join("")+',
    '         (shown.length>LIMIT ? "<li class=\\"c\\">…and "+(shown.length-LIMIT)+" more — narrow your search</li>" : "")',
    '     : "<li>Not in this list. "+(banks.length?"":"None loaded.")+"</li>";',
    ' }',
    ' function pick(i){',
    '   var b=banks[i], m=document.getElementById("msg");',
    '   m.className="msg"; m.textContent="Contacting "+b.name+"…";',
    '   google.script.run.withSuccessHandler(function(r){',
    '     m.innerHTML="Now sign in to <b>"+r.aspsp+"</b> to approve access."+',
    '       "<br><a class=\\"go\\" href=\\""+r.url+"\\" target=\\"_blank\\">Open '  + "'" + 'my bank'  + "'" + '</a>";',
    '   }).withFailureHandler(fail).beginAuthorization(b.name,b.country,(b.psuTypes||[])[0]||"personal");',
    ' }',
    '</script>'
  ].join('\n');
}
