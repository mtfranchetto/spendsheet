/**
 * preview.mjs — the app, in a browser, with no deployment behind it.
 *
 *     npm run preview                  # serves on http://localhost:4321
 *     npm run preview -- --port=5000
 *     npm run preview -- --out=/tmp/page.html   # write the file instead
 *
 * One self-contained document: the assembled page, the same inline boot payload
 * the server sends, and a fake `google.script.run` holding the answers the real
 * `21`–`23` produced for the book in `book.mjs`. No deployment, no bank, no
 * network — and **no second copy of the page**, which is the part that matters.
 * What loads here is byte-for-byte what Apps Script serves, resolved through
 * the same two scriptlets.
 *
 * This is what makes the page testable at all. `node:vm` runs the `.gs` files
 * and nothing inside an HTML file reaches it, so up to now the page's only
 * guards were file tests — that no string is assigned as markup, that every
 * name it calls exists. Neither can tell you the page *runs*. A browser pointed
 * at this can, and a browser is also the only thing that can answer the
 * questions this project keeps getting wrong: whether a control the phone
 * renders natively honours its width, whether a rule fires, whether a layout
 * overflows.
 *
 * **Served rather than written to a file by default**, because `file://` is
 * where the comparison stops being fair: automation tools block the scheme,
 * and the real page runs on an http origin inside an iframe. The server is
 * eleven lines of `node:http` and holds exactly one document.
 *
 * It rebuilds on every request, so editing the page and reloading is the whole
 * of the cycle — the book is built once, since it is the slow half and nothing
 * about it changes while you are working on the drawing.
 *
 * `?answers=` picks which set the fake hands back. The healthy book is the
 * default and the two others are the states nobody opens the preview to look
 * at and the page is still required to survive: a document served with no boot
 * payload, and a call the server has no answer for. Both are described in
 * `page.mjs` as cases the page must handle, and neither was reachable from a
 * browser while the server held exactly one document.
 */

import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { previewPage } from './page.mjs';
import { previewAnswers, previewBook } from './book.mjs';

const argument = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith('--' + name + '='));
  return found ? found.slice(name.length + 3) : fallback;
};

const book = previewBook();
const answers = previewAnswers(book);

/**
 * The view payload, built from *this* request's query string.
 *
 * In production `doGet` hands `e.parameters` to `webAppView_` and the page is
 * served already knowing which screen and filters were asked for. The captured
 * answer above is built once from no parameters at all, so every document this
 * server produced said "dashboard, defaults" however the URL was written — and
 * a deep link, which is the whole of `webAppView_`, was the one feature of the
 * page a browser could not be pointed at.
 *
 * Multi-valued, because `webAppView_` takes `e.parameters` rather than
 * `e.parameter`: the account filter is a set, and `?a=Cash&a=Revolut` has to
 * arrive as two values rather than as the last one.
 */
function viewFor(url) {
  const parameters = {};
  for (const key of url.searchParams.keys()) parameters[key] = url.searchParams.getAll(key);
  return JSON.stringify(book.webAppView_(parameters));
}

/**
 * The three answer sets, derived from the one book rather than written out.
 *
 * `cold` drops the view payload the document is normally served with, so the
 * page has to fall back to its own defaults — what a browser gets when
 * `webAppView_` could not be built, and the state a deep link has to survive.
 * The *other* cold start, an empty cache, needs no answer set at all: a browser
 * context begins with empty storage, so it is what every run gets by default
 * and what a test has to seed its way out of.
 *
 * `broken` withholds the answer to the call that draws the lower half of the
 * first screen, which is how a missing or renamed entry point presents: not an
 * error page, a screen that has to say so.
 */
const SETS = {
  full: () => answers,
  cold: () => ({ ...answers, __view: undefined }),
  broken: () => {
    const table = { ...answers };
    delete table.appOverview;
    return table;
  },

  /*
    The owner gate saying no.

    `appOpen` is the call that carries the verdict, so withholding it is what a
    refusal looks like from inside the page — `withFailureHandler` with a
    message, exactly as a renamed entry point or a wrong Google account
    presents. It is the state a *stored* screen has to be overruled by: whatever
    is on the phone belongs to whoever was signed in when it was written, and
    the one thing that must not happen is those balances staying up.
  */
  refused: () => {
    const table = { ...answers };
    delete table.appOpen;
    return table;
  }
};

const out = argument('out', '');

if (out) {
  writeFileSync(out, previewPage(SETS[argument('answers', 'full')]()), 'utf8');
  process.stdout.write(out + '\n');
} else {
  const port = Number(argument('port', 4321));

  createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');

    // Answered rather than 404'd, because a browser asks for it unprompted and
    // the miss lands in the console as an error — where `tests/e2e` asserts
    // there are none, and a favicon is not the kind it is looking for.
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }

    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      response.writeHead(404).end('Only / is served here.');
      return;
    }

    const set = SETS[url.searchParams.get('answers') || 'full'];
    if (!set) {
      response.writeHead(404).end('No such answer set. One of: ' + Object.keys(SETS).join(', '));
      return;
    }

    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });

    // `cold` withholds the view and must go on withholding it, so this replaces
    // the payload rather than supplying one: a set that has no `__view` keeps
    // none, and every other set gets this request's.
    const table = set();
    response.end(previewPage(
      table.__view === undefined ? table : { ...table, __view: viewFor(url) }
    ));
  }).listen(port, () => {
    process.stdout.write('http://localhost:' + port + '\n');
    if (process.argv.includes('--open')) execFileSync('open', ['http://localhost:' + port]);
  });
}
