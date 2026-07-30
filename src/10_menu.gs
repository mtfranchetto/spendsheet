/**
 * 10_menu.gs — the Spendsheet menu.
 *
 * Numbered last so every function it references is already defined when
 * Apps Script finishes concatenating the sources.
 *
 * The menu is built from a declaration and filtered to entries whose function
 * actually exists. That means a half-built checkout shows only what works
 * instead of offering menu items that throw, and each phase's features appear
 * simply by their file landing in the project — no menu edit required.
 */

var MENU_ITEMS = [
  { name: 'Setup sheet', fn: 'setup' },
  { name: 'Install credentials', fn: 'installCredentials' },
  { name: 'Connect a bank', fn: 'startAuth' },
  { name: 'Sync now', fn: 'syncNow' },
  { name: 'Re-categorise all', fn: 'recategorizeAll' },
  { name: 'Learn from corrections', fn: 'learnFromCorrections' },
  { name: 'Detect recurring', fn: 'detectRecurringMenu' },
  { name: 'Rebuild cashflow', fn: 'rebuildCashflow' },
  { name: 'Health check', fn: 'healthCheck' },
  { name: 'Run smoke tests', fn: 'runSmokeTests' },
  { name: 'Install triggers', fn: 'installTriggers' }
];

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var menu = ui.createMenu('Spendsheet');
  var shown = 0;

  MENU_ITEMS.forEach(function (item) {
    if (functionExists_(item.fn)) {
      menu.addItem(item.name, item.fn);
      shown++;
    }
  });

  if (!shown) menu.addItem('Setup sheet', 'setup');
  menu.addToUi();
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
