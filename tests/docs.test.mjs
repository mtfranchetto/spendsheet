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

describe('the counts the docs quote', () => {
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
