/**
 * 16_migrations.gs — bringing a book that already exists up to the seed.
 *
 * `setup()` in 04_setup.gs only ever adds: a tab, a column, a seed row that is
 * missing. It never changes an answer you have given and never removes a row,
 * which is what makes it safe to re-run and is also where it stops. The two
 * things here are what lies past that line, and both ask before they act:
 *
 *   - `applySeedDefaults()` — a seeded row whose answer differs from the
 *     default is replaced, on a yes.
 *   - `tidyCategories()` — a category the seed has retired is repointed
 *     everywhere it is named, then removed.
 *
 * Its own file because it is a different kind of thing from building: these
 * rewrite and delete rows on a book with history in it, run from the menu when
 * a version asks for them, and nothing in `setup()` calls either. Above
 * 04_setup.gs because it asks that file's question — `seedRowDiffers_` — and
 * must give the same answer when it acts on it.
 */

// ---------------------------------------------------------------------------
// Accepting the defaults
// ---------------------------------------------------------------------------

/**
 * Menu → Update mappings to defaults.
 *
 * `setup()` reports a seeded row that disagrees with the defaults and changes
 * nothing, because it cannot tell an edit you made from one an old version
 * left behind. That is the right default and a dead end on its own: after the
 * taxonomy shrank from fifteen categories to twelve, eleven mappings still
 * pointed at parents that no longer exist, and the only offered remedy was
 * retyping them.
 *
 * So this is the other half — the same comparison, shown in full, applied
 * only on a yes. Keys are never touched, so nothing is added or removed here;
 * only the answer part of a row you already have is replaced.
 *
 * It also names **orphans**: rows whose target category is not in `categories`
 * at all. Those are invisible rather than wrong — an override naming a
 * category the taxonomy does not have simply never appears in a report that
 * groups by category, which is the most expensive way for a mapping to fail.
 */
function applySeedDefaults() {
  requireInteractive_();
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var report = { diverged: [] };
  UPGRADABLE_SEEDS.forEach(function (entry) {
    var sheet = ss.getSheetByName(entry.tab);
    if (sheet) reportSeedDivergence_(sheet, entry, entry.seed(), report);
  });

  var orphans = orphanedCategoryMappings_(ss);

  if (!report.diverged.length && !orphans.length) {
    ui.alert('Update mappings', 'Every seeded row already matches the defaults.', ui.ButtonSet.OK);
    return { updated: 0, orphans: orphans };
  }

  var answer = ui.alert('Update mappings',
    describeSeedUpdate_(report.diverged, orphans), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    ss.toast('Nothing was changed.', 'Cancelled', 5);
    return { updated: 0, orphans: orphans };
  }

  var updated = 0;
  UPGRADABLE_SEEDS.forEach(function (entry) {
    updated += rewriteSeedRows_(ss.getSheetByName(entry.tab), entry);
  });

  ss.toast(updated + ' row(s) updated.' +
    (orphans.length ? ' ' + orphans.length + ' orphan(s) left for you — see _anomalies.' : ''),
    'Defaults applied', 20);
  return { updated: updated, orphans: orphans };
}

// ---------------------------------------------------------------------------
// Retiring a category
// ---------------------------------------------------------------------------

/**
 * Menu → Tidy retired categories.
 *
 * `applySeedDefaults()` fixes rows whose *answer* drifted from the defaults. It
 * cannot fix a row that should not exist any more, because seeding only ever
 * adds: after the taxonomy went from fifteen parents to twelve, `Family`,
 * `Travel` and `Bills & Utilities` stayed in `categories` with all their
 * children, offered by every dropdown, one careless click from coming back.
 *
 * Removing them is not enough on its own. A `_category_map` row, a `rules` row
 * or a `category_override` still naming a retired category does not break —
 * it goes *invisible*, which is worse: the row is categorised as something no
 * report groups by, so its money silently leaves every total while the sheet
 * looks fine. That is the failure the tie-out against BudgetBakers caught.
 *
 * So references are repointed first and the rows removed second, and everything
 * is named before anything happens.
 *
 * `RETIRED_CATEGORIES` in 00_config.gs is keyed on the full category/subcategory
 * pair, which is what makes each move unambiguous. A `category_override` holds
 * a parent alone, so a parent is only rewritten when every one of its retired
 * children agrees on where it went: `Travel` always became `Life & Entertainment`,
 * while `Family` split between `Shopping` and `Life & Entertainment` and is therefore
 * reported and left for you.
 */
function tidyCategories() {
  requireInteractive_();
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plan = planCategoryTidy_(ss);

  if (plan.error) {
    ui.alert('Tidy retired categories', plan.error, ui.ButtonSet.OK);
    return plan;
  }

  var answer = ui.alert('Tidy retired categories', describeCategoryTidy_(plan), ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) {
    ss.toast('Nothing was changed.', 'Cancelled', 5);
    return plan;
  }

  var result = commitCategoryTidy_(ss, plan);
  ss.toast(result.removed + ' categories removed, ' + result.repointed + ' references repointed.',
    'Taxonomy tidied', 15);
  return result;
}

function planCategoryTidy_(ss) {
  var categories = ss.getSheetByName(TABS.CATEGORIES);
  if (!categories) return { error: 'No ' + TABS.CATEGORIES + ' tab. Run Setup sheet first.' };

  var rows = readRecords_(categories, CATEGORY_COLUMNS, colIndex_(CATEGORY_COLUMNS, 'category'));
  var present = {};
  rows.forEach(function (row) {
    if (row.category) present[pairKey_(row.category, row.subcategory)] = true;
  });

  var retired = RETIRED_CATEGORIES.filter(function (entry) {
    return present[pairKey_(entry.category, entry.subcategory)];
  });

  var parentMoves = unambiguousParentMoves_();

  var plan = {
    categories: categories,
    rows: rows,
    retired: retired,
    parentMoves: parentMoves,
    mappings: retargetPairs_(ss, TABS.CATEGORY_MAP, CATEGORY_MAP_COLUMNS, 'source_category'),
    rules: retargetPairs_(ss, TABS.RULES, RULE_COLUMNS, 'priority'),
    overrides: retargetOverrides_(ss, parentMoves),
    subcategories: retargetSubcategories_(ss),
    ambiguous: ambiguousParents_()
  };

  // Stranded rows are deliberately not work: nothing can be done to them
  // automatically, and counting them would make "Tidy" offer itself forever on
  // a book where every remaining row is one it must not touch.
  var work = retired.length + plan.mappings.length + plan.rules.length +
    plan.overrides.length + plan.subcategories.rows.length;
  if (!work) {
    return { error: 'Nothing to tidy — no retired category is left in ' + TABS.CATEGORIES +
      ', and nothing still points at one.' };
  }

  return plan;
}

function pairKey_(category, subcategory) {
  return String(category || '') + '\u0000' + String(subcategory || '');
}

/**
 * Parents this list actually retires — as opposed to ones it only renames a
 * child of.
 *
 * A retirement whose `to` keeps the same parent is a rename, and the parent is
 * still in the taxonomy. Reading the list without this distinction gets both
 * halves wrong at once: `Insurance / Home → Insurance / Home insurance` makes
 * `Insurance` look like a parent that "moved" to itself, so every
 * `category_override` holding it is offered up for a rewrite that changes
 * nothing, and the plan reports work where there is none. Suppress the self-move
 * alone and it swings the other way — `Insurance` becomes a parent whose
 * children disagree, and the dialog warns you to retype rows that are correct.
 *
 * The taxonomy settles it. A parent still in `DEFAULT_CATEGORIES` was never
 * retired, whatever its children did.
 */
function retiredParents_() {
  var candidates = {};
  RETIRED_CATEGORIES.forEach(function (entry) { candidates[entry.category] = true; });
  DEFAULT_CATEGORIES.forEach(function (row) { delete candidates[row[0]]; });
  return candidates;
}

/**
 * Retired parents whose children all went to the same place.
 *
 * A parent is only safe to rewrite on its own when there is one answer. Anything
 * else has to be looked at, because picking either branch would file real
 * spending under a category you did not choose.
 */
function unambiguousParentMoves_() {
  var retired = retiredParents_();
  var seen = {};
  RETIRED_CATEGORIES.forEach(function (entry) {
    if (!retired[entry.category]) return;
    var to = entry.to[0];
    if (!(entry.category in seen)) { seen[entry.category] = to; return; }
    if (seen[entry.category] !== to) seen[entry.category] = null;
  });

  var moves = {};
  Object.keys(seen).forEach(function (parent) {
    if (seen[parent]) moves[parent] = seen[parent];
  });
  return moves;
}

function ambiguousParents_() {
  var all = retiredParents_();
  var unambiguous = unambiguousParentMoves_();
  return Object.keys(all).filter(function (parent) { return !unambiguous[parent]; });
}

/**
 * Rows on a tab whose `category`/`subcategory` name a retired pair.
 *
 * Both `_category_map` and `rules` carry those two columns under exactly those
 * names, so one function covers both — they differ only in which column decides
 * where the records end.
 */
function retargetPairs_(ss, tab, headers, keyColumn) {
  var sheet = ss.getSheetByName(tab);
  if (!sheet) return [];

  var byPair = {};
  RETIRED_CATEGORIES.forEach(function (entry) {
    byPair[pairKey_(entry.category, entry.subcategory)] = entry.to;
  });

  return readRecords_(sheet, headers, colIndex_(headers, keyColumn))
    .map(function (row) {
      var to = byPair[pairKey_(row.category, row.subcategory)];
      if (!to) return null;
      return {
        tab: tab,
        headers: headers,
        row: row._row,
        from: row.category + ' / ' + row.subcategory,
        to: to[0] + ' / ' + to[1],
        category: to[0],
        subcategory: to[1]
      };
    })
    .filter(function (entry) { return entry; });
}

/**
 * Retired child names that can be rewritten wherever they are found, and the
 * ones that cannot.
 *
 * Only retirements that *change the name* are of any interest here. Most of this
 * list moves a child to a new parent and keeps its name — `Bills & Utilities /
 * Electricity` became `Housing / Electricity` — and a cell saying `Electricity`
 * already reads correctly, because the parent it names is looked up rather than
 * stored. Treating those as needing attention would flag twelve columns' worth
 * of rows that are perfectly fine.
 *
 * Of the renames, a `subcategory_override` holds a bare child name with no
 * parent beside it, so the pair this list is keyed on is not available at the
 * cell. The name has to carry the whole answer, which it does only when nothing
 * left in the taxonomy is still called that.
 *
 * Neither of today's two renames qualifies, and that is not a defect — `Home`
 * and `Books` survive under Shopping, which is *why* they were renamed. A row
 * saying `Home` has always resolved to Shopping (the lookup takes the first
 * match, and Shopping comes first in the seed), so leaving it alone changes
 * nothing and moves no money. What it cannot do is know you meant the insurance
 * one. Those get named and counted, not guessed at.
 */
function childRenames_() {
  var renamed = RETIRED_CATEGORIES.filter(function (entry) {
    return entry.subcategory !== entry.to[1];
  });

  var surviving = {};
  DEFAULT_CATEGORIES.forEach(function (row) { surviving[row[1]] = true; });

  var count = {};
  renamed.forEach(function (entry) {
    count[entry.subcategory] = (count[entry.subcategory] || 0) + 1;
  });

  var moves = {};
  var stranded = [];
  renamed.forEach(function (entry) {
    var name = entry.subcategory;
    if (count[name] === 1 && !surviving[name]) { moves[name] = entry.to[1]; return; }
    if (stranded.indexOf(name) === -1) stranded.push(name);
  });

  return { moves: moves, stranded: stranded };
}

/**
 * `subcategory_override` cells naming a retired child.
 *
 * The column the tidy used to ignore. It held nothing worth migrating when a
 * correction meant typing a parent; now that picking the child is the way a row
 * gets corrected, it is where most of them are, and a rename that skipped it
 * would leave the corrections behind while removing what they pointed at.
 *
 * Returns the rewritable rows and, separately, the rows whose child name no
 * longer identifies one parent — those are reported so you can find them, and
 * left exactly as they are.
 */
function retargetSubcategories_(ss) {
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  var renames = childRenames_();
  if (!tx) return { rows: [], stranded: [] };

  var rows = [];
  var strandedCounts = {};

  readRecords_(tx, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid')).forEach(function (row) {
    var from = String(row.subcategory_override || '');
    if (!from) return;

    if (renames.moves[from]) {
      rows.push({ row: row._row, from: from, to: renames.moves[from] });
      return;
    }
    if (renames.stranded.indexOf(from) !== -1) {
      strandedCounts[from] = (strandedCounts[from] || 0) + 1;
    }
  });

  var stranded = Object.keys(strandedCounts).sort().map(function (name) {
    return { name: name, count: strandedCounts[name] };
  });

  return { rows: rows, stranded: stranded };
}

/**
 * `category_override` cells naming a retired parent.
 *
 * Parent-only: this column holds a bare parent name. The child column is
 * handled by `retargetSubcategories_`, which has a harder problem — a parent
 * name is unique by construction, a child name is not.
 */
function retargetOverrides_(ss, parentMoves) {
  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  if (!tx) return [];

  return readRecords_(tx, TX_COLUMNS, colIndex_(TX_COLUMNS, 'uid'))
    .map(function (row) {
      var from = String(row.category_override || '');
      var to = parentMoves[from];
      if (!to) return null;
      return { row: row._row, from: from, to: to };
    })
    .filter(function (entry) { return entry; });
}

function describeCategoryTidy_(plan) {
  var lines = [];

  if (plan.retired.length) {
    lines.push('Remove ' + plan.retired.length + ' retired categories from ' + TABS.CATEGORIES + ':');
    plan.retired.forEach(function (entry) {
      lines.push('  ' + entry.category + ' / ' + entry.subcategory + '  →  ' +
        entry.to[0] + ' / ' + entry.to[1]);
    });
    lines.push('');
  }

  [['mappings', TABS.CATEGORY_MAP], ['rules', TABS.RULES]].forEach(function (pair) {
    var entries = plan[pair[0]];
    if (!entries.length) return;
    lines.push('Repoint ' + entries.length + ' rows in ' + pair[1] + ':');
    summarizeMoves_(entries).forEach(function (line) { lines.push('  ' + line); });
    lines.push('');
  });

  if (plan.overrides.length) {
    lines.push('Rewrite category_override on ' + plan.overrides.length + ' transactions:');
    summarizeMoves_(plan.overrides).forEach(function (line) { lines.push('  ' + line); });
    lines.push('');
  }

  if (plan.subcategories.rows.length) {
    lines.push('Rewrite subcategory_override on ' + plan.subcategories.rows.length +
      ' transactions:');
    summarizeMoves_(plan.subcategories.rows).forEach(function (line) { lines.push('  ' + line); });
    lines.push('');
  }

  if (plan.subcategories.stranded.length) {
    lines.push('⚠ Left alone: ' + plan.subcategories.stranded.map(function (entry) {
      return entry.count + ' transactions saying "' + entry.name + '"';
    }).join(', ') + '. That name is still a subcategory of another parent, so ' +
      'these keep reading as that one — which is what they already did. If any ' +
      'of them meant the retired one, only you know which.');
    lines.push('');
  }

  if (plan.ambiguous.length) {
    lines.push('⚠ Left alone: ' + plan.ambiguous.join(', ') + '. Their children went to more ' +
      'than one parent, so a row naming only the parent cannot be resolved without guessing. ' +
      'Retype those by hand.');
    lines.push('');
  }

  lines.push('Continue?');
  return lines.join('\n');
}

function summarizeMoves_(entries) {
  var counts = {};
  entries.forEach(function (entry) {
    var key = entry.from + '  →  ' + entry.to;
    counts[key] = (counts[key] || 0) + 1;
  });
  return Object.keys(counts).sort().map(function (key) { return key + '  (' + counts[key] + ')'; });
}

/**
 * References first, rows second.
 *
 * In that order because the reverse leaves a window — however short — where a
 * mapping points at a category the taxonomy no longer has, which is exactly the
 * invisible state this exists to end.
 */
function commitCategoryTidy_(ss, plan) {
  var repointed = 0;

  plan.mappings.concat(plan.rules).forEach(function (entry) {
    var sheet = ss.getSheetByName(entry.tab);
    writeCell_(sheet, entry.row, entry.headers, 'category', entry.category);
    writeCell_(sheet, entry.row, entry.headers, 'subcategory', entry.subcategory);
    repointed++;
  });

  var tx = ss.getSheetByName(TABS.TRANSACTIONS);
  plan.overrides.forEach(function (entry) {
    writeCell_(tx, entry.row, TX_COLUMNS, 'category_override', entry.to);
    repointed++;
  });
  plan.subcategories.rows.forEach(function (entry) {
    writeCell_(tx, entry.row, TX_COLUMNS, 'subcategory_override', entry.to);
    repointed++;
  });

  var removed = removeRetiredCategories_(plan);

  return {
    removed: removed,
    repointed: repointed,
    ambiguous: plan.ambiguous,
    stranded: plan.subcategories.stranded
  };
}

/**
 * Rewrite `categories` without the retired rows.
 *
 * Compacted rather than blanked in place: the dropdown reads `A2:A`, and a run
 * of gaps in the middle of the list is the kind of untidiness that gets
 * "cleaned up" later by deleting rows, which is how an anchored formula on some
 * other tab dies.
 *
 * **Only the stored columns.** This once said "there are no formulas on this
 * tab, so one rewrite is safe", and that stopped being true the moment
 * `parent_list` was added — four anchors sit in row 2 now. Clearing the full
 * width erased all four and then wrote the values they had spilled back as
 * stored data, so the column was both formula-less and full: a later
 * `setFormula_` restores the anchor and it cannot expand past what is sitting
 * under it. One tidy, and every dropdown on the book loses its source.
 *
 * The derived half is the formulas' business. Rows appear and disappear beneath
 * them and they follow, which is the entire point of an ARRAYFORMULA.
 */
function removeRetiredCategories_(plan) {
  var retiredKeys = {};
  plan.retired.forEach(function (entry) {
    retiredKeys[pairKey_(entry.category, entry.subcategory)] = true;
  });
  if (!plan.retired.length) return 0;

  var width = CATEGORY_COLUMNS_STORED.length;
  var keep = plan.rows
    .filter(function (row) { return row.category; })
    .filter(function (row) { return !retiredKeys[pairKey_(row.category, row.subcategory)]; })
    .map(function (row) { return toRow_(CATEGORY_COLUMNS_STORED, row); });

  var sheet = plan.categories;
  clearDataRows_(sheet, colIndex_(CATEGORY_COLUMNS, 'category'), width);
  if (keep.length) sheet.getRange(2, 1, keep.length, width).setValues(keep);

  return plan.retired.length;
}

/** Replace the non-key columns of any row whose key matches a seed row. */
function rewriteSeedRows_(sheet, entry) {
  if (!sheet) return 0;

  var seed = entry.seed();
  var width = seed.length ? seed[0].length : 0;
  if (width <= entry.keyWidth) return 0;

  var wanted = {};
  seed.forEach(function (row) { wanted[seedKey_(row, entry.keyWidth)] = row; });

  var rows = readRecordsRaw_(sheet, width);
  var changed = 0;

  rows.forEach(function (have, i) {
    var want = wanted[seedKey_(have, entry.keyWidth)];
    if (!want) return;

    if (!seedRowDiffers_(have, want, entry.keyWidth, width)) return;

    // Only the columns after the key, so the row keeps its identity and its
    // position — this is an edit, not a delete and re-add.
    //
    // A column the seed leaves blank keeps whatever the sheet has. The seed
    // has no opinion about `alert_email` or `owner_email`; writing its blank
    // over yours would make "update the mappings" also mean "forget where to
    // send an alert and lock yourself out of the phone app", neither of which
    // was in the list you agreed to.
    var replacement = [];
    for (var c = entry.keyWidth; c < width; c++) {
      replacement.push(isBlankCell_(want[c]) ? have[c] : want[c]);
    }

    sheet.getRange(i + 2, entry.keyWidth + 1, 1, width - entry.keyWidth)
      .setValues([replacement]);
    changed++;
  });

  return changed;
}

/**
 * Mappings pointing at a category the taxonomy no longer has.
 *
 * Not the same as a divergence: these may be rows you invented, and they are
 * not fixed by applying defaults. They are worth naming because the failure
 * is silent — the override is written, and every report that groups by
 * category simply never shows it.
 */
function orphanedCategoryMappings_(ss) {
  var categories = ss.getSheetByName(TABS.CATEGORIES);
  var map = ss.getSheetByName(TABS.CATEGORY_MAP);
  if (!categories || !map) return [];

  var known = {};
  readRecords_(categories, CATEGORY_COLUMNS).forEach(function (row) {
    if (row.category) known[row.category + '\u0000' + row.subcategory] = true;
  });

  return readRecords_(map, CATEGORY_MAP_COLUMNS)
    .filter(function (row) { return row.source_category && row.category; })
    .filter(function (row) { return !known[row.category + '\u0000' + row.subcategory]; })
    .map(function (row) {
      return { source: row.source_category, target: row.category + ' / ' + row.subcategory };
    });
}

function describeSeedUpdate_(diverged, orphans) {
  var lines = [];

  if (diverged.length) {
    lines.push('Replace ' + diverged.length + ' row(s) with the current defaults:');
    diverged.slice(0, 8).forEach(function (d) {
      lines.push('  ' + d.key + ':  "' + d.yours + '"  ->  "' + d.standard + '"');
    });
    if (diverged.length > 8) lines.push('  …and ' + (diverged.length - 8) + ' more.');
  }

  if (orphans.length) {
    lines.push('');
    lines.push(orphans.length + ' mapping(s) point at a category that no longer exists.');
    lines.push('They are left alone — a report grouping by category will not show them:');
    orphans.slice(0, 5).forEach(function (o) {
      lines.push('  ' + o.source + ' -> ' + o.target);
    });
  }

  lines.push('');
  lines.push('Anything you invented, and any key not in the defaults, is untouched.');
  lines.push('');
  lines.push('Continue?');
  return lines.join('\n');
}
