/**
 * The page, assembled — the first check this project has that it runs.
 *
 * Every other guard on `src/page*.html` is a file test: that no string is
 * assigned as markup, that every name the page calls is a function that exists.
 * Those are worth having and none of them can tell you the document parses.
 * `node:vm` runs the `.gs` files and nothing inside an HTML file reaches it, so
 * for every phase up to now a stray brace in the page shipped, and presented as
 * a blank screen for the one person allowed to open it.
 *
 * Splitting the page across a dozen partials is what made that unaffordable.
 * Each one is a *fragment* of one closure rather than a file in its own right,
 * so an unbalanced brace is now a syntax error in a file that did not cause it
 * — which is a fine trade with this test and a bad one without it.
 *
 * `new Function` rather than a real evaluation: it compiles the whole body,
 * which is the question being asked, and runs none of it, which is the answer
 * nobody wants — the page reaches for `document` and `google.script.run` on the
 * first line of its boot. A browser is where the running happens, and
 * `npm run preview` is how you get one.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageSource, pageScript } from './page.mjs';
import { load } from './harness.mjs';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const shell = readFileSync(join(SRC, 'page.html'), 'utf8');

describe('the assembled page', () => {
  it('parses', () => {
    expect(() => new Function(pageScript())).not.toThrow();
  });

  it('resolves every scriptlet it carries', () => {
    // A leftover `<?` reaches the browser as text on the page, and Apps Script
    // would have thrown rather than shipped one — so a survivor here means the
    // resolver and the server disagree about the template language.
    expect(pageSource({ boot: 'null', view: 'null' })).not.toContain('<?');
  });

  it('is one closure, opened and closed by the shell', () => {
    // The partials are fragments and rely on it. A file that opened its own
    // would still parse and would quietly stop sharing `state`.
    expect(shell).toMatch(/<script>\s*\(function \(\) \{/);
    expect(shell).toMatch(/\}\)\(\);\s*<\/script>/);
  });

  it('includes every partial in src/, and nothing that is not there', () => {
    // The failure this catches is a rename: a partial left behind after a
    // split, still pushed by `clasp`, included by nothing and drifting.
    const included = [...shell.matchAll(/include_\(\s*'([\w.-]+)'\s*\)/g)].map((m) => m[1]);
    const present = readdirSync(SRC)
      .filter((f) => f.startsWith('page.') && f.endsWith('.html') && f !== 'page.html')
      .map((f) => f.slice(0, -'.html'.length));

    expect([...included].sort()).toEqual([...present].sort());
    expect(new Set(included).size, 'a partial is included twice').toBe(included.length);
  });

  it('holds no partial that opens a scriptlet of its own', () => {
    // Partials are served through `createHtmlOutputFromFile`, which does not
    // evaluate them — so a scriptlet in one is not a feature that fails, it is
    // a line of markup on the page.
    readdirSync(SRC)
      .filter((f) => f.startsWith('page.') && f !== 'page.html' && f.endsWith('.html'))
      .forEach((file) => {
        expect(readFileSync(join(SRC, file), 'utf8'), `${file} contains a scriptlet`)
          .not.toContain('<?');
      });
  });
});

describe('the server assembles it the same way', () => {
  /*
    Two resolvers now exist — `include_` in `20_webapp.gs` and `pageSource` in
    `tests/page.mjs` — and a test suite reading a document the server would not
    produce is worse than no test at all. So this asserts they agree, on the
    real thing rather than on a fixture: `webAppHtml_` runs the template through
    the harness's `HtmlService`, which calls the shipped `include_`.
  */
  it('serves a document with the whole application in it', () => {
    const c = load({ userEmail: 'owner@example.com' });
    c.setup();

    const served = c.webAppHtml_({}).getContent();

    expect(served).not.toContain('<?');
    expect(served).toContain('function renderDashboard');
    expect(served).toContain('function renderRecords');
    expect(served).toContain('function renderAnalytics');
    expect(served.length).toBeGreaterThan(150000);
  });

  it('throws rather than serving a shell when a partial is missing', () => {
    // Apps Script's own behaviour, and the one that matters: a page served with
    // an include silently dropped is a blank screen with a 200 behind it.
    const c = load({ userEmail: 'owner@example.com' });
    expect(() => c.include_('page.this-was-renamed')).toThrow(/was found in the script/);
  });
});
