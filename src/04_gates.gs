/**
 * 04_gates.gs — who may run what.
 *
 * Every entry point in this project opens with one of three gates, and they
 * decide on three different things:
 *
 *   `requireInteractive_()` — the Sheet reached it: a menu item, or a dialog
 *     the Sheet opened. Decided on the UI context.
 *   `requireScheduled_(e)`  — a time-driven trigger named it. Decided on the
 *     event object.
 *   `requireOwner_()`       — a dialog's callback, which has no UI of its own,
 *     reached through `requireInteractive_`. Decided on identity, against
 *     `owner_email` in `_config`.
 *
 * They live low in the numbering because nearly every file calls them, and
 * everything they need is in `00_config.gs` and `03_sheets.gs`: `_config`,
 * `Session`, `ScriptApp`. Nothing here knows about a page, a route or a
 * deployment, so no front door has to exist for a menu item or a trigger to
 * be gated. `02_api.gs`'s two credential entry points are the only callers
 * that load earlier; they call at run time, when the whole script is one
 * global scope.
 *
 * `owner_email` is seeded here too, by `seedWebAppOwner_`, because the owner
 * check is the one thing that reads it: a dialog callback has no UI, so
 * `requireInteractive_` falls back to that check, and a fresh book with no
 * owner would refuse its own dialogs.
 */

/** `_config` key holding the addresses `requireOwner_` admits. */
var WEBAPP_OWNER_KEY = 'owner_email';

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
 * `owner_email` as the set of addresses whose dialog callbacks are admitted.
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
 * The gate, on the server side of a dialog's callback.
 *
 * Throws rather than returning a refusal object, because every caller
 * would otherwise have to remember to check — and the one that forgets is the
 * one that returns the balances. A throw reaches the dialog through
 * `withFailureHandler`, which is where a refusal belongs.
 */
function requireOwner_() {
  var decision = webAppAccessDecision_(webAppOwner_(), activeUserEmail_());
  if (!decision.ok) {
    Logger.log('api refused: ' + decision.reason);
    throw new Error('Not available.');
  }
}

/**
 * The gate for a function reached from the Sheet — a menu item, or a dialog it
 * opened.
 *
 * ## Why this is not the same gate as `requireOwner_`
 *
 * `google.script.run` reaches **every** public name from any page this project
 * serves, and runs it with the owner's authority. The `_` suffix is a
 * *privacy* rule — it decides what is named to the browser — and was never an
 * authorisation one; this is the missing half. The consent redirect is served
 * to *anyone* by necessity, which is why it answers in plain text and serves no
 * page, and so no bridge (`callbackText_` in `05_auth.gs`). The pages that are
 * left are the dialogs, and they open for anyone the book is shared with — a
 * second person's browser reaches every public name through them just as the
 * owner's does. So each public name asks who is calling, and the plain-text
 * redirect is not the only thing between a stranger and every function here.
 *
 * The distinguisher is the UI context, not the identity. `getUi()` is reachable
 * from a menu click and from a dialog the container opened, and throws under a
 * page's `google.script.run` and under a trigger. Deciding on that rather than
 * on `owner_email` keeps `setup()` runnable on a fresh book, where no owner is
 * configured yet and an identity check would lock the first run out of itself.
 *
 * The fallback to `requireOwner_()` is for the one interactive path with no UI
 * of its own: a dialog's `google.script.run` callback runs server-side with no
 * `getUi()`, but with the owner as the active user. A page's anonymous call is
 * neither — no UI and no owner — so it is refused by both halves.
 *
 * Not on its own for a function a trigger invokes by name: a trigger has no UI
 * either, so this would refuse the unattended run. Those use
 * `requireScheduled_`, below.
 */
function requireInteractive_() {
  try {
    SpreadsheetApp.getUi();
    return;
  } catch (e) {
    // No UI context — a dialog's callback, a page's google.script.run, or a
    // trigger. Fall through to the identity check, which a dialog callback
    // passes and a stranger fails.
  }
  requireOwner_();
}

/**
 * The gate for a function a time-driven trigger names: `syncScheduled`,
 * `selfCheck`, `snapshotToDrive`, `learnScheduled`.
 *
 * A trigger names its handler as a string, so the handler has to be a public
 * global — and every public global is reachable from any page this project
 * serves, a dialog open in someone else's browser included. None of these is
 * harmless there. Each spends something with the owner's authority: a sync
 * spends the bank's daily allowance, where an overrun is a penalty measured in
 * hours; the health check sends mail; the snapshot writes to Drive; the memory
 * rebuild writes `_memory` and spends a revision of the book's history. The
 * health check and the snapshot also return what they found.
 *
 * ## Why the event object, and why it cannot be forged
 *
 * A real trigger run passes an event whose `authMode` is the enum
 * `ScriptApp.AuthMode.FULL`. A browser can pass arguments through
 * `google.script.run`, but only JSON — strings, numbers, plain objects and
 * arrays — plus a form, whose file inputs arrive as Blobs. None of those is
 * built on the enum's prototype, so it can send `{ authMode: 'FULL' }` and
 * never the enum itself. Loosening the check to "any object that is not a
 * plain one" would let a Blob through; keep it to the enum's own prototype.
 * That is why `==` is not used: it would coerce the enum to its name and let
 * the string through.
 *
 * Identity is accepted first. Google does not document whether the event
 * holds the *same object* as `ScriptApp.AuthMode.FULL` or a separately
 * wrapped one, and getting that wrong would stop the sync, the alarm and the
 * backup together. So a value built on the same prototype as the enum, whose
 * name is `FULL`, is accepted too. JSON cannot build that either. A plain
 * object's prototype is `Object.prototype` and it has no `toString` of its own,
 * so it prints as `[object Object]`. An array's prototype is `Array.prototype`.
 * A refused value with an `authMode` is logged by type, so a trigger this turns
 * away says why in its execution log.
 *
 * ## Why not a private name instead
 *
 * Renaming the handlers to end in `_` would take them off the surface outright,
 * like `syncAll_`. But Google does not document whether a trigger will run a
 * private function, and the triggers already installed on the live book name
 * the public ones. A rename that fails to fire stops the sync, the alarm and the
 * backup at once. This gate needs no reinstall, and it fails loudly: a refusal
 * throws, and Google emails a trigger that throws.
 *
 * Anything that is not a trigger run falls back to `requireInteractive_`. That
 * keeps the menu item for the snapshot, and running any of the four from the
 * editor, working as before.
 */
function requireScheduled_(e) {
  if (isTriggerEvent_(e)) return;
  if (e && e.authMode !== undefined) {
    Logger.log('requireScheduled_: not a trigger event, authMode was a ' + typeof e.authMode);
  }
  requireInteractive_();
}

function isTriggerEvent_(e) {
  var full = ScriptApp.AuthMode.FULL;
  var mode = e && e.authMode;
  if (mode === full) return true;
  if (!mode || typeof mode !== 'object') return false;
  try {
    return Object.getPrototypeOf(mode) === Object.getPrototypeOf(full) && String(mode) === String(full);
  } catch (err) {
    return false;
  }
}

/**
 * Write the owner address into `_config`, once.
 *
 * Called from `setup()`. `getEffectiveUser()` rather than `getActiveUser()`: setup runs
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
