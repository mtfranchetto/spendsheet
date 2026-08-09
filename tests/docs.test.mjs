/**
 * What the docs promise, against what the code does.
 *
 * A doc cannot be unit tested and mostly should not be — it is prose, and prose
 * that agrees with the code at the level of an argument is not something a test
 * can check. What a test *can* check is the handful of places where a doc states
 * a fact the code owns, and where being wrong is not a matter of taste:
 *
 *   - **A menu path.** "Spendsheet → Setup sheet" was correct until the menu
 *     grew submenus, at which point eight documents were telling you to click
 *     something that is no longer there. That is the kind of wrong that makes a
 *     reader distrust the rest of the page.
 *   - **A count.** "It builds 19 tabs" was written when there were 19.
 *
 * Both drift silently and neither shows up in a run of the code, which is what
 * makes them worth pinning here rather than re-reading every few months.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

const pages = readdirSync(DOCS).filter((f) => f.endsWith('.md'))
  .map((f) => ['docs/' + f, readFileSync(join(DOCS, f), 'utf8')])
  .concat([['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')]]);

const ctx = load();

/** Every menu entry, as `name` → the submenu holding it, or '' for top level. */
const WHERE = (() => {
  const map = new Map();
  ctx.MENU_ITEMS.filter((i) => !i.separator).forEach((i) => map.set(i.name, ''));
  ctx.MENU_GROUPS.forEach((g) => g.items.filter((i) => !i.separator)
    .forEach((i) => map.set(i.name, g.title)));
  return map;
})();

describe('the menu paths the docs tell you to click', () => {
  /*
    Matched on the arrow rather than on the item names, so this tests what a
    reader would actually follow: a full path starting at the menu title.

    A bare mention — "*Import staged rows* only commits what you have already
    reviewed" — is prose naming a feature and is deliberately not caught. The
    thing worth catching is an instruction with a route in it that no longer
    goes anywhere.
  */
  const paths = [];
  pages.forEach(([file, text]) => {
    const re = /Spendsheet → ((?:\*\*)?[^*\n|.]+?)(?:\*\*)?(?=[.,:—\n]|$)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      paths.push({ file, raw: m[1].replace(/\*\*/g, '').trim() });
    }
  });

  it('finds some to check, or this file is asleep', () => {
    expect(paths.length).toBeGreaterThan(15);
  });

  it('names a real menu item at the end of every one', () => {
    paths.forEach(({ file, raw }) => {
      const leaf = raw.split('→').pop().trim();
      expect(WHERE.has(leaf), `${file}: "${raw}" ends in "${leaf}", which is not a menu item`)
        .toBe(true);
    });
  });

  it('routes each one through the submenu that actually holds it', () => {
    paths.forEach(({ file, raw }) => {
      const parts = raw.split('→').map((p) => p.trim());
      const leaf = parts.pop();
      if (!WHERE.has(leaf)) return;                 // reported by the test above

      const group = WHERE.get(leaf);
      const written = parts.join(' → ');
      expect(written, `${file}: "Spendsheet → ${raw}" — ${leaf} lives ` +
        (group ? `under "${group}"` : 'at the top level')).toBe(group);
    });
  });
});

/**
 * A file header is documentation, and this one had drifted the same way.
 *
 * `22_actions.gs` opened with "the three things the app writes" while holding
 * four, and CLAUDE.md's table said two — so an agent asked to add a fifth read
 * two numbers, found neither, and had to reconcile both against the code before
 * it could start. That is precisely the cost those documents exist to remove.
 *
 * Pinned to a count rather than to a list of names, because the point is that
 * a writer was *added* and the prose was not touched — which is what a count
 * catches and a spelling check does not.
 */
describe('the file headers that say how many of something there is', () => {
  const NUMBER = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };

  it('counts the writers in 22_actions.gs the way its own header does', () => {
    const source = readFileSync(join(ROOT, 'src', '22_actions.gs'), 'utf8');

    // A writer is an entry point the app can reach that changes the book. Both
    // shapes are here already: the review batch, and the three `webApp*_`.
    const writers = [...source.matchAll(/^function (webApp[A-Za-z]+_|applyReviewDecisions_)\(/gm)];
    const claimed = source.match(/^ \* 22_actions\.gs — the (\w+) things the app writes/m);

    expect(claimed, '22_actions.gs no longer opens with a count').not.toBeNull();
    expect(NUMBER[claimed[1]], `the header says "${claimed[1]}"`).toBe(writers.length);
  });

  it('says the same number in the CLAUDE.md file table', () => {
    const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
    const row = claude.match(/22_actions\.gs.*?the (\w+) things the app writes/);

    expect(row, 'CLAUDE.md no longer describes 22_actions.gs with a count').not.toBeNull();

    const source = readFileSync(join(ROOT, 'src', '22_actions.gs'), 'utf8');
    const writers = [...source.matchAll(/^function (webApp[A-Za-z]+_|applyReviewDecisions_)\(/gm)];
    expect(NUMBER[row[1]], `CLAUDE.md says "${row[1]}"`).toBe(writers.length);
  });
});

/**
 * A doc that tells you what to type into a cell is quoting an enum.
 *
 * `CATEGORIES.md` lists what `field` and `match_type` accept, and what the three
 * `kind` values are, because a reader adding a rule or a category needs the list
 * in front of them rather than a pointer to `00_config.gs`. Copying it out is
 * the right call and it is also the thing that goes stale: adding a fifth match
 * type would leave the page confidently naming four, and the failure — a rule
 * that matches nothing, for ever — is exactly the one that page warns about.
 *
 * One direction only. That a member is named somewhere on the page is checkable;
 * that the page names no *retired* member would need the prose parsed rather
 * than searched, and a mention in a sentence about history is legitimate.
 */
describe('the enums the docs spell out', () => {
  const categories = pages.find(([file]) => file === 'docs/CATEGORIES.md')[1];

  it('names every rule field and match type a rule can use', () => {
    ctx.RULE_FIELDS.concat(ctx.RULE_MATCH_TYPES).forEach((value) => {
      expect(categories.includes('`' + value + '`'),
        `CATEGORIES.md never mentions \`${value}\``).toBe(true);
    });
  });

  it('names all three kinds a category can be', () => {
    ctx.TX_TYPES.forEach((value) => {
      expect(categories.includes('`' + value + '`'),
        `CATEGORIES.md never mentions \`${value}\``).toBe(true);
    });
  });
});

describe('the counts the docs quote', () => {
  it('counts the seeded labels the way CATEGORIES.md does', () => {
    const NUMBER = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const categories = pages.find(([file]) => file === 'docs/CATEGORIES.md')[1];
    const claim = categories.match(/The (\w+) seeded labels are examples/);

    expect(claim, 'CATEGORIES.md no longer counts the seeded labels').not.toBeNull();
    expect(NUMBER[claim[1]], `it says "${claim[1]}"`).toBe(ctx.DEFAULT_LABELS.length);
  });

  it('says the number of tabs setup actually builds', () => {
    const fresh = load({ userEmail: 'owner@example.com' });
    fresh.setup();
    const built = fresh.__spreadsheet.getSheets().length;

    pages.forEach(([file, text]) => {
      const claims = [...text.matchAll(/builds (\d+) tabs/g)].map((m) => Number(m[1]));
      claims.forEach((n) => expect(n, `${file} says ${n} tabs`).toBe(built));
    });
  });
});
