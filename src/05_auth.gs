/**
 * 05_auth.gs — connecting a bank, without a server.
 *
 * PSD2 authorisation is a browser round-trip: you are sent to your bank, you
 * authenticate there, and the bank redirects back to an address the
 * application nominated. That address normally implies hosting something.
 *
 * Here it is the Apps Script web app deployment — `doGet` receives the
 * callback, exchanges the code for a session and hands it to `recordConnection_`
 * in 06_accounts.gs. No localhost, no tunnel, no VPS, nothing to keep patched.
 *
 * The cost of that is a publicly reachable endpoint. It has to be: the bank's
 * redirect arrives with no Google session attached, so it cannot require a
 * login. What protects it is a single-use random `state` nonce that
 * beginAuthorization() mints and doGet() verifies — without which anyone who
 * knew the URL could attach a bank session of their choosing to your sheet.
 *
 * This file owns the round-trip and nothing else. What a session *means* —
 * accounts, balances, consent expiry — belongs to 06_accounts.gs.
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
  requireInteractive_();
  var html = HtmlService.createHtmlOutput(bankPickerHtml_())
    .setWidth(560)
    .setHeight(620);
  SpreadsheetApp.getUi().showModalDialog(html, 'Connect a bank');
}

/** Called from the picker dialog. */
function listBanks(country) {
  requireInteractive_();
  return ebListAspsps_(country).map(function (aspsp) {
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
  requireInteractive_();
  if (!aspspName) throw new Error('Pick a bank first.');

  var redirectUrl = webAppUrl_();
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
    response = ebStartAuthorization_(payload);
  } catch (err) {
    // The redirect URL is the usual culprit on a 400: it must match one
    // registered for the application exactly, and the value here comes from
    // the *active deployment* — which is a /dev URL when the script is run
    // in test mode, and a /exec URL only once deployed. Showing it turns a
    // guessing game into a comparison.
    var isPinned = Boolean(
      PropertiesService.getScriptProperties().getProperty(EB_PROP.REDIRECT_URL));

    err.message += '\n\nredirect_url sent: ' + redirectUrl +
      '\n\nThis must match a redirect URL registered for the ' + ebEnvironment_() +
      ' application, and must be the URL of your ACTIVE deployment ' +
      '(Deploy → Manage deployments → Web app → URL).' +
      (isPinned
        ? '\n\nThis URL is pinned. If it is wrong, re-pin it via Spendsheet → Set up and maintain → Install credentials.'
        : '\n\nNothing is pinned, so this value was guessed by the runtime — which returns ' +
          'an archived deployment often enough to be worth not trusting. Pin the right one ' +
          'via Spendsheet → Set up and maintain → Install credentials.');
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

// ---------------------------------------------------------------------------
// The redirect URL
// ---------------------------------------------------------------------------

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
function webAppUrl_() {
  var saved = PropertiesService.getScriptProperties().getProperty(EB_PROP.REDIRECT_URL);
  if (saved) return saved;
  return detectedWebAppUrl_();
}

/** What the runtime thinks the URL is. A starting guess, not an authority. */
function detectedWebAppUrl_() {
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
  requireInteractive_();
  var error = validateRedirectUrl(url);
  if (error) throw new Error(error);

  PropertiesService.getScriptProperties().setProperty(EB_PROP.REDIRECT_URL, String(url).trim());
  return 'Saved. Register this exact URL for the ' + ebEnvironment_() + ' application.';
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

/*
  There was a `clearRedirectUrl` here — unpin, and fall back to detection —
  with no caller and no button in the dialog that would have needed one. It is
  gone rather than wired up, because the dialog already has the control: the
  field is pre-filled and `saveRedirectUrl` overwrites the pin. "Clear it and
  let detection guess" and "type the right one" answer the same question, and
  only one of them ends with the right URL in the property.
*/

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
      return callbackText_('Not connected',
        'Your bank reported: ' + String(params.error).slice(0, 200));
    }

    var stored = readAuthState_();
    var check = validateAuthState(stored, params.state, Date.now(), AUTH_STATE_TTL_MS);
    if (!check.ok) {
      // Only when the nonce is genuinely spent — see validateAuthState. A
      // mismatch leaves it alone, because this endpoint is public and
      // anything else lets a stranger cancel your consent mid-flight.
      if (check.consume) clearAuthState_();
      return callbackText_('Not connected',
        'This authorisation link is no longer valid. Start again from Spendsheet → Connect a bank.');
    }

    if (!params.code) {
      clearAuthState_();
      return callbackText_('Not connected', 'Your bank did not return an authorisation code.');
    }

    clearAuthState_();
    var session = ebCreateSession_(params.code);
    var summary = recordConnection_(session, stored.aspspName);

    // The full-history window closes about an hour after authorisation, after
    // which the same call returns a rolling ~90 days and the backfill is gone
    // until you re-consent. That deadline is worth stating in the one answer
    // that is guaranteed to be read.
    return callbackText_('Connected',
      summary.accountCount + ' account' + (summary.accountCount === 1 ? '' : 's') +
      ' linked at ' + summary.provider + '.',
      'Run Spendsheet → Sync now within the hour to capture your full history — after ' +
      'that only the last ~90 days are reachable without connecting again.');
  } catch (err) {
    clearAuthState_();
    return callbackText_('Not connected', 'Something went wrong completing the connection.');
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
 * Is this callback one we started, and is the stored nonce spent either way?
 *
 * Pure, and separated from doGet precisely because it is the security
 * boundary — the part worth being able to test exhaustively without a
 * spreadsheet or a network in the way. `consume` is decided here rather than
 * in doGet for the same reason: it is a security decision, and it is only
 * testable while it lives in a function that takes no services.
 *
 * The rule is that a nonce is consumed when it has been *used* — matched, or
 * found expired or corrupt — and never merely because someone presented the
 * wrong one. Clearing on mismatch looks prudent and is the opposite: the
 * endpoint is public and unauthenticated by necessity, so it hands anyone who
 * knows the URL a way to cancel an authorisation you are in the middle of,
 * with the sheet reporting only that the link is no longer valid. What it
 * buys in exchange is a limit on guessing a 244-bit nonce, which was never
 * reachable by guessing.
 */
function validateAuthState(stored, received, nowMs, ttlMs) {
  if (!stored || !stored.state) return authStateReject_('no authorization in progress', false);
  if (!received) return authStateReject_('no state returned', false);
  if (String(received) !== String(stored.state)) return authStateReject_('state mismatch', false);
  if (!(stored.createdAt > 0)) return authStateReject_('malformed state record', true);
  if (nowMs - stored.createdAt > ttlMs) return authStateReject_('authorization expired', true);
  return { ok: true, reason: null, consume: true };
}

function authStateReject_(reason, consume) {
  return { ok: false, reason: reason, consume: consume };
}

/**
 * The callback's answer, in plain text.
 *
 * **Text, because this is the one URL a stranger can load.** A page served by
 * `HtmlService` carries the `google.script.run` bridge, and the bridge reaches
 * every public function in the project with the owner's authority — so a
 * public page is a public API over everything the gates in `04_gates.gs` do
 * not stop. `ContentService` serves no bridge at all, which makes `doGet`
 * itself the whole of what an anonymous visitor can reach.
 *
 * It also retires a rule that had to be remembered. The bank's `error`
 * parameter arrives on the query string, and as markup it had to be escaped at
 * every call site; as text there is nothing to escape, so there is no call
 * site that can forget. That is the reason the note is a third parameter
 * rather than a sentence appended to `message`: it is a separate paragraph,
 * and nothing here takes formatting.
 */
function callbackText_(title, message, note) {
  var lines = [title, '', message];
  if (note) lines.push('', note);
  return ContentService.createTextOutput(lines.join('\n'))
    .setMimeType(ContentService.MimeType.TEXT);
}

// ---------------------------------------------------------------------------
// The picker dialog
// ---------------------------------------------------------------------------

function bankPickerHtml_() {
  var env = ebEnvironment_();
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
    // Bank names and the authorisation URL come from the API, and both are
    // written into innerHTML below. Neither is attacker-controlled today, and
    // that is not a property this dialog can check — so it escapes them
    // rather than trusting a third party to keep sending well-behaved names.
    ' function esc(s){return String(s==null?"":s).replace(/[&<>"\']/g,function(c){',
    '   return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","\'":"&#39;"}[c];});}',
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
    '         "<span>"+esc(b.name)+"</span><span class=\\"c\\">"+esc(b.country||"")+"</span></li>"}).join("")+',
    '         (shown.length>LIMIT ? "<li class=\\"c\\">…and "+(shown.length-LIMIT)+" more — narrow your search</li>" : "")',
    '     : "<li>Not in this list. "+(banks.length?"":"None loaded.")+"</li>";',
    ' }',
    ' function pick(i){',
    '   var b=banks[i], m=document.getElementById("msg");',
    '   m.className="msg"; m.textContent="Contacting "+b.name+"…";',
    '   google.script.run.withSuccessHandler(function(r){',
    // Escaping keeps the URL inside the attribute; the scheme test is what
    // stops it being a javascript: link once it is there. An authorisation
    // URL is always https, so anything else is a reason to stop rather than
    // something to render and hope about.
    '     if(!/^https:\\/\\//.test(String(r.url||""))){',
    '       m.className="msg err";',
    '       m.textContent="The API returned an authorisation URL that is not https. Not opening it.";',
    '       return;}',
    '     m.innerHTML="Now sign in to <b>"+esc(r.aspsp)+"</b> to approve access."+',
    '       "<br><a class=\\"go\\" href=\\""+esc(r.url)+"\\" target=\\"_blank\\">Open '  + "'" + 'my bank'  + "'" + '</a>";',
    '   }).withFailureHandler(fail).beginAuthorization(b.name,b.country,(b.psuTypes||[])[0]||"personal");',
    ' }',
    '</script>'
  ].join('\n');
}
