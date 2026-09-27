# web — the Spendsheet viewer, off Apps Script

A static Solid app and one small Cloudflare Worker in front of three paths. The
Sheet stays the datastore; the Worker reads it with **your own** Google grant,
limited by `drive.file` to the one book. **Door 2 is untouched and is still the
app in daily use** until the cutover.

This is phase 2 of the plan: the thin slice that settles the unknowns only the
phone can answer. It signs in, connects the book, and measures a full read. It
draws no dashboard yet.

## Layout

| | |
|---|---|
| `worker/router.ts` | every route. Pure `(Request, Env, now) => Response`, no Cloudflare types, so it tests under plain Vitest. |
| `worker/session.ts` | three AES-GCM sealed cookies: the session (`sub`, email, refresh token; 400 days), the hour-long access token, and one sign-in round trip. Nothing is stored on the server. |
| `worker/oauth.ts` | sign-in by redirect, with PKCE, `drive.file` and offline access. |
| `worker/google-identity.ts` | verifying Google's ID token, and the `ALLOWED_ACCOUNTS` check by account ID. |
| `worker/connect.ts` | the Picker page — the only page that loads a Google script and the only response that carries a token. |
| `worker/index.ts` | the only file that knows it is on Cloudflare. |
| `wrangler.jsonc` | static assets from `dist/`; only `/api/*`, `/auth/*` and `/connect` reach the Worker. |
| `public/_headers` | the CSP for every static file, which the Worker never sees. |
| `src/sheets/records.ts` | Sheets API values → `readRecords_`-shaped records. Phase 3 builds on it. |
| `src/probe.ts` | the read-timing numbers the thin slice exists to take. |
| `src/api/client.ts` | asking the Worker something, and telling a refusal from a dropped connection from a book out of reach. |
| `src/app/` | the one screen. |
| `scripts/tools.sh` | is this machine ready. |

## Routes

| | who | what |
|---|---|---|
| `/`, `/assets/*` | anyone | static files. No code runs, no data. |
| `GET /api/health` | anyone | build, and which bindings exist. Nothing about the book. |
| `GET /auth/signin` · `/auth/callback` | anyone | the Google round trip. A session only for an account on `ALLOWED_ACCOUNTS`. |
| `POST /auth/signout` | this origin | clears both cookies. |
| `GET /connect` | signed in | the Picker. |
| `GET /api/me` | signed in | email and account ID. Never a token. |
| `GET /api/book` | signed in | the book's title and timezone — the proof the grant took. |
| `GET /api/read?tab=…` | signed in | one `values.batchGet` over a fixed list of tabs, handed back unread, with Google's time in `Server-Timing`. |

Every request other than GET must carry this origin in `Origin`, checked before
routing. A 401 means sign in; a 403 `no-access` means signed in but the grant
cannot see the book, and the page offers `/connect`.

## One-time setup

Documented rather than scripted, per the repo's governing rule. None of it
involves a multi-line key.

**Google Cloud**

1. Create a project. **Attach no billing account** — Google plans to bill
   Sheets API usage over quota later in 2026, and it cannot bill a project
   with no account.
2. Enable the **Google Sheets API** and the **Google Picker API**.
3. OAuth consent screen: External, scopes `openid`, `email` and
   `.../auth/drive.file`, then **Publish app → In production**. In Testing,
   Google expires the grant after seven days and the phone asks you to sign in
   every week. None of these scopes is sensitive, so there is no verification
   and no unverified-app warning.
4. Credentials → OAuth client, type *Web application*. Authorised redirect URI:
   `https://<your worker>.workers.dev/auth/callback`, plus
   `http://localhost:8787/auth/callback` for local development.
5. Credentials → API key. Restrict it to the website `https://<your worker>.workers.dev/*`
   and to the Picker API only.
6. Note the **project number** from the project dashboard. The Picker needs it,
   and without it no `drive.file` grant is recorded.

**Cloudflare**

1. `npx wrangler login`, and protect the Cloudflare account with a passkey or
   2FA: anyone who can deploy here can ship a Worker that captures your token.
2. `npm run deploy` once, to create the Worker and learn its address.
3. The secrets, one each with `npx wrangler secret put <NAME>`:

   | name | value |
   |---|---|
   | `GOOGLE_CLIENT_ID` | from step 4 |
   | `GOOGLE_CLIENT_SECRET` | from step 4 |
   | `SESSION_KEY` | `openssl rand -base64 32` |
   | `ALLOWED_ACCOUNTS` | leave for now — see below |
   | `SPREADSHEET_ID` | from the book's URL: `/spreadsheets/d/<this>/edit` |
   | `PICKER_API_KEY` | from step 5 |
   | `GOOGLE_PROJECT_NUMBER` | from step 6 |

   The API key and project number are not secrets, but the repository is
   public, so they are set the same way rather than committed.

**Laptop, once**

1. Open the Worker's address and sign in. You will be refused, and the page
   shows the command that admits you, with your **account ID** already in it.
   *Copy command*, run it here in `web/`, then sign in again. It sets the whole
   list, so a second account goes in as `'<first>,<second>'`.
2. *Choose the book* → Google's Picker lists one file → select it. The page
   says **Connected to Spendsheet ✓** when the Worker has read its title.

**Phone**

Open the address in Safari and sign in **there**, *then* Share → Add to Home
Screen. iOS 17.2+ copies Safari's cookies into the new icon at that moment and
never again, so the order matters.

## The device checks

Only the phone can answer these, from the Home Screen icon. Desktop WebKit was
the vantage point that misled the last storage conclusion. **If any fails, the
plan changes here**, before any screen is built.

| | expected |
|---|---|
| 1. Sign in in Safari, add to Home Screen, open the icon | already signed in. The screen says *Running as the Home Screen app*. |
| 1b. Sign out inside the icon, sign in from it | either works in place or needs the icon re-added. Both are acceptable (once a year); record which. |
| 2. Force-quit the icon from the app switcher, reopen | still signed in |
| 3. On the phone, without picking on the phone | *Connected to Spendsheet ✓* — the laptop's grant carries over. If not, the phone shows *Choose the book* once. |
| 4. *Measure reads* | five samples. *Copy results* and paste them into the PR. |

Also worth a look while there: CPU time per request on the Cloudflare dashboard
(Workers → spendsheet → Metrics), which should sit far below 10ms because reads
are never parsed.

## Running it locally

```sh
npm install
cp .dev.vars.example .dev.vars        # then fill it in
npm run build && npm run serve        # page and Worker together on :8787
```

`npm run dev` runs Vite on :4322 with the Worker's paths proxied to :8787, for
working on the page with hot reload.

## Tests

`npm test` **at the repository root** runs these alongside the `.gs` suites:
Vitest's default include is the whole repo. Check the file list rather than the
total after touching any config — a suite that stops being collected reports
green. `npm run typecheck` here for the compiler, which Vitest never asks.

Google is faked at `fetch` in `worker/router.test.ts`, with ID tokens signed by
a key the test generates, and every refusal asserts that **nothing reached
Google** first.

## The 10ms cap

A free-plan Worker gets 10ms of CPU per request. Waiting on `fetch` does not
count, only our own code. So `/api/read` hands Google's body back without
reading it, and the aggregation runs in the browser, where there is no cap. The
row counts and byte counts on the screen are measured by the page for the same
reason. Writes, in phase 5, will read one or two rows each for the same reason.
