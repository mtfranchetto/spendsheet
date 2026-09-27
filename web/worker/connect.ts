/**
 * connect.ts — the one page that loads a Google script, and the one response
 * that carries an access token.
 *
 * `drive.file` reaches only the files you open with this app, and "open" means
 * picking the book in Google's own Picker. So this page exists to be seen about
 * once: on the laptop at setup, and again only if Google stops letting the
 * viewer read the book.
 *
 * ## Why it is walled off from every other page
 *
 * The Picker needs an access token in page JavaScript (`setOAuthToken`), and a
 * `drive.file` token can rewrite `transactions` A–O or share the book with
 * anyone, bypassing every named action the Worker will ever enforce. So:
 *
 *   - **No other route returns a token.** `/api/me` says who you are and stops.
 *   - **This page shows no data**, so there is nothing on it worth stealing
 *     *except* the token, and the CSP below is what guards that.
 *   - **Its CSP names exact hosts and a per-response nonce.** The only inline
 *     script is ours; everything else must come from `apis.google.com`, which
 *     is where the Picker loader lives. It is served by the Worker rather than
 *     as a static file for exactly this reason: static files skip the Worker,
 *     so a per-response policy could never reach them.
 *   - **Never cached, never framed.**
 *
 * `setAppId` takes the Cloud project number, and without it the Picker records
 * no `drive.file` grant at all — the pick looks successful and the book stays
 * unreadable. `setFileIds` narrows the list to the book, so the one screen you
 * see holds one file.
 */

import { randomToken } from './session';

type ConnectEnv = {
  PICKER_API_KEY?: string;
  GOOGLE_PROJECT_NUMBER?: string;
  SPREADSHEET_ID?: string;
};

/**
 * JSON safe to sit inside a `<script>` element. Every `<` escaped, so no value
 * can close the element early — the same rule as `htmlSafeJson_` in the old
 * viewer, for the same reason: a narrow filter on the dangerous sequence is the
 * one that misses.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function connectPolicy(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://apis.google.com`,
    'frame-src https://docs.google.com https://drive.google.com',
    'connect-src https://apis.google.com https://content.googleapis.com',
    // The Picker styles itself inline and draws Google's own icons.
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    'img-src https://*.gstatic.com https://*.googleusercontent.com data:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'"
  ].join('; ');
}

export function connectPage(env: ConnectEnv, token: string, cookies: string[]): Response {
  const nonce = randomToken(18);
  const config = scriptSafeJson({
    token,
    apiKey: env.PICKER_API_KEY ?? '',
    appId: env.GOOGLE_PROJECT_NUMBER ?? '',
    fileId: env.SPREADSHEET_ID ?? ''
  });

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Connect your book</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; margin: 0; padding: 24px 16px; }
  main { max-width: 32rem; margin: 0 auto; }
  button { font: inherit; font-weight: 600; min-height: 44px; padding: 10px 16px; border-radius: 8px; border: 0; background: #0c6b5b; color: #fff; cursor: pointer; transition: filter 120ms ease; }
  @media (hover: hover) { button:hover:not(:disabled) { filter: brightness(1.15); } }
  button:active:not(:disabled) { filter: brightness(0.9); }
  button:focus-visible { outline: 2px solid #0c6b5b; outline-offset: 2px; }
  button:disabled { cursor: progress; opacity: 0.5; }
  @media (prefers-color-scheme: dark) { body { background: #111417; color: #e3eae6; } }
</style>
</head>
<body>
<main>
  <h1>One more step</h1>
  <p>Give the viewer access to your Spendsheet book. Google lists only that one file.</p>
  <p><button id="choose" type="button" disabled>Choose the book</button></p>
  <p id="status"></p>
</main>
<script nonce="${nonce}">
  var CONNECT = ${config};
  function say(text) { document.getElementById('status').textContent = text; }
  function open() {
    var view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
      .setFileIds(CONNECT.fileId)
      .setMode(google.picker.DocsViewMode.LIST);
    new google.picker.PickerBuilder()
      .setAppId(CONNECT.appId)
      .setDeveloperKey(CONNECT.apiKey)
      .setOAuthToken(CONNECT.token)
      .addView(view)
      .setCallback(function (data) {
        if (data.action === google.picker.Action.PICKED) window.location.replace('/?connected=1');
        if (data.action === google.picker.Action.CANCEL) say('Nothing was chosen. The viewer cannot read the book until it is.');
      })
      .build()
      .setVisible(true);
  }
  // Loaded from here rather than by a tag with an onload attribute: an inline
  // event handler is exactly what this page's CSP refuses.
  var loader = document.createElement('script');
  loader.src = 'https://apis.google.com/js/api.js';
  loader.onload = function () {
    gapi.load('picker', function () {
      var button = document.getElementById('choose');
      button.disabled = false;
      button.addEventListener('click', open);
    });
  };
  loader.onerror = function () { say('Google\\'s Picker did not load. Reload to try again.'); };
  document.head.appendChild(loader);
</script>
</body>
</html>`;

  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': connectPolicy(nonce),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    // **The origin, and not `no-referrer` like every other response.** The
    // Picker's API key is restricted by website, and Google checks that
    // restriction against the Referer — with none, it answers "The API
    // developer key is invalid", which reads as a wrong key rather than a
    // header. `strict-origin` sends the origin alone, never the path, and
    // nothing over plain HTTP; the token is in the body, not the URL. The
    // key also has to allow `docs.google.com`, whose frame makes some of the
    // Picker's own requests — the README's setup says so.
    'referrer-policy': 'strict-origin'
  });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(html, { status: 200, headers });
}
