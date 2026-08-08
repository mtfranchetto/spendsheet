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
  { name: 'Check web app access', fn: 'describeWebAppContext' },
  { separator: true },
  { name: 'Time a web app query', fn: 'describeQueryCost' },
  { name: 'Time the app dashboard', fn: 'describeDashboardCost' },
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
