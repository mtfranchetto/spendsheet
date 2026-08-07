/**
 * 20_webapp.gs — the second front door.
 *
 * The Google Sheets mobile app is where this book is actually used, and it is
 * bad at it — not because of the layout, which has already been reworked for a
 * phone once, but because it is a general-purpose grid renderer that must open
 * 4,600 rows and fifty ARRAYFORMULAs before it can show you anything. That
 * route is spent. So the Sheet stays the datastore and gains a second way in:
 * an Apps Script web app, served from the same container-bound project.
 *
 * Every founding constraint survives — no server, no cost, no build step, and
 * the data outlives the tooling because the data is still a spreadsheet.
 *
 * ## Two deployments, one project
 *
 * A Sheet has exactly one bound script, and every way around that — a
 * standalone project, a library — forces `spreadsheets.currentonly` up to the
 * broad `spreadsheets` scope, which `tests/manifest.test.mjs` refuses. What
 * Apps Script *does* allow is many deployments of one project, each with its
 * own URL and its own access setting:
 *
 *   Door 1, the consent redirect — the URL already registered with Enable
 *   Banking, access **Anyone**. It must stay anonymous: PSD2 consent often
 *   completes inside the bank's own webview, which carries no Google session,
 *   and a login wall there kills `ebCreateSession(params.code)` while the
 *   authorisation code expires.
 *
 *   Door 2, the app — a new, private URL, access **Only myself**. Google
 *   refuses everyone else before a line of this file runs.
 *
 * Both doors run the same `doGet`. That is the *only* reason the owner gate
 * below exists: without it an anonymous visitor to Door 1 would be served the
 * app. The gate is a second lock on a door Google has already locked, not the
 * lock itself — and it is written to fail closed, because the failure that
 * matters is serving bank balances to a stranger, not refusing them to you.
 *
 * ## Why the route is decided by the parameters
 *
 * A bank's callback arrives carrying `code` and `state`; a person opening the
 * app arrives carrying nothing. That is the whole test, and it is pure, so
 * every case is a unit test rather than a deployment to try.
 *
 * The one thing it must never do is serve the app to a request that looks like
 * a callback, or refuse a callback because it looked like a person. Ambiguity
 * resolves towards consent: a request with either parameter is a callback.
 */

/** `_config` key holding the address allowed through Door 2. */
var WEBAPP_OWNER_KEY = 'owner_email';

/** `_config` key holding the Viewer deployment's URL, for the menu to open. */
var WEBAPP_URL_KEY = 'viewer_url';

/**
 * Only an Apps Script `/exec` URL, and nothing else.
 *
 * This value is read out of a cell and put into a link in a dialog, which is
 * the one place in this project where something typed into the spreadsheet
 * becomes something clickable. A pattern rather than an escape: the set of
 * URLs this menu item has any business opening is exactly one shape, and
 * checking for that shape is a stronger statement than sanitising an arbitrary
 * one. `/u/N/` is allowed because it is what a multi-account browser needs.
 */
var WEBAPP_URL_PATTERN =
  /^https:\/\/script\.google\.com\/(u\/\d+\/)?macros\/s\/[A-Za-z0-9_-]+\/exec$/;

/**
 * Open the app from the menu, rather than typing a URL nobody remembers.
 *
 * A menu item cannot navigate the browser, so this is a dialog with a link in
 * it — `target="_blank"` on an anchor the user clicks. That is the only route
 * Apps Script offers, and it is also the honest one: the click is the user's.
 */
function openWebApp() {
  var ui = SpreadsheetApp.getUi();
  var url = String(readConfig_()[WEBAPP_URL_KEY] || '').trim();

  if (!url) {
    ui.alert('No app URL yet',
      'Put the Viewer deployment URL in _config under "' + WEBAPP_URL_KEY + '".\n\n' +
      'Deploy → Manage deployments → the one with access "Only myself" → copy its ' +
      'Web app URL.', ui.ButtonSet.OK);
    return;
  }

  if (!WEBAPP_URL_PATTERN.test(url)) {
    ui.alert('That does not look like the app URL',
      '"' + WEBAPP_URL_KEY + '" should be an Apps Script /exec address:\n\n' +
      'https://script.google.com/macros/s/…/exec\n\n' +
      'What is there now is:\n\n' + url, ui.ButtonSet.OK);
    return;
  }

  // The URL is known to match the pattern above, so it carries no character
  // that could close the attribute — which is why the check is a whitelist and
  // not an escape.
  var page = HtmlService.createHtmlOutput(
    '<p style="font:14px system-ui;margin:0 0 16px">' +
    'Opens in a new tab. Add it to your home screen from there.</p>' +
    '<p style="font:14px system-ui"><a href="' + url + '" target="_blank" ' +
    'rel="noopener">Open Spendsheet</a></p>')
    .setWidth(360).setHeight(140);

  ui.showModalDialog(page, 'The app');
}

/**
 * Which page a request wants, from its query string alone.
 *
 * Pure and parameter-only. `code` is what the bank returns on success and
 * `state` is the nonce it echoes back — either one present means this is the
 * consent round-trip, including the failure shapes: a bank that denies consent
 * comes back with `state` and `error` and no `code`, and that page has to be
 * the consent page or the message never reaches you.
 *
 * `error` alone is deliberately NOT a consent signal. It is the one parameter
 * anyone can put on the URL, and treating it as one would let a stranger reach
 * the consent branch of `doGet` — which is harmless today and is exactly the
 * kind of "harmless" that stops being true when the branch changes.
 */
function webAppRoute_(params) {
  var query = params || {};
  if (query.code || query.state) return 'consent';
  return 'app';
}

/**
 * Door 2, gated.
 *
 * Reached from `doGet` when the request carries no consent parameters. Every
 * way of not knowing who is asking is a refusal:
 *
 *   - `Session.getActiveUser().getEmail()` returns `''` for an anonymous
 *     visitor, which is what Door 1 produces.
 *   - It can also throw, depending on how the deployment resolves the caller.
 *     A throw is not "probably fine".
 *   - A blank owner address means `setup()` has never run here, and an
 *     unconfigured lock must be a closed one — the alternative is a book that
 *     serves its balances to anyone until someone remembers to configure it.
 *
 * The refusal says nothing about why. This endpoint is public by necessity and
 * a message that distinguished "wrong account" from "no owner configured"
 * would be a probing oracle, for no benefit to the one person who can get in.
 */
function webAppPage_(params) {
  var decision = webAppAccessDecision_(webAppOwner_(), activeUserEmail_());
  if (!decision.ok) {
    Logger.log('webAppPage_ refused: ' + decision.reason);
    return authPage_('Not available', 'This page is not available.');
  }
  return webAppHtml_();
}

/**
 * Is this caller the owner? Pure, so every refusal has a test.
 *
 * Compared case-insensitively and trimmed, because an address is not
 * case-sensitive in its domain part and Google is inconsistent about which
 * case it hands back. Anything that is not a non-empty string on both sides is
 * a refusal before the comparison is reached — `String(undefined)` is
 * `'undefined'`, and two of those compare equal.
 */
function webAppAccessDecision_(owner, active) {
  if (!isEmailish_(owner)) return { ok: false, reason: 'no owner address configured' };
  if (!isEmailish_(active)) return { ok: false, reason: 'no active user' };
  if (normalizeEmail_(owner) !== normalizeEmail_(active)) {
    return { ok: false, reason: 'not the owner' };
  }
  return { ok: true, reason: null };
}

/**
 * Enough of an address to compare, which is not the same as valid.
 *
 * Deliberately not a validating regex. The question here is "did we get told
 * anything at all", and a stricter test would turn an address Google accepts
 * and we do not into a lockout with no error to read.
 */
function isEmailish_(value) {
  return typeof value === 'string' && value.indexOf('@') > 0;
}

function normalizeEmail_(value) {
  return String(value).trim().toLowerCase();
}

/** Never throws. A gate that throws while deciding has decided nothing. */
function activeUserEmail_() {
  try {
    return Session.getActiveUser().getEmail() || '';
  } catch (e) {
    return '';
  }
}

function webAppOwner_() {
  try {
    return String(readConfig_()[WEBAPP_OWNER_KEY] || '');
  } catch (e) {
    return '';
  }
}

/**
 * Write the owner address into `_config`, once.
 *
 * Called from `setup()` through `functionExists_`, because 04 loads before
 * this file. `getEffectiveUser()` rather than `getActiveUser()`: setup runs
 * from the menu, where they are the same person, and the effective user is the
 * one whose credentials the deployment will run under — which is the account
 * this lock is protecting.
 *
 * Only when blank, like every other seeded value. Overwriting would mean that
 * running `setup()` from a second account you had shared the book with
 * silently moved the lock to them.
 */
function seedWebAppOwner_(ss) {
  var sheet = ss.getSheetByName(TABS.CONFIG);
  if (!sheet) return null;

  var row = findRowByValue_(sheet, colIndex_(CONFIG_COLUMNS, 'key'), WEBAPP_OWNER_KEY);
  if (!row) return null;

  if (!isBlankCell_(readCell_(sheet, row, CONFIG_COLUMNS, 'value'))) return null;

  var email = '';
  try {
    email = Session.getEffectiveUser().getEmail() || '';
  } catch (e) {
    email = '';
  }
  if (!isEmailish_(email)) return null;

  writeCell_(sheet, row, CONFIG_COLUMNS, 'value', email);
  return email;
}

// ---------------------------------------------------------------------------
// Serving the page
// ---------------------------------------------------------------------------

/**
 * The page itself, from `src/page.html`, with the first screen already in it.
 *
 * **This was deliberately a static file, and the reasoning has been overtaken
 * by a measurement.** The argument was that everything arrives through
 * `google.script.run` anyway, so there is nothing to interpolate and therefore
 * nothing that can be interpolated wrong — a good trade when interpolation buys
 * nothing. It buys about two seconds.
 *
 * A `google.script.run` call costs ~2,700ms of Apps Script startup before any
 * of our code runs; this function is already inside an execution that has paid
 * that. So the dashboard's first screen is templated into the document and
 * draws as the page parses, with no round trip at all.
 *
 * The escaping boundary that worried the original note is real and it is
 * exactly one line — `htmlSafeJson_`, which lives next to the data rather than
 * here. The payload goes into a `<script type="application/json">` element, so
 * it is never executed and never parsed as markup; the only way out of that
 * element is a literal `<`, and every one of them is escaped.
 *
 * **`appInlineBoot_` is in `23_api.gs`, which is above this file**, and the
 * numbering says nothing lower may depend on anything higher. It is called
 * through `functionExists_` for that reason: the dependency is real — a page
 * server that inlines data needs the data — and a partial checkout without 23
 * still serves a page that fetches, which is what it did before.
 *
 * `viewport` is what makes a phone lay the page out at its own width instead
 * of pretending to be a 980px desktop and zooming out. Apps Script strips the
 * tag if you write it into the file, so it has to be added here.
 *
 * `DEFAULT` is the whole of the `XFrameOptionsMode` vocabulary worth using: it
 * makes Apps Script send its standard `X-Frame-Options` header, so nobody else
 * can frame this page. The only other value is `ALLOWALL`, which removes the
 * header — the opposite of what a page rendering bank balances wants, and a
 * clickjacking surface if it were ever set here.
 *
 * The first draft passed `XFrameOptionsMode.IFRAME`, which does not exist:
 * `IFRAME` belongs to **`SandboxMode`**, a different and now-vestigial enum.
 * That reads as an ordinary confusion between two neighbouring settings and it
 * is worse than it looks — the argument evaluates to `undefined` and takes the
 * page down for the owner, while the comment above it confidently described
 * *inbound* framing when the setter controls the outbound header. The harness
 * missed it because its stub invented an `IFRAME` member that the real enum
 * does not have; being more forgiving than the real thing is the worst
 * direction for a fake to be wrong in, and it has now cost this project twice.
 */
function webAppHtml_() {
  var template = HtmlService.createTemplateFromFile('page');
  template.boot = functionExists_('appInlineBoot_') ? appInlineBoot_() : 'null';

  return template.evaluate()
    .setTitle('Spendsheet')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}
