/**
 * page.mjs — assemble the served document the way Apps Script would.
 *
 * `src/page.html` is a *template*: `webAppHtml_` runs it through
 * `HtmlService.createTemplateFromFile`, which resolves two kinds of scriptlet —
 * the `boot` and `view` payloads, and `include_('page.x')` for each partial the
 * page is split across. None of that happens in a file test, which is why
 * `page.html` has been described here as the one file the harness cannot load.
 *
 * It can load it. What it could not do is *evaluate* it, and that is a
 * templating problem rather than a JavaScript one: resolve the scriptlets the
 * same way the server does and the result is the exact document a browser
 * receives. This module is that resolver, and it exists for two callers.
 *
 *   **File tests**, which assert on the page's contents and must see every
 *   partial rather than only the shell — `pageSource()`.
 *
 *   **A browser**, which is the only thing that can prove the page runs at all.
 *   `previewPage()` produces a standalone document with a fake
 *   `google.script.run` behind it, so the app can be opened, tapped and
 *   screenshotted with no deployment and no bank. See `tests/preview.mjs`.
 *
 * The mock data is **not written by hand.** It comes from running the real
 * `21`–`23` against the in-memory book the rest of the suite uses, so what the
 * page is handed here is what `recordForPage_` actually produces, field for
 * field. A hand-written fixture would drift from the server the first time a
 * column was added, and would do it silently — the page would go on drawing
 * whatever the fixture said.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** `<?!= include_('page.core') ?>`, in both quote styles and any spacing. */
const INCLUDE = /<\?!?=\s*include_\(\s*['"]([\w.-]+)['"]\s*\)\s*;?\s*\?>/g;

/** `<?!= boot ?>` — a bare name, which is the only other scriptlet shape here. */
const VARIABLE = /<\?!?=\s*([A-Za-z_$][\w$]*)\s*\?>/g;

/**
 * The document `webAppHtml_` would build, as a string.
 *
 * `values` fills the bare scriptlets — `{boot, view}` — and anything absent
 * becomes `null`, which is what the server itself sends when it could not build
 * the payload, and a case the page is required to survive.
 *
 * Includes resolve recursively, so a partial may include another. Depth is
 * bounded rather than trusted: a file including itself is a stack overflow with
 * a stack that says nothing about which file did it.
 */
export function pageSource(values = {}, depth = 0) {
  if (depth > 10) throw new Error('include_ nested more than ten deep — a cycle?');

  return readFileSync(join(SRC, 'page.html'), 'utf8')
    .replace(INCLUDE, (whole, name) => partial(name, depth))
    .replace(VARIABLE, (whole, name) =>
      Object.prototype.hasOwnProperty.call(values, name)
        ? String(values[name]) : 'null');
}

function partial(name, depth) {
  const path = join(SRC, name + '.html');
  if (!existsSync(path)) throw new Error('page.html includes ' + name + ', which is not in src/');

  return readFileSync(path, 'utf8').replace(INCLUDE, (whole, inner) => {
    if (depth > 10) throw new Error('include_ nested more than ten deep — a cycle?');
    return partial(inner, depth + 1);
  });
}

/** Everything inside the page's own `<script>` block, with no tags around it. */
export function pageScript(values = {}) {
  const blocks = [...pageSource(values).matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (!blocks.length) throw new Error('no <script> block in the assembled page');

  return blocks.map((block) => block[1]).join('\n');
}

// ---------------------------------------------------------------------------
// A document a browser can open
// ---------------------------------------------------------------------------

/**
 * The same page, with the server replaced by a table of canned answers.
 *
 * `google.script.run` is a builder — `.withSuccessHandler(f)` returns itself and
 * the call happens on the named method — so the fake is a Proxy over the same
 * shape rather than a list of methods to keep in step with `23_api.gs`. A page
 * calling something the table has no answer for fails *through the page's own
 * failure handler*, which is the behaviour worth reproducing: that is how a
 * missing entry point presents in production.
 *
 * `latency` is not decoration. Every ordering bug this page has had came from
 * two requests in flight at once — a late answer overwriting a newer one, a
 * page appended to a different query — and a fake that resolves synchronously
 * cannot produce one. The default is small enough to keep a run quick and large
 * enough that promises actually interleave.
 */
export function previewPage(answers, options = {}) {
  const latency = options.latency === undefined ? 60 : options.latency;
  const boot = answers.__boot === undefined ? 'null' : answers.__boot;
  const view = answers.__view === undefined ? 'null' : answers.__view;

  const table = { ...answers };
  delete table.__boot;
  delete table.__view;

  return pageSource({ boot, view }).replace('<script>', shim(table, latency) + '\n<script>');
}

/**
 * The fake, as a script tag to put in front of the page's own.
 *
 * Serialised through `JSON.stringify` into a `<script>`, so `</script>` inside
 * a description would close the element early — the same escape the server
 * applies with `htmlSafeJson_`, for the same reason, against data that came
 * from a bank either way.
 */
function shim(table, latency) {
  const data = JSON.stringify(table).replace(/</g, '\\u003c');

  return `<script>
window.__calls = [];
window.__answers = ${data};
window.google = { script: { run: (function () {
  var handlers = {};
  var api = new Proxy({}, {
    get: function (target, name) {
      if (name === 'withSuccessHandler') {
        return function (fn) { handlers.ok = fn; return api; };
      }
      if (name === 'withFailureHandler') {
        return function (fn) { handlers.fail = fn; return api; };
      }
      if (typeof name !== 'string') return undefined;

      return function () {
        var args = Array.prototype.slice.call(arguments);
        var ok = handlers.ok;
        var fail = handlers.fail;
        handlers = {};
        window.__calls.push({ name: name, args: args });

        setTimeout(function () {
          if (!Object.prototype.hasOwnProperty.call(window.__answers, name)) {
            return fail && fail(new Error('no canned answer for ' + name));
          }
          ok && ok(JSON.parse(JSON.stringify(window.__answers[name])));
        }, ${latency});
      };
    }
  });
  return api;
})() } };
</script>`;
}
