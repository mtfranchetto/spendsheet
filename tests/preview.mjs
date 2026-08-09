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
 */

import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { previewPage } from './page.mjs';
import { previewAnswers } from './book.mjs';

const argument = (name, fallback) => {
  const found = process.argv.find((a) => a.startsWith('--' + name + '='));
  return found ? found.slice(name.length + 3) : fallback;
};

const answers = previewAnswers();
const out = argument('out', '');

if (out) {
  writeFileSync(out, previewPage(answers), 'utf8');
  process.stdout.write(out + '\n');
} else {
  const port = Number(argument('port', 4321));

  createServer((request, response) => {
    if (request.url !== '/' && request.url !== '/index.html') {
      response.writeHead(404).end('Only / is served here.');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    response.end(previewPage(answers));
  }).listen(port, () => {
    process.stdout.write('http://localhost:' + port + '\n');
    if (process.argv.includes('--open')) execFileSync('open', ['http://localhost:' + port]);
  });
}
