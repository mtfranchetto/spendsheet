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

/** `<?!= view ?>` — a bare name, which is the only other scriptlet shape here. */
const VARIABLE = /<\?!?=\s*([A-Za-z_$][\w$]*)\s*\?>/g;

/**
 * The document `webAppHtml_` would build, as a string.
 *
 * `values` fills the bare scriptlets — `{view}` — and anything absent becomes
 * `null`, which is what the server itself sends when it could not build the
 * payload, and a case the page is required to survive.
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
 * **A write moves the table the reads come out of.** The answers are captured
 * one call each, all of them before any of them, so `appDashboard` answers with
 * the book as it stood at build time however many rows the page has confirmed
 * since. That is the one way the fake can contradict the server rather than
 * merely simplify it: the real `appConfirm` bumps the data version, so the very
 * next read is taken after the write and the row is gone from the queue. Left
 * alone it makes a page that correctly clears a row look broken, because the
 * refetch hands the row straight back — which is a fixture disagreeing with
 * itself, and the kind of red that gets a working change reverted.
 *
 * `latency` is not decoration. Every ordering bug this page has had came from
 * two requests in flight at once — a late answer overwriting a newer one, a
 * page appended to a different query — and a fake that resolves synchronously
 * cannot produce one. The default is small enough to keep a run quick and large
 * enough that promises actually interleave. It is the *starting* value:
 * `window.__latency` is live, so a test can slow one call down and speed the
 * next one up, which is the only way to make a stale answer arrive last.
 */
export function previewPage(answers, options = {}) {
  const latency = options.latency === undefined ? 60 : options.latency;
  const view = answers.__view === undefined ? 'null' : answers.__view;

  const table = { ...answers };
  delete table.__view;

  return viewportTag() + '\n' +
    pageSource({ view }).replace('<script>', shim(table, latency) + '\n<script>');
}

/**
 * The viewport tag, read out of the server that sends it.
 *
 * `page.html` is a fragment: `HtmlService` wraps it and `webAppHtml_` hangs the
 * meta tag on the wrapper with `addMetaTag`, because Apps Script strips one
 * written into the file. Nothing here calls `HtmlService`, so a document served
 * from `pageSource` alone has no viewport tag — and a browser without one lays
 * the page out at the 980px width it assumes a desktop site wants and then
 * scales the result down. **A phone-shaped window is not a phone-shaped
 * layout**: every media query, every percentage and every `vw` in `page.css`
 * resolves against 980, so the preview would render a wide layout shrunk to fit
 * and every measurement taken from it would be of a page nobody sees.
 *
 * Matched out of `20_webapp.gs` rather than written out here, so the preview
 * cannot lay out at a width the deployment does not use. A copy of this string
 * would be the same class of bug it exists to prevent, and quieter.
 */
function viewportTag() {
  const server = readFileSync(join(SRC, '20_webapp.gs'), 'utf8');
  const found = /addMetaTag\(\s*'viewport'\s*,\s*'([^']+)'\s*\)/.exec(server);
  if (!found) throw new Error('20_webapp.gs adds no viewport meta tag — has it moved?');
  return '<meta name="viewport" content="' + found[1] + '">';
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

// The same names again, pushed when the answer reaches the page rather than
// when the call left it. A test waiting on what a refetch *did* has to wait on
// this one: a name is in __calls the instant the request is made, so polling
// that for a reload asserts the screen before it could possibly have changed,
// and passes against a page that never applied the answer at all.
window.__answered = [];
window.__answers = ${data};
window.__latency = ${latency};
window.google = { script: { run: (function () {
  var handlers = {};

  // The confirmed rows leave every queue the table hands back, addressed by the
  // uids the page actually sent rather than by the canned result: the answer to
  // appConfirm is one captured result and says nothing about which row this was.
  // A test that has replaced an answer wholesale keeps whatever it set — this
  // filters what is there and adds nothing.
  //
  // No backtick anywhere below, in a comment or otherwise. This whole block is
  // inside the template literal that builds the tag, so one would end the string
  // here and leave the rest of the file being parsed as code.
  var applyConfirm = function (decisions) {
    var uids = (decisions || []).map(function (decision) { return String(decision.uid); });
    ['appDashboard', 'appOverview'].forEach(function (name) {
      var answer = window.__answers[name];
      if (!answer || !answer.review) return;
      answer.review = answer.review.filter(function (row) {
        return uids.indexOf(String(row.uid)) === -1;
      });
    });

    // And the answer itself says which rows it was about.
    //
    // The captured one is a single result naming the single row the fixture
    // confirmed when it was built, whatever the page has just sent. The real
    // applyReviewDecisions_ reports one result per decision and carries the uid
    // on each, because that is the whole of the addressing on both sides — a
    // page that matched them up by position would apply one row's refusal to
    // its neighbour. A fake that answers for a row nobody asked about cannot be
    // matched at all, and is the fixture disagreeing with the server rather
    // than simplifying it.
    //
    // No record on the result. The server hands back the row as the sheet now
    // describes it and there is no sheet here, so the honest answer is silence
    // — the page keeps its own optimistic patch, which is what it does in
    // production for every field the server did not correct.
    var confirmed = window.__answers.appConfirm;
    if (!confirmed) return;

    confirmed.results = uids.map(function (uid) {
      return { uid: uid, ok: true, wrote: ['confirmed'], refused: [] };
    });
    confirmed.written = uids.length;
    confirmed.skipped = 0;
  };

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
        if (name === 'appConfirm') applyConfirm(args[0]);

        // Both of these are read *now* rather than when the timer fires, and
        // that is what lets a test arrange an overtaking pair: set a long
        // latency and an answer, call, then set a short one and a different
        // answer and call again. Reading either at resolve time would give
        // both calls the same answer at whichever delay was set last, which is
        // the one arrangement in which an ordering bug cannot happen.
        var known = Object.prototype.hasOwnProperty.call(window.__answers, name);
        var answer = known ? JSON.stringify(window.__answers[name]) : null;
        var wait = typeof window.__latency === 'number' ? window.__latency : ${latency};

        setTimeout(function () {
          if (!known) return fail && fail(new Error('no canned answer for ' + name));
          ok && ok(JSON.parse(answer));
          window.__answered.push(name);
        }, wait);
      };
    }
  });
  return api;
})() } };
</script>`;
}
