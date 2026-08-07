/**
 * 19_menu.gs — the Spendsheet menu.
 *
 * Numbered last so every function it references is already defined when
 * Apps Script finishes concatenating the sources.
 *
 * The menu is built from a declaration and filtered to entries whose function
 * actually exists. That means a half-built checkout shows only what works
 * instead of offering menu items that throw, and each phase's features appear
 * simply by their file landing in the project — no menu edit required.
 *
 * Diagnostics sit in a submenu because they are for the days something is
 * wrong, and a menu whose first screen is mostly troubleshooting tools reads
 * as a system that expects to break.
 */

var MENU_ITEMS = [
  { name: 'Sync now', fn: 'syncNow' },
  { name: 'Connect a bank', fn: 'startAuth' },
  { name: 'Refresh accounts', fn: 'refreshAccounts' },
  { separator: true },
  { name: 'Import staged rows', fn: 'importStagedRows' },
  { name: 'Remove synced duplicates', fn: 'removeSyncedDuplicates' },
  { separator: true },
  { name: 'Open the app', fn: 'openWebApp' },
  { separator: true },
  { name: 'Refresh review queue', fn: 'refreshReviewQueue' },
  { name: 'Rebuild charts', fn: 'rebuildCharts' },
  { separator: true },
  { name: 'Re-categorise all', fn: 'recategorizeAll' },
  { name: 'Confirm visible rows', fn: 'confirmVisibleRows' },
  { name: 'Learn from corrections', fn: 'learnFromCorrections' },
  { separator: true },
  { name: 'Setup sheet', fn: 'setup' },
  { name: 'Update mappings to defaults', fn: 'applySeedDefaults' },
  { name: 'Tidy retired categories', fn: 'tidyCategories' },
  { name: 'Install credentials', fn: 'installCredentials' },
  { name: 'Install triggers', fn: 'installTriggers' },
  { name: 'Show schedule', fn: 'describeTriggers' },
  { name: 'Health check', fn: 'healthCheck' },
  { name: 'Accept row count', fn: 'acceptRowCount' },
  { name: 'Snapshot to Drive', fn: 'snapshotToDrive' }
];

var DIAGNOSTIC_ITEMS = [
  { name: 'Run smoke tests', fn: 'runSmokeTests' },
  { name: 'Check web app access', fn: 'describeWebAppContext' },
  { name: 'Time a web app query', fn: 'describeQueryCost' },
  { name: 'Time the app dashboard', fn: 'describeDashboardCost' },
  { name: 'Inspect session', fn: 'inspectSession' },
  { name: 'Inspect account details', fn: 'inspectAccountDetails' },
  { name: 'Inspect transactions', fn: 'inspectTransactions' },
  { name: 'Diagnose accounts tab', fn: 'diagnoseAccounts' }
];

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var menu = ui.createMenu('Spendsheet');
  var shown = addItems_(menu, MENU_ITEMS);

  var diagnostics = ui.createMenu('Diagnostics');
  if (addItems_(diagnostics, DIAGNOSTIC_ITEMS)) {
    if (shown) menu.addSeparator();
    menu.addSubMenu(diagnostics);
    shown++;
  }

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
