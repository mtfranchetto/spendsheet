/**
 * 02_api.gs — Enable Banking client.
 *
 * Two things about this API are worth stating up front, because both are
 * easy to get wrong in ways that fail silently rather than loudly:
 *
 * 1. **The environment is fixed at application registration**, not at call
 *    time. Sandbox and production share `api.enablebanking.com`; the `kid`
 *    in the JWT is the application ID, so the key you sign with decides
 *    which world you reach. We therefore hold both key pairs and select on
 *    `EB_ENV`.
 *
 * 2. **This is the cloud aggregation API, which is snake_case.** Enable
 *    Banking publishes a second, separate product — the self-hosted TPP API
 *    — whose docs use camelCase (`entryReference`, `transactionAmount`).
 *    Reading the wrong doc set produces code that reads `undefined` from
 *    every field and reports zero transactions without erroring.
 *
 * Secrets live in Script Properties. Never in the Sheet, never in git.
 *
 * This file speaks HTTP and nothing else: it knows no tab names and reads no
 * cells. What a response *means* belongs to 06_accounts.gs and 07_transactions.gs,
 * and the live checks that exercise it are in 13_diagnostics.gs.
 */

var EB_BASE_URL = 'https://api.enablebanking.com';

var EB_ENV = { SANDBOX: 'SANDBOX', PRODUCTION: 'PRODUCTION' };

var EB_PROP = {
  ENV: 'EB_ENV',
  REDIRECT_URL: 'EB_REDIRECT_URL',
  SANDBOX_APP_ID: 'EB_SANDBOX_APP_ID',
  SANDBOX_KEY: 'EB_SANDBOX_KEY',
  PROD_APP_ID: 'EB_PROD_APP_ID',
  PROD_KEY: 'EB_PROD_KEY'
};

/** Error codes this client raises. Everything downstream switches on these. */
var EB_ERROR = {
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  AUTH_FAILED: 'AUTH_FAILED',
  EXPIRED_SESSION: 'EXPIRED_SESSION',
  ASPSP_RATE_LIMIT_EXCEEDED: 'ASPSP_RATE_LIMIT_EXCEEDED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_REQUEST: 'INVALID_REQUEST',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  UNKNOWN: 'UNKNOWN'
};

/**
 * Codes worth trying again later. Deliberately excludes the rate limit:
 * a 429 carries a multi-hour penalty, so retrying inside the same run burns
 * the window and achieves nothing. It waits for tomorrow's trigger instead.
 */
var EB_RETRYABLE = [EB_ERROR.PROVIDER_ERROR, EB_ERROR.NETWORK_ERROR];

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Which environment is active. Defaults to sandbox — the safe direction. */
function ebEnvironment() {
  return PropertiesService.getScriptProperties().getProperty(EB_PROP.ENV) || EB_ENV.SANDBOX;
}

function ebCredentials_() {
  var props = PropertiesService.getScriptProperties();
  var env = ebEnvironment();
  var production = env === EB_ENV.PRODUCTION;

  var applicationId = props.getProperty(production ? EB_PROP.PROD_APP_ID : EB_PROP.SANDBOX_APP_ID);
  var privateKey = props.getProperty(production ? EB_PROP.PROD_KEY : EB_PROP.SANDBOX_KEY);

  if (!applicationId || !privateKey) {
    throw ebError(EB_ERROR.MISSING_CREDENTIALS,
      'No ' + env + ' credentials installed. Run installCredentials() from the Apps Script editor.');
  }
  return { env: env, applicationId: applicationId, privateKey: privateKey };
}

/**
 * Validate a pasted PEM before it reaches Script Properties.
 *
 * Worth doing eagerly: a malformed key surfaces later as a signature the
 * server rejects, which is indistinguishable from a wrong application ID or
 * a clock problem. Catching the shape here removes a whole diagnostic
 * detour. Returns an error message, or null when it looks fine.
 */
function validatePrivateKey(pem) {
  if (!pem || typeof pem !== 'string' || !pem.trim()) {
    return 'Paste the contents of the .pem file Enable Banking gave you.';
  }
  var text = pem.trim();
  if (text.indexOf('-----BEGIN') !== 0) {
    return 'That does not look like a PEM file — it should start with "-----BEGIN".';
  }
  if (text.indexOf('PUBLIC KEY') !== -1) {
    return 'That is the public key. You need the private one — the file you downloaded, not the one you uploaded.';
  }
  if (text.indexOf('PRIVATE KEY') === -1) {
    return 'No "PRIVATE KEY" marker found. Open the .pem in a text editor and copy the whole file.';
  }
  if (text.indexOf('-----END') === -1) {
    return 'The key looks truncated — the closing "-----END" line is missing.';
  }
  return null;
}

function validateApplicationId(id) {
  if (!id || typeof id !== 'string' || !id.trim()) {
    return 'Paste the application ID from the Enable Banking control panel.';
  }
  if (/\s/.test(id.trim())) {
    return 'The application ID should not contain spaces.';
  }
  return null;
}

/**
 * Store credentials. Called from the dialog, and directly usable from the
 * editor if you'd rather not click.
 */
function saveCredentials(env, applicationId, privateKey) {
  var idError = validateApplicationId(applicationId);
  if (idError) throw new Error(idError);

  var keyError = validatePrivateKey(privateKey);
  if (keyError) throw new Error(keyError);

  if (env !== EB_ENV.SANDBOX && env !== EB_ENV.PRODUCTION) {
    throw new Error('Environment must be SANDBOX or PRODUCTION.');
  }

  var production = env === EB_ENV.PRODUCTION;
  var values = {};
  values[EB_PROP.ENV] = env;
  values[production ? EB_PROP.PROD_APP_ID : EB_PROP.SANDBOX_APP_ID] = applicationId.trim();
  values[production ? EB_PROP.PROD_KEY : EB_PROP.SANDBOX_KEY] = privateKey.trim();

  PropertiesService.getScriptProperties().setProperties(values);
  EB_JWT_CACHE_ = null;

  return 'Saved. Active environment is now ' + env + '.';
}

/**
 * A dialog rather than ui.prompt(), for one specific reason: a PEM is
 * multi-line and prompt() is a single-line input that mangles it. This is
 * a one-time operation and the repo's rule is that those get documented
 * rather than coded — but a documented procedure that silently corrupts the
 * key isn't a procedure, it's a trap.
 */
function installCredentials() {
  var html = HtmlService.createHtmlOutput(credentialsFormHtml_())
    .setWidth(560)
    .setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, 'Enable Banking credentials');
}

function credentialsFormHtml_() {
  var current = ebEnvironment();
  var pinned = PropertiesService.getScriptProperties().getProperty(EB_PROP.REDIRECT_URL) || '';
  var detected = detectedWebAppUrl();
  return [
    '<style>',
    ' body{font:13px/1.5 -apple-system,BlinkMacSystemFont,Roboto,sans-serif;margin:0;padding:16px;color:#202124}',
    ' label{display:block;font-weight:600;margin:14px 0 4px}',
    ' input,select,textarea{width:100%;box-sizing:border-box;padding:7px;border:1px solid #dadce0;border-radius:4px;font-size:13px}',
    ' textarea{height:210px;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:pre}',
    ' .hint{color:#5f6368;font-size:12px;margin-top:4px}',
    ' .warn{background:#fef7e0;border-left:3px solid #f9ab00;padding:8px 10px;margin-top:14px;font-size:12px}',
    ' button{margin-top:16px;padding:9px 18px;border:0;border-radius:4px;background:#1a73e8;color:#fff;font-size:13px;cursor:pointer}',
    ' button:disabled{background:#dadce0}',
    ' #msg{margin-top:12px;font-size:12px}',
    ' .row{display:flex;align-items:center;gap:10px;margin-top:8px}',
    ' button.small{margin-top:0;padding:6px 12px;font-size:12px}',
    ' #redirectMsg{font-size:12px;color:#5f6368}',
    ' .err{color:#c5221f}.ok{color:#188038}',
    '</style>',
    '<label for="env">Environment</label>',
    '<select id="env">',
    '  <option value="SANDBOX"' + (current === 'SANDBOX' ? ' selected' : '') + '>Sandbox — Mock ASPSP and test banks</option>',
    '  <option value="PRODUCTION"' + (current === 'PRODUCTION' ? ' selected' : '') + '>Production — your real banks</option>',
    '</select>',
    '<div class="hint">Each environment is a separate registration with its own ID and key. Saving one does not overwrite the other.</div>',
    '<label for="redirect">Redirect URL</label>',
    // Escaped even though validateRedirectUrl gates what can be stored: the
    // guard and the render are far enough apart that a later relaxation of
    // one would not obviously break the other.
    '<input id="redirect" value="' + escapeHtml_(pinned) + '" placeholder="https://script.google.com/macros/s/…/exec">',
    // Deliberately NOT pre-filled with the detected value: it can name a
    // deployment that has been archived, and a wrong value sitting next to a
    // "pin" button is an invitation to pin it.
    '<div class="row">',
    '  <button class="small" onclick="saveRedirect()">Pin this URL</button>',
    // Status belongs beside the control that produces it. At the foot of the
    // dialog it sits below the fold, and a click reads as doing nothing.
    '  <span id="redirectMsg">' + (pinned ? '&#10003; pinned' : 'nothing pinned yet') + '</span>',
    '</div>',
    '<div class="hint">Copy this from <b>Deploy &rarr; Manage deployments &rarr; Web app &rarr; URL</b>, ' +
    'and register the same string with Enable Banking.' +
    (detected
      ? ' The runtime guesses <code>' + escapeHtml_(detected) + '</code>, which is right only if it matches your ' +
        '<b>active</b> deployment — archived ones linger there.'
      : '') + '</div>',
    '<label for="appId">Application ID</label>',
    '<input id="appId" placeholder="from the Enable Banking control panel" autocomplete="off">',
    '<label for="key">Private key (.pem)</label>',
    '<textarea id="key" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----" spellcheck="false"></textarea>',
    '<div class="hint">Open the .pem file in a text editor and paste the whole thing, including the BEGIN and END lines.</div>',
    '<div class="warn">This is stored in Script Properties, which is private to this script. It is never written to the spreadsheet and never leaves your Google account.</div>',
    '<button id="save" onclick="submit()">Save</button>',
    '<div id="msg"></div>',
    '<script>',
    ' function saveRedirect(){',
    '   var m=document.getElementById("redirectMsg");',
    '   m.className=""; m.textContent="saving…";',
    '   google.script.run',
    '     .withSuccessHandler(function(r){ m.className="ok"; m.textContent="\\u2713 "+r; })',
    '     .withFailureHandler(function(e){ m.className="err"; m.textContent=e.message; })',
    '     .saveRedirectUrl(document.getElementById("redirect").value);',
    ' }',
    ' function submit(){',
    '   var b=document.getElementById("save"), m=document.getElementById("msg");',
    '   b.disabled=true; m.className=""; m.textContent="Saving...";',
    '   google.script.run',
    '     .withSuccessHandler(function(r){ m.className="ok"; m.textContent=r; b.disabled=false; })',
    '     .withFailureHandler(function(e){ m.className="err"; m.textContent=e.message; b.disabled=false; })',
    '     .saveCredentials(',
    '       document.getElementById("env").value,',
    '       document.getElementById("appId").value,',
    '       document.getElementById("key").value);',
    ' }',
    '</script>'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Request layer
// ---------------------------------------------------------------------------

var EB_JWT_CACHE_ = null;

/** One token per execution rather than per request — RSA signing isn't free. */
function ebJwt_() {
  var now = Math.floor(Date.now() / 1000);
  if (EB_JWT_CACHE_ && EB_JWT_CACHE_.expiresAt - 60 > now) return EB_JWT_CACHE_.token;

  var creds = ebCredentials_();
  var token = buildJwt(creds.applicationId, creds.privateKey, now, JWT_TTL_SECONDS);
  EB_JWT_CACHE_ = { token: token, expiresAt: now + JWT_TTL_SECONDS };
  return token;
}

/** Build a query string, dropping empty values so they don't reach the API as "". */
function buildQuery(params) {
  if (!params) return '';
  var parts = [];
  Object.keys(params).forEach(function (key) {
    var value = params[key];
    if (value === undefined || value === null || value === '') return;
    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
  });
  return parts.length ? '?' + parts.join('&') : '';
}

/** A typed error. `code` is what callers switch on; `body` is kept for _anomalies. */
function ebError(code, message, status, body) {
  var error = new Error(message);
  error.name = 'EnableBankingError';
  error.code = code;
  error.status = status || null;
  error.body = body || null;
  error.retryable = EB_RETRYABLE.indexOf(code) !== -1;
  return error;
}

/**
 * Map an HTTP failure onto one of our codes.
 *
 * The API's own error identifier wins when present, because it distinguishes
 * cases the status code cannot — an expired consent and a malformed request
 * both arrive as 4xx, but only one of them means "the user must re-authorise".
 *
 * The exact error-body shape is not pinned down in the docs we could verify,
 * so this reads several plausible fields and falls back to the status. The
 * raw body is preserved on the error either way, and phase 3's live calls
 * are what will confirm the real shape.
 */
function classifyEbError(status, bodyText) {
  var body = safeJsonParse(bodyText);
  var declared = body && (body.code || body.error || body.error_code || body.errorCode);

  if (typeof declared === 'string' && declared) {
    var normalized = declared.toUpperCase().replace(/[\s-]/g, '_');
    if (normalized.indexOf('SESSION') !== -1 && normalized.indexOf('EXPIR') !== -1) {
      return EB_ERROR.EXPIRED_SESSION;
    }
    if (normalized.indexOf('RATE_LIMIT') !== -1 || normalized.indexOf('TOO_MANY') !== -1) {
      return EB_ERROR.ASPSP_RATE_LIMIT_EXCEEDED;
    }
    if (EB_ERROR[normalized]) return normalized;
  }

  if (status === 401) return EB_ERROR.AUTH_FAILED;
  if (status === 403) return EB_ERROR.FORBIDDEN;
  if (status === 404) return EB_ERROR.NOT_FOUND;
  if (status === 422 || status === 400) return EB_ERROR.INVALID_REQUEST;
  if (status === 429) return EB_ERROR.ASPSP_RATE_LIMIT_EXCEEDED;
  if (status >= 500) return EB_ERROR.PROVIDER_ERROR;
  return EB_ERROR.UNKNOWN;
}

/** Never throw on malformed JSON — an unparseable body is a symptom, not a crash. */
function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** Plain-language guidance, used in _status.last_error and alert emails. */
function describeEbError(code) {
  switch (code) {
    case EB_ERROR.MISSING_CREDENTIALS:
      return 'No credentials installed. Run installCredentials().';
    case EB_ERROR.AUTH_FAILED:
      return 'The API rejected the token. Check the application ID matches the key, and that EB_ENV matches the app you registered.';
    case EB_ERROR.EXPIRED_SESSION:
      return 'The bank consent has expired. Reconnect the bank to authorise again.';
    case EB_ERROR.ASPSP_RATE_LIMIT_EXCEEDED:
      return 'The bank refused further requests today. This resets on its own; the next scheduled sync will pick it up.';
    case EB_ERROR.FORBIDDEN:
      return 'Access denied. On a restricted production app this usually means the account was not among the ones you linked.';
    case EB_ERROR.NOT_FOUND:
      return 'The session or account no longer exists. Reconnect the bank.';
    case EB_ERROR.INVALID_REQUEST:
      return 'The API rejected the request parameters.';
    case EB_ERROR.PROVIDER_ERROR:
      return 'Enable Banking or the bank returned a server error. Usually transient.';
    case EB_ERROR.NETWORK_ERROR:
      return 'The request could not be completed.';
    case EB_ERROR.UNKNOWN:
      return 'The API returned an error this client does not recognise. The raw response is recorded in _anomalies.';
    default:
      return 'Unrecognised error.';
  }
}

/**
 * Build the UrlFetchApp parameters. Separated out so tests can assert on the
 * request without a network stub — method, headers and body shape are most
 * of what can be wrong here.
 */
function buildRequestParams(method, token, payload) {
  var params = {
    method: String(method).toLowerCase(),
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json'
    },
    muteHttpExceptions: true
  };
  if (payload !== undefined && payload !== null) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(payload);
  }
  return params;
}

function ebFetch_(method, path, options) {
  options = options || {};
  var url = EB_BASE_URL + path + buildQuery(options.query);
  var params = buildRequestParams(method, ebJwt_(), options.payload);

  var response;
  try {
    response = UrlFetchApp.fetch(url, params);
  } catch (e) {
    throw ebError(EB_ERROR.NETWORK_ERROR, 'Request to ' + path + ' failed: ' + e.message);
  }

  var status = response.getResponseCode();
  var text = response.getContentText();

  if (status >= 200 && status < 300) return safeJsonParse(text) || {};

  var code = classifyEbError(status, text);
  var detail = extractErrorDetail(text);

  throw ebError(
    code,
    describeEbError(code) + ' (HTTP ' + status + ' on ' + path + ')' + (detail ? ' — ' + detail : ''),
    status, text);
}

/**
 * Pull the API's own explanation out of an error body.
 *
 * Worth surfacing rather than replacing with our generic text: on a 400 the
 * server knows exactly which parameter it disliked, and our guess at what
 * "invalid request" means is strictly less useful than what it actually
 * said. Truncated because some errors carry a whole validation tree.
 */
function extractErrorDetail(bodyText) {
  var body = safeJsonParse(bodyText);

  if (!body) {
    var plain = String(bodyText || '').trim();
    return plain && plain.length < 300 ? plain : '';
  }

  var detail = body.message || body.error_description || body.description;

  // Validation errors often arrive as a list of per-field objects. Checked
  // before the plain-string fields, since an array is truthy and would
  // otherwise stringify to "[object Object]".
  if (!detail && Array.isArray(body.detail)) {
    detail = body.detail.map(function (item) {
      return (item.loc ? item.loc.join('.') + ': ' : '') + (item.msg || JSON.stringify(item));
    }).join('; ');
  }
  if (!detail && typeof body.detail === 'string') detail = body.detail;
  if (!detail && typeof body.error === 'string') detail = body.error;
  if (!detail) detail = JSON.stringify(body);

  detail = String(detail);
  return detail.length > 300 ? detail.slice(0, 300) + '…' : detail;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

/** The registered application. Cheapest possible proof that the JWT is valid. */
function ebGetApplication() {
  return ebFetch_('get', '/application');
}

/** Banks reachable in this environment. In sandbox this includes Mock ASPSP. */
function ebListAspsps(country) {
  var result = ebFetch_('get', '/aspsps', { query: { country: country } });
  return result.aspsps || [];
}

/**
 * Begin authorisation. Returns `{ url }` — the bank's own login page, which
 * the user must open themselves; SCA cannot be automated, by design.
 */
function ebStartAuthorization(payload) {
  return ebFetch_('post', '/auth', { payload: payload });
}

/** Exchange the code the bank redirected back with for a session. */
function ebCreateSession(code) {
  return ebFetch_('post', '/sessions', { payload: { code: code } });
}

function ebGetSession(sessionId) {
  return ebFetch_('get', '/sessions/' + encodeURIComponent(sessionId));
}

function ebDeleteSession(sessionId) {
  return ebFetch_('delete', '/sessions/' + encodeURIComponent(sessionId));
}

/**
 * The descriptive fields for an account — name, product, currency, IBAN.
 *
 * Separate from the session because the session carries only identifiers.
 * Not every provider exposes this, so callers should treat a failure here
 * as "no name available" rather than as an error: an unnamed account is
 * still a perfectly usable account.
 */
function ebGetAccountDetails(accountUid) {
  return ebFetch_('get', '/accounts/' + encodeURIComponent(accountUid) + '/details');
}

function ebGetAccountBalances(accountUid) {
  var result = ebFetch_('get', '/accounts/' + encodeURIComponent(accountUid) + '/balances');
  return result.balances || [];
}

/**
 * One page of transactions.
 *
 * `strategy` is worth understanding before the first sync: full history is
 * reachable only for roughly an hour after authorisation, dropping to a
 * rolling ~90 days afterwards. `strategy: 'longest'` on the first run is the
 * one chance to backfill, and missing it costs a re-consent.
 */
function ebGetTransactionsPage(accountUid, options) {
  options = options || {};
  return ebFetch_('get', '/accounts/' + encodeURIComponent(accountUid) + '/transactions', {
    query: {
      date_from: options.dateFrom,
      date_to: options.dateTo,
      transaction_status: options.status,
      strategy: options.strategy,
      continuation_key: options.continuationKey
    }
  });
}

/**
 * Every page, following `continuation_key`.
 *
 * Capped, because an unbounded loop here can burn the 6-minute execution
 * limit and the daily rate budget at the same time. When the cap is hit the
 * caller is told — `truncated` is returned rather than logged and forgotten,
 * because a silent cap reads as "we fetched everything" when we didn't.
 */
function ebGetAllTransactions(accountUid, options) {
  options = options || {};
  var maxPages = options.maxPages || 20;

  var transactions = [];
  var continuationKey = null;
  var pages = 0;

  do {
    var page = ebGetTransactionsPage(accountUid, {
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      status: options.status,
      strategy: options.strategy,
      continuationKey: continuationKey
    });

    transactions = transactions.concat(page.transactions || []);
    continuationKey = page.continuation_key || null;
    pages++;
  } while (continuationKey && pages < maxPages);

  return {
    transactions: transactions,
    pages: pages,
    truncated: Boolean(continuationKey),
    continuationKey: continuationKey
  };
}
