/**
 * 19_menu.gs — the Spendsheet menu.
 *
 * The menu is built from a declaration and filtered to entries whose function
 * actually exists. That means a half-built checkout shows only what works
 * instead of offering menu items that throw, and each phase's features appear
 * simply by their file landing in the project — no menu edit required. It is
 * also why this file no longer has to be numbered last: it names its items as
 * strings and asks `functionExists_` about them at open time, so load order was
 * never what made it work.
 *
 * **The top level is what you do; the submenus are what you do once.** It grew
 * to twenty entries, of which about six were things anyone runs in a normal
 * week and the rest were setup, migration and repair — and a menu that long is
 * one you read rather than use. The split is by *how often*, not by topic:
 *
 *   - **Top level** — syncing, reviewing, and opening the app. Weekly or daily.
 *   - **Import** — the CSV procedure, and the one repair that belongs with it.
 *   - **Set up and maintain** — first run, upgrades, and the ways out of a
 *     wedged state. Reached deliberately, usually with a doc open.
 *   - **Diagnostics** — the days something is wrong. On the first screen these
 *     make the whole thing read as a system that expects to break.
 *
 * `diagnoseAccounts` used to be in that last group and is gone rather than
 * moved. It was written for one incident — the code reporting success while
 * the sheet disagreed — and it answered it. What it left behind was a menu item
 * that writes a probe value into `accounts` and clears it again, which is a
 * thing to have available while you are chasing that specific ghost and a thing
 * to have in a finance app's menu for ever afterwards.
 */

var MENU_ITEMS = [
  { name: 'Sync now', fn: 'syncNow' },
  { name: 'Connect a bank', fn: 'startAuth' },
  { name: 'Refresh accounts', fn: 'refreshAccounts' },
  { separator: true },
  { name: 'Open the app', fn: 'openWebApp' },
  { separator: true },
  { name: 'Confirm visible rows', fn: 'confirmVisibleRows' },
  { name: 'Re-categorise all', fn: 'recategorizeAll' },
  { name: 'Learn from corrections', fn: 'learnFromCorrections' },
  { name: 'Refresh review queue', fn: 'refreshReviewQueue' },
  { separator: true },
  { name: 'Health check', fn: 'healthCheck' }
];

/**
 * The CSV procedure, which is a procedure and not a feature.
 *
 * There is no importer here and there deliberately never will be — you use
 * File → Import and review `_import_staged` yourself. These two are the parts
 * of it that a human doing them by hand gets wrong: a values-only paste of two
 * blocks onto the same row without disturbing an ARRAYFORMULA, and the cleanup
 * for when an import lands rows the sync then fetches for itself.
 */
var IMPORT_ITEMS = [
  { name: 'Import staged rows', fn: 'importStagedRows' },
  { name: 'Remove synced duplicates', fn: 'removeSyncedDuplicates' }
];

/**
 * First run, upgrades, and the ways out.
 *
 * `Setup sheet` is idempotent and is the thing to run after pulling new code —
 * it is first here for that reason rather than because it is the beginning.
 * The last two are unwedgers: `Snapshot to Drive` before you do something you
 * might regret, and `Accept row count` after the row-loss detector has aborted
 * a sync and you have decided the smaller sheet is right.
 */
var MAINTENANCE_ITEMS = [
  { name: 'Setup sheet', fn: 'setup' },
  { name: 'Install credentials', fn: 'installCredentials' },
  { name: 'Install triggers', fn: 'installTriggers' },
  { name: 'Show schedule', fn: 'describeTriggers' },
  { separator: true },
  { name: 'Update mappings to defaults', fn: 'applySeedDefaults' },
  { name: 'Tidy retired categories', fn: 'tidyCategories' },
  { name: 'Rebuild charts', fn: 'rebuildCharts' },
  { separator: true },
  { name: 'Snapshot to Drive', fn: 'snapshotToDrive' },
  { name: 'Accept row count', fn: 'acceptRowCount' }
];

/**
 * The days something is wrong, plus the two probes that answer a new bank.
 *
 * The `Inspect` three are not troubleshooting despite sitting here: every entry
 * in `docs/PROVIDERS.md` came out of them, and connecting a bank nobody has
 * documented is the one recurring reason to open this submenu on a good day.
 */
var DIAGNOSTIC_ITEMS = [
  { name: 'Run smoke tests', fn: 'runSmokeTests' },
  { separator: true },
  { name: 'Inspect session', fn: 'inspectSession' },
  { name: 'Inspect account details', fn: 'inspectAccountDetails' },
  { name: 'Inspect transactions', fn: 'inspectTransactions' }
];

/** The submenus, in the order they hang off the bottom of the menu. */
var MENU_GROUPS = [
  { title: 'Import', items: IMPORT_ITEMS },
  { title: 'Set up and maintain', items: MAINTENANCE_ITEMS },
  { title: 'Diagnostics', items: DIAGNOSTIC_ITEMS }
];

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var menu = ui.createMenu('Spendsheet');
  var shown = addItems_(menu, MENU_ITEMS);

  // A submenu holding nothing is not added at all, on the same reasoning as the
  // items: a checkout without `13_import.gs` should show no Import menu rather
  // than an empty one.
  MENU_GROUPS.forEach(function (group) {
    var sub = ui.createMenu(group.title);
    if (!addItems_(sub, group.items)) return;

    if (shown) menu.addSeparator();
    menu.addSubMenu(sub);
    shown++;
  });

  if (!shown) menu.addItem('Setup sheet', 'setup');
  menu.addToUi();
}

/**
 * Add the entries that exist, and only the separators that end up with
 * something on both sides of them.
 */
function addItems_(menu, items) {
  var shown = 0;
  var pendingSeparator = false;

  items.forEach(function (item) {
    if (item.separator) {
      pendingSeparator = shown > 0;
      return;
    }
    if (!functionExists_(item.fn)) return;

    if (pendingSeparator) {
      menu.addSeparator();
      pendingSeparator = false;
    }
    menu.addItem(item.name, item.fn);
    shown++;
  });

  return shown;
}

/**
 * Apps Script puts every top-level function on the global object, so a
 * lookup by name is how we tell an implemented feature from a planned one.
 */
function functionExists_(name) {
  try {
    return typeof this[name] === 'function' || typeof eval(name) === 'function';
  } catch (e) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Opening the app
// ---------------------------------------------------------------------------

/** `_config` key holding the viewer's address, for "Open the app" to open. */
var VIEWER_URL_KEY = 'viewer_url';

/**
 * Only an https origin, and nothing else.
 *
 * This value is read out of a cell and put into a link in a dialog, which is
 * the one place in this project where something typed into the spreadsheet
 * becomes something clickable. A pattern rather than an escape: a host name is
 * letters, digits, dots and hyphens, so an address that matches carries no
 * character that could close the attribute — a stronger statement than
 * sanitising an arbitrary string. A path is refused rather than allowed,
 * because the viewer is served from its root and a path is the part of a URL
 * with room in it.
 */
var VIEWER_URL_PATTERN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?\/?$/i;

/**
 * Open the app from the menu, rather than typing a URL nobody remembers.
 *
 * A menu item cannot navigate the browser, so this is a dialog with a link in
 * it — `target="_blank"` on an anchor the user clicks. That is the only route
 * Apps Script offers, and it is also the honest one: the click is the user's.
 */
function openWebApp() {
  requireInteractive_();
  var ui = SpreadsheetApp.getUi();
  var url = String(readConfig_()[VIEWER_URL_KEY] || '').trim();

  if (!url) {
    ui.alert('No app address yet',
      'Put the viewer\'s address in _config under "' + VIEWER_URL_KEY + '" — the one ' +
      'deploying web/ printed, such as\n\nhttps://spendsheet.example.workers.dev', ui.ButtonSet.OK);
    return;
  }

  if (!VIEWER_URL_PATTERN.test(url)) {
    ui.alert('That does not look like the app address',
      '"' + VIEWER_URL_KEY + '" should be an https origin with nothing after it:\n\n' +
      'https://spendsheet.example.workers.dev\n\n' +
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
