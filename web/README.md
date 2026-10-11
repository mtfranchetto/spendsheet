# web — the Spendsheet viewer

A static Solid app and one small Cloudflare Worker in front of three paths. The
Sheet stays the datastore; the Worker reads it with **your own** Google grant,
limited by `drive.file` to the one book.

It signs in, connects the book, reads the whole of it in one call, and draws
three screens — Home, Records and Charts — from that read, on the phone. Five
named writes go back through the Worker: confirming and categorising, marking a
transfer, a rule, cash and asset values, and deleting cash you typed.

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
| `src/sheets/records.ts` | Sheets API values → `readRecords_`-shaped records: padded rows, counted by the key column. |
| `src/domain/` | the book, asked a question, on the phone: aggregation, `runChecks_` and `normalizeMerchant` in TypeScript, over day numbers and the book's clock. Framework-free. `payloads.ts` answers in the shapes of the Apps Script viewer's five calls, which `tests/parity.test.mjs` holds it to. `longview.ts` answers Charts' Long view: the last 12 months, the 12 before them and the whole ledger, with its windows decided in its header. |
| `src/store/copy.ts` | the last `batchGet`, in IndexedDB, for the account that read it. |
| `public/sw.js` | the shell from this device's cache, before the network is asked anything. Never `/api`, `/auth` or `/connect`. |
| `src/api/client.ts` | asking the Worker something, and telling a refusal from a dropped connection from a book out of reach. |
| `src/app/state.ts` | who is signed in, the book on screen, and every screen as a memo over it. Draws the stored copy, reads anyway, and forgets on sign-out or refusal — with a latch so a read in flight cannot undo the forget. |
| `src/app/view.ts` | the screen and its filters as a URL and back. |
| `src/app/*.tsx` | the screens, charts, rows and filter bar. Text only through bindings. |
| `src/app/format.ts`, `geometry.ts` | money and dates as printed, and the arithmetic under the charts. Pure, and tested. |
| `src/app/pull.ts` | pull to refresh. |
| `worker/actions.ts` | the five writes — confirm, transfer, rule, cash, delete — each with its checks re-asked of the row as Google holds it. RAW at explicit addresses; the rows touched read back. |
| `src/api/contract.ts` | the write shapes, shared by page and Worker, and the version a stale page is reloaded over. |
| `src/domain/transfer.ts` | which row on another bank is the other half of a move; the page finds it, the Worker checks it. |
| `src/app/writes.ts` | the writes from the page: one lane, rows named when a write leaves, swipes batched, the guess laid over the book until the answer lands. |
| `src/app/Sheet.tsx`, `Add.tsx`, `swipe.ts`, `amount.ts` | a row's details, a rule, the cash and revalue forms, the swipe and hold, and amounts in the phone's separators. |
| `scripts/tools.sh` | is this machine ready. |

## Routes

| | who | what |
|---|---|---|
| `/`, `/assets/*` | anyone | static files. No code runs, no data. |
| `GET /api/health` | anyone | build, and which bindings exist. Nothing about the book. |
| `GET /auth/signin` · `/auth/callback` | anyone | the Google round trip. A session only for an account on `ALLOWED_ACCOUNTS`. |
| `POST /auth/signout` | this origin | clears both cookies. |
| `GET /auth/refused` | the refused browser | who that browser was just refused as, from its own sealed ten-minute cookie. Never from the URL. |
| `GET /connect` | signed in | the Picker. |
| `GET /api/me` | signed in | email and account ID. Never a token. |
| `GET /api/book` | signed in | the book's title and timezone — the proof the grant took. |
| `GET /api/read?tab=…` | signed in | one `values.batchGet` over a fixed list of tabs, handed back unread, with Google's time in `Server-Timing`. |
| `POST /api/act/<decide\|transfer\|rule\|cash\|delete>` | signed in, this origin, this contract | one named write. Another contract version is a 409 and the page reloads; a refusal about the request is a 422 with its sentence. |

Every request other than GET must carry this origin in `Origin`, checked before
routing. A 401 means sign in; a 403 `no-access` means signed in but the grant
cannot see the book, and the page offers `/connect`.

## One-time setup

Four commands and a console visit. `scripts/setup.mjs` says where each
secret comes from.

**1. Create the Worker** (to learn its address)

```sh
npm install            # here in web/, and at the repository root: the deploy
                       # runs the root's tests before it builds anything
npx wrangler login     # protect the Cloudflare account with 2FA or a passkey:
                       # anyone who can deploy here can capture your token
npm run deploy         # prints https://spendsheet.<you>.workers.dev
```

The deploy's last step admits you: it asks Google which account `clasp` is
signed in as (the one that owns the book) and puts that account ID on
`ALLOWED_ACCOUNTS`. It prints who it admitted — sign in as that account.

**2. Google Cloud console** (Google has no API for this part)

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
   `http://localhost:8787/auth/callback` for local development. **Download
   JSON** on the dialog that follows.
5. Credentials → API key. Restrict it to the Picker API only, and to two
   websites: `https://<your worker>.workers.dev/*` **and** `https://docs.google.com/*`.
   The Picker runs in a `docs.google.com` frame and some of its requests are
   checked against that address; with only the Worker's, Google answers "The
   API developer key is invalid". Copy it.

**3. Every secret at once**

```sh
npm run setup -- ~/Downloads/client_secret_<...>.json
```

It asks for the API key and nothing else. The client ID and secret come from
the file, the project number from the client ID, the spreadsheet from the
Apps Script project `.clasp.json` names, and `SESSION_KEY` is generated —
unless the Worker already has one, because replacing it signs every device out.
It checks everything before writing anything. Then `/api/health` should say
`true` for every entry under `configured`.

**4. Laptop, once**

*Choose the book* → Google's Picker lists one file → select it. The page says
**Connected to Spendsheet ✓** when the Worker has read its title.

**Phone**

Open the address in Safari and sign in **there**, *then* Share → Add to Home
Screen. iOS 17.2+ copies Safari's cookies into the new icon at that moment and
never again, so the order matters.

## Sharing, and who is on the list

```sh
npm run accounts -- list
npm run accounts -- add <account id> [email]
npm run accounts -- remove <account id>
```

Someone you share with signs in and is refused; the refusal screen shows
them the exact `add` line to send you, with their account ID and address in
it. Run it here and they sign in again. Sharing the viewer is not sharing the
book: they choose it in their own Picker, so it has to be shared with them in
Drive too — `drive.file` is the second lock.

The list lives in `web/.accounts.json` (gitignored) because a Worker secret
cannot be read back, and `wrangler secret put` replaces the whole value. Every
change pushes the full list, so adding someone never drops anyone. Removing
someone ends their session on their next request.

## The device checks

Only the phone can answer these, from the Home Screen icon. Desktop WebKit was
the vantage point that misled the last storage conclusion.

**The screens**:

| | expected |
|---|---|
| Charts, a period against the `reports` tab over the same period | the same totals — two implementations that agree |
| Charts → Long view, *Annual spending* and *Savings rate* against `reports` N17 and N19 (*Last 12 months, spending* and *savings rate*) | the same spending to the cent and the same rate to the percent |
| Force-quit the icon and reopen it | the last copy draws as soon as the account answers, under *Last updated …*, then the strip goes |
| Airplane mode, then open the icon | the last copy draws, with *This is the last copy this phone kept* — not *Could not reach the server* |
| Pull down at the top | *Refreshing*, then the strip goes |
| A custom period on Records | both date fields fit side by side (the native date input is the one WebKit here cannot measure) |
| Sign out, reopen | nothing of the book draws before signing in again |

**The writes**, each checked in the sheet afterwards:

| | expected |
|---|---|
| Swipe a row in *Needs review* right | it leaves the queue at once; in the sheet, `confirmed` is ticked on that row and no other |
| Tap a row, pick a category, Confirm | `category_override` (and `subcategory_override`) on that row; the derived `category` follows |
| A description starting with `=` on a cash row | stored as text, not a formula |
| Mark a bank row as a transfer to cash | a `transfer-leg` row after the last uid — not after row 1000 — with the same `transfer_group` on both; tap again and nothing new is written |
| Mark a bank row as a transfer to another bank that has the other half | both rows carry `tr:<debit uid>` |
| Hold a row, save a rule | a row on `rules` after the last, priority ten above the highest |
| "+ Add" on a cash tile, Add | the row lands in `transactions` with the override columns filled; in airplane mode, Add, then back online and Add again — one row, not two |
| "Update" on an asset tile | one `Transfer › Valuation change` row for the difference |
| Delete a cash row (two taps) | gone from `transactions`, present on `_removed`; the next health check reports no lost rows |

**Signing in**, from the thin slice:

| | expected |
|---|---|
| 1. Sign in in Safari, add to Home Screen, open the icon | already signed in. The screen says *Running as the Home Screen app*. |
| 1b. Sign out inside the icon, sign in from it | either works in place or needs the icon re-added. Both are acceptable (once a year); record which. |
| 2. Force-quit the icon from the app switcher, reopen | still signed in |
| 3. On the phone, without picking on the phone | *Connected to Spendsheet ✓* — the laptop's grant carries over. If not, the phone shows *Choose the book* once. |

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

## Dependencies

Solid is on its 2.0 release-candidate line, and `solid-js`, `@solidjs/web` and
`@solidjs/vite-plugin` are pinned to exact versions rather than ranges: one
candidate can break the one before it, and the three have to move together. A
bump is one pull request that changes all three, with the typecheck, the build
and the browser suite behind it — `.github/dependabot.yml` groups them for
that reason. They come off exact pins when 2.0 is `latest` on npm.

## Tests

`npm run deploy` here runs the compiler and then the root's `npm test` before it
builds anything, as the root's deploy does — the writes in `worker/actions.ts`
reach the ledger, and a deploy is the last place a red test can stop one. So
both installs have to be present: `npm ci` at the root and here.

`npm test` **at the repository root** runs these alongside the `.gs` suites:
Vitest's default include is the whole repo. Check the file list rather than the
total after touching any config — a suite that stops being collected reports
green. `npm run typecheck` here for the compiler, which Vitest never asks.

Google is faked at `fetch` in `worker/router.test.ts`, with ID tokens signed by
a key the test generates, and every refusal asserts that **nothing reached
Google** first. Each `scripts/*.mjs` keeps its test beside it, as the root's
`scripts/` tests do.

**`tests/parity.test.mjs` is what holds `src/domain/` to the `.gs`.** It
answers the preview's book (`tests/book.mjs`) with the `.gs` in the harness,
reads the same book back the way the Sheets API sends it — through the Worker's
own `READ_RANGES`, dates as serials, trailing empties dropped — answers it with
the TypeScript, and deep-compares every payload at four pinned instants, with
`TZ` pinned to the book's zone. It lives at the root because it loads the
harness. Changing one side's behaviour without the other is a red test, and it
was broken three ways on purpose to see that it is.

`npm run test:e2e` at the root drives the **built** page in WebKit too
(`web/e2e/`), under `vite preview`, with every Worker path answered by
`page.route` and the preview's book behind `/api/read` — read through
`tests/batch.mjs`, so what is on screen is what the parity test proved. They
cover the three screens, the address in both directions, the stored copy drawn
before the read lands, pull to refresh, and the forget on sign-out and on
refusal — including a read still in the air when you sign out. Each of those
was broken on purpose and went red. `web/e2e/shell/` takes the server away for
real — `setOffline` and a routed abort both stop a WebKit navigation before
the service worker is asked.

## The 10ms cap

A free-plan Worker gets 10ms of CPU per request. Waiting on `fetch` does not
count, only our own code. So `/api/read` hands Google's body back without
reading it, and the aggregation runs in the browser, where there is no cap. The writes read only the rows they name, for the same reason — and column A whole when they append, to find the next row and to know a new uid is absent.
