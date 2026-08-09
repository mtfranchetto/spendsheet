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
 *
 * ## Why the app's own state is on the URL too
 *
 * The page renders inside Apps Script's sandboxed iframe, and a refresh reloads
 * the *parent* document — so everything the page was holding is gone and it is
 * served again from nothing. Which screen you were on and what you had filtered
 * to therefore has to travel in the one place that survives, the query string,
 * and `webAppView_` is the whole of reading it back. It is a second reason for
 * this file to care about parameters, and it shares a rule with the first: the
 * screen is *replaced* by one of our own constants rather than trusted, because
 * this endpoint is anonymous and the value is interpolated into the page.
 */

/** `_config` key holding the address allowed through Door 2. */
var WEBAPP_OWNER_KEY = 'owner_email';

/** `_config` key holding the Viewer deployment's URL, for the menu to open. */
var WEBAPP_URL_KEY = 'viewer_url';

/** `_config` key holding a public HTTPS image for the browser tab. See `webAppHtml_`. */
var WEBAPP_FAVICON_KEY = 'favicon_url';

/**
 * The query string the app writes about itself, spelled once.
 *
 * Short names because this ends up on a phone's address bar and in a bookmark,
 * and `v=records&p=year:2024&a=Revolut` is something you can read and edit.
 * The page holds the same five as `VIEW_PARAMS` and the two must agree — one
 * writes what the other reads, and there is no handshake to catch a drift.
 */
var WEBAPP_VIEW_PARAM = 'v';        // which screen
var WEBAPP_PERIOD_PARAM = 'p';      // the period's id, as `periods` gives it
var WEBAPP_FROM_PARAM = 'from';     // a custom period's ends, and only then
var WEBAPP_TO_PARAM = 'to';
var WEBAPP_ACCOUNT_PARAM = 'a';     // repeatable — the account filter is a set
var WEBAPP_LABEL_PARAM = 'l';
var WEBAPP_SEARCH_PARAM = 'q';
var WEBAPP_UNCONFIRMED_PARAM = 'u'; // `1`, and nothing else is true

/**
 * The screens a URL is allowed to name, the first being the default.
 *
 * The page has five, and two of them — the cash form and the balance form —
 * are reached *from an account tile* and are meaningless without it. A URL
 * naming one would restore a form with no account in it, which is worse than
 * landing on the dashboard. So this is the tab bar's three, and it is the same
 * list the page keeps as `NAV`.
 */
var WEBAPP_SCREENS = ['dashboard', 'analytics', 'records'];

/**
 * How much of any one parameter is carried through, and how many accounts.
 *
 * Not a security boundary — `htmlSafeJson_` is that, and the page treats every
 * one of these as a filter it would have let you type anyway. This is a bound
 * on what a stranger can make this endpoint put in a document: `v` is anonymous
 * by necessity, and an unbounded reflected string is the kind of thing that is
 * harmless until the next person renders it somewhere else.
 */
var WEBAPP_PARAM_MAX = 200;
var WEBAPP_ACCOUNTS_MAX = 50;

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
 * What the URL is asking to see: a screen, and the filters it was left on.
 *
 * ## Why the URL is the only place this can live
 *
 * The app renders inside Apps Script's sandboxed iframe, so nothing it does to
 * its *own* location survives anything — a refresh reloads the top-level
 * `/exec` document and the iframe is rebuilt from nothing. `sessionStorage` in
 * that frame is a Google origin the app does not own, and a `_config` cell
 * would make one book's phone dictate what the other one opens on. The query
 * string on the **parent** URL is the one piece of state that crosses the
 * boundary, and it is also the one a person can bookmark, edit and send.
 *
 * So the round trip is: change a filter, the page writes
 * `…/exec?v=records&p=year:2024&a=Revolut` through `google.script.history`,
 * refresh, `doGet` hands the parameters here, and the page opens on it.
 *
 * ## Multi-valued, because the account filter is a set
 *
 * This takes `e.parameters` — every value an array — rather than
 * `e.parameter`, which keeps only the first. Two accounts arrive as `a=X&a=Y`,
 * and the alternative was joining them on a separator that an account name is
 * merely *unlikely* to contain. The failure there is a silently dropped filter,
 * which is the shape of bug this project keeps paying for.
 *
 * ## What is validated here, and what deliberately is not
 *
 * The screen is *replaced* by one of our own constants rather than rejected, so
 * the value interpolated into the page cannot be the caller's string at all.
 * The filters cannot work that way — an account name is whatever the `accounts`
 * tab says — so they are bounded and escaped (`htmlSafeJson_`) rather than
 * checked. That is not a gap: a page can send any filter it likes to
 * `appRecords` already, and every query function is written for that. The
 * parameters are a starting point for a screen, not an authorisation.
 *
 * Inert to `webAppRoute_` by construction: a consent callback is told apart by
 * `code` and `state`, and none of these is either.
 */
function webAppView_(parameters) {
  return {
    screen: webAppScreen_(parameters),
    filters: webAppFilters_(parameters)
  };
}

/** One of `WEBAPP_SCREENS`, always, and always our copy of the string. */
function webAppScreen_(parameters) {
  var asked = webAppParam_(parameters, WEBAPP_VIEW_PARAM).toLowerCase();
  var at = WEBAPP_SCREENS.indexOf(asked);
  return at === -1 ? WEBAPP_SCREENS[0] : WEBAPP_SCREENS[at];
}

/**
 * The filters the URL named, and only those.
 *
 * Absent rather than empty: a key that is not here means "whatever the default
 * is", and the page's defaults come from the server on `appOverview`. Writing
 * `label: 'All'` instead would make a bookmark freeze today's default in place,
 * which is the one thing a defaulted value must never do.
 */
function webAppFilters_(parameters) {
  var filters = {};
  var put = function (key, name) {
    var value = webAppParam_(parameters, name);
    if (value) filters[key] = value;
  };

  put('period', WEBAPP_PERIOD_PARAM);
  put('from', WEBAPP_FROM_PARAM);
  put('to', WEBAPP_TO_PARAM);
  put('label', WEBAPP_LABEL_PARAM);
  put('search', WEBAPP_SEARCH_PARAM);

  var accounts = webAppParams_(parameters, WEBAPP_ACCOUNT_PARAM);
  if (accounts.length) filters.accounts = accounts;

  // Only `1`. A parameter whose presence alone meant true would make `u=0` and
  // `u=false` both read as "yes, only unconfirmed" — which is a screen showing
  // a fraction of the ledger and saying nothing about why.
  if (webAppParam_(parameters, WEBAPP_UNCONFIRMED_PARAM) === '1') {
    filters.unconfirmed = true;
  }

  return filters;
}

/** The first value of a parameter, trimmed and bounded. `''` when absent. */
function webAppParam_(parameters, name) {
  var values = webAppParams_(parameters, name);
  return values.length ? values[0] : '';
}

/** Every value of a repeated parameter, each trimmed and bounded, blanks dropped. */
function webAppParams_(parameters, name) {
  var raw = (parameters || {})[name];
  if (raw === null || raw === undefined) return [];

  // `e.parameters` gives arrays, but this is also called with hand-built maps
  // from the tests and from anything that ever passes `e.parameter` by mistake.
  // A bare string is one value, not a list of characters.
  var list = Object.prototype.toString.call(raw) === '[object Array]' ? raw : [raw];

  return list
    .map(function (value) {
      return String(value === null || value === undefined ? '' : value)
        .trim().slice(0, WEBAPP_PARAM_MAX);
    })
    .filter(function (value) { return value !== ''; })
    .slice(0, WEBAPP_ACCOUNTS_MAX);
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
 *
 * Takes `e.parameters` — the multi-valued map — because that is what the view
 * on the URL is read from, and the gate is decided before a parameter is looked
 * at. Which is the order that matters: nothing a stranger puts on this URL is
 * examined until Google and this function have both said who they are.
 */
function webAppPage_(parameters) {
  var decision = webAppAccessDecision_(webAppOwner_(), activeUserEmail_());
  if (!decision.ok) {
    Logger.log('webAppPage_ refused: ' + decision.reason);
    return authPage_('Not available', 'This page is not available.');
  }
  return webAppHtml_(parameters);
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
  var allowed = allowedEmails_(owner);
  if (!allowed.length) return { ok: false, reason: 'no owner address configured' };
  if (!isEmailish_(active)) return { ok: false, reason: 'no active user' };
  if (allowed.indexOf(normalizeEmail_(active)) === -1) {
    return { ok: false, reason: 'not the owner' };
  }
  return { ok: true, reason: null };
}

/**
 * `owner_email` as the set of addresses allowed through Door 2.
 *
 * One cell, comma-separated, because two people share a household ledger and
 * the alternative — giving a second person the first person's Google password —
 * is worse in every direction. `setup()` still seeds exactly one address; a
 * second is something you add deliberately.
 *
 * **Every entry must survive `isEmailish_`, and anything that does not is
 * dropped rather than tolerated.** That matters more here than it looks: a
 * trailing comma yields an empty entry, and an empty entry that reached the
 * comparison would match the empty string `activeUserEmail_` returns when
 * Google declines to tell us who is calling — which is precisely the case the
 * gate exists to refuse. Dropping it keeps "we do not know who this is" and
 * "this cell has a typo in it" from resolving to *open the door*.
 *
 * Normalised on the way in so the comparison is a set membership test rather
 * than a loop with a case rule inside it.
 */
function allowedEmails_(value) {
  return String(value === null || value === undefined ? '' : value)
    .split(',')
    .map(normalizeEmail_)
    .filter(isEmailish_);
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
 * JSON that is safe to sit inside a `<script>` element.
 *
 * A transaction description containing the closing-tag sequence would end the
 * element early and put a merchant name into the document as markup. Escaping
 * every `<` is the entire fix, and it stays valid JSON because `<` is a legal
 * string escape — so the parse on the other side is unchanged.
 *
 * Deliberately not a filter on the *dangerous* sequence: a rule that matches
 * the closing tag has to reason about case, whitespace and slashes, and this
 * project has already learned that the narrow guard is the one that misses.
 * Every `<` costs a few bytes and cannot be wrong.
 *
 * It lives here rather than beside `appInlineBoot_`, which was its first
 * caller, because the second caller is `webAppHtml_` a few lines below and one
 * escaper with two callers beats two escapers — see the note left in 23.
 */
function htmlSafeJson_(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

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
/**
 * One partial, inlined where its scriptlet sits in `page.html`.
 *
 * `createHtmlOutputFromFile` rather than `createTemplateFromFile`, and the
 * difference is what the partials are allowed to contain. A template would be
 * evaluated, so a `<?` anywhere in one — inside a regex, inside a comment
 * explaining templating — becomes a parse failure in a file that has no
 * scriptlets and no reason to be scanned for any. Only `page.html` is a
 * template; everything it includes is text.
 *
 * The `_` suffix is right and is not a formality. A template calls whatever it
 * likes, so this is reachable from `page.html`; `google.script.run` refuses a
 * trailing underscore, so it is not reachable from a browser. Without it this
 * would be an entry point that reads a file named by its caller.
 */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

function webAppHtml_(parameters) {
  var template = HtmlService.createTemplateFromFile('page');
  template.boot = functionExists_('appInlineBoot_') ? appInlineBoot_() : 'null';

  /*
    Which screen to open on and with what filters, decided here rather than by
    the page.

    The alternative was `google.script.url.getLocation`, which reads the parent
    URL from inside the iframe — and does it asynchronously, so the page would
    have drawn the dashboard on last month's filters before learning what it
    was meant to be showing. A visible flip on every refresh, to avoid a value
    the document already knows.

    Unlike `boot` this is never skipped: a deep link has to survive the inline
    dashboard failing, and it costs a parse of the query string.
  */
  template.view = htmlSafeJson_(webAppView_(parameters));

  var page = template.evaluate()
    .setTitle('Spendsheet')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);

  /*
    The tab icon, and the three things that make it not a one-liner.

    **A `<link rel="icon">` in `page.html` would do nothing.** The page renders
    inside Apps Script's sandboxed `userCodeAppPanel` iframe, so a link element
    there names an icon for the iframe's document, which no browser puts on a
    tab. `setFaviconUrl` is the only route that reaches the wrapper.

    **The URL has to be publicly fetchable over HTTPS.** Google fetches it
    server-side; a `data:` URI is rejected outright, and a Drive file left
    private answers with a sign-in *page* rather than an image — which fails by
    simply never appearing, with nothing logged anywhere. `docs/SHARING.md`'s
    sibling note in `docs/MOBILE.md` has the sharing step.

    **It does not fix the home-screen icon**, only the browser tab. iOS reads
    `apple-touch-icon` from the *top-level* document, and for an `/exec` URL
    that document is Google's, not ours.

    Read from `_config` rather than frozen here so the icon is yours to change
    without a deploy, and skipped entirely when blank — an empty cell is a
    question nobody has answered, and passing '' would be asking Google to
    fetch the current page as an image.
  */
  var favicon = String(readConfig_()[WEBAPP_FAVICON_KEY] || '').trim();
  if (favicon.indexOf('https://') === 0) page.setFaviconUrl(favicon);

  return page;
}
