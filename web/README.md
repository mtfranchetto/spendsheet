# web — the Spendsheet viewer, off Apps Script

Phase 1 of the plan in `plan-for-life-after-valiant-rabbit.md`. A static Solid
app and one same-origin edge function, on Cloudflare Pages. **Door 2 is
untouched and is still the app in daily use** — nothing here replaces anything
yet.

## Why this exists

Three problems, and only one of them is speed.

The round-trip floor is Google's: ~3,350ms for the `/exec` document before a
line of page code runs, ~2,700ms per `google.script.run` call. Server work was
halved twice and the open still costs ~6s.

The page's storage is *ephemeral*, not merely short-lived — on
`…-script.googleusercontent.com` inside `script.google.com` it is third party by
the only definition WebKit counts, so `localStorage` is partitioned into an
in-memory map that dies with the application. An iOS Home Screen web clip is an
application iOS ends whenever it wants the process back, so the icon warms
never.

And Door 2 is the source of the whole two-manifest deploy apparatus.

On a first-party origin all three go away at once. The Sheet stays the
datastore.

## Layout

| | |
|---|---|
| `src/sheets/records.ts` | the adapter: Sheets API values → `readRecords_`-shaped records. The one piece the port of `21_query.gs` needs. |
| `src/query/` | empty until phase 2, when `21_query.gs` lands here as pure TypeScript. |
| `src/api/client.ts` | one place that knows how to ask the server something, and that tells a refusal from a dropped connection. |
| `src/app/` | the Solid app. Phase 1's screen only. |
| `functions/lib/router.ts` | every route. Pure `(Request, Env, now) => Response` — no Cloudflare types, so it tests under plain Vitest. |
| `functions/lib/session.ts` | the signed `HttpOnly` cookie, which is the reason this architecture was chosen. |
| `functions/lib/oauth.ts` | sign-in by redirect, so no third-party script runs on the page. |
| `functions/lib/google-identity.ts` | verifying Google's ID token against its JWKS. |
| `functions/lib/service-account.ts` | the credential that reaches the Sheet. `01_jwt.gs` in WebCrypto. |
| `functions/api/[[path]].ts` | the only file that knows it is on Cloudflare. Five lines. |
| `scripts/tools.sh` | is this machine ready, and make it ready. |
| `scripts/lib/tools.sh` | the table of what "ready" means, sourced by both. |
| `scripts/infra.sh` | accounts and secrets. |

## Two deviations from the approved plan

**Sign-in is an OAuth redirect, not the Google Identity Services button.** GIS
requires `accounts.google.com/gsi/client` in the document — a script from an
origin we do not control, on the page that renders bank balances. That is the
exact objection raised against Firebase's SDK, and invariant 3 ("no CDN at
runtime") forbids it in as many words. The redirect flow needs no script at all.
It costs one extra secret (`GOOGLE_CLIENT_SECRET`) and carries one risk that
**must be settled on the phone**: an iOS Home Screen web clip navigating to
another origin may hand off to Safari rather than staying in the clip, and a
sign-in that completes in a different container sets the cookie somewhere
useless. If it does, swapping GIS back in is contained — both flows end at the
same place, an ID token through `verifyIdToken`. See `functions/lib/oauth.ts`.

**`infra.sh` is under `web/`, not in the repo's `scripts/`,** where the standing
rule is that every script keeps a test beside it.

## Setting a machine up

```sh
npm run tools            # what is present, what is missing, what needs signing in
npm run tools:install    # install whatever is missing
```

`tools.sh` changes nothing in check mode and exits non-zero if a required tool
is absent, which is why `infra.sh` runs it first: everything that script does
*creates* something, so discovering a missing `gcloud` half way through leaves a
real service account behind and a script that cannot simply be re-run over it.

It will not install Homebrew — that means piping a script off the internet into
a shell, and there is no reason that becomes acceptable because it is
convenient. It also never signs you in; `gcloud auth login` and
`wrangler login` want a browser and a human. It reports which of them still do.

Watch for one trap it now handles: **`wrangler whoami` exits 0 while telling you
it is not authenticated**, so the check looks for an Account ID in the output
rather than trusting the exit code. It is biased towards a false "sign in" over
a false "ok", because the second one fails in the middle of `infra.sh`.

## Running it

```sh
npm install
cp .dev.vars.example .dev.vars        # then fill it in

npm run build                          # dist/
npx wrangler pages dev dist            # the API, on :8788
npm run dev                            # the page, on :4322, proxying /api
```

Two processes on purpose: a crashed API should not take the page down with it,
and the logs stay readable. The proxy means the browser sees **one origin** in
dev exactly as in production — so cookie behaviour under test is the cookie
behaviour that ships, rather than something that works locally and fails on the
phone.

## Tests

`npm test` **at the repository root** runs these alongside the `.gs` suites —
Vitest's default include is the whole repo, so `web/**/*.test.ts` is collected
with no config change. Check the file list rather than the total after touching
any config: a suite that stops being collected reports green.

`npm run typecheck` here for the app; `tsc` does not run under Vitest.

Every router test runs **without a network**, and that is the point rather than
a convenience: each asserts a request is turned away *before* anything reaches
for a credential.

## What phase 1 has to prove, and where

Two of these can only be answered on the actual phone, from the Home Screen
icon. WebKit on a laptop cannot answer either — it does not apply ITP's
third-party rules the way the phone does, which is exactly how the last storage
measurement was taken correctly and generalised too far.

| | |
|---|---|
| Sign in, add to Home Screen, **force-quit from the app switcher**, reopen | still signed in — the gesture that could refute the whole premise |
| Sign in from the icon | does the redirect stay in the clip, or hand off to Safari |
| Sign in with a second Google account | lands on `/?signin=wrong-account`, no session |
| `GET /api/ledger-probe` against the real ledger | the CPU figure on the Cloudflare dashboard |

The probe is **throwaway — delete it at the end of phase 1.** It deliberately
parses and walks the whole ledger, which is what the recommended read path
exists to avoid. It gates nothing: `/api/values` is pass-through and has nothing
to parse, so a bad number changes no decision already made. It only says whether
server-side aggregation was ever an option, which is the one thing that would
justify option C's D1 mirror.

## The 10ms cap

A free-plan Worker gets 10ms of CPU per invocation. Waiting on `fetch` does not
count — only our own code does. Overrunning is a hard stop, not a slowdown: the
isolate is killed and the client gets error 1102 as a 5xx, and it fails on the
*size of the work* rather than on luck, which makes it a cliff that gets closer
as the ledger grows.

So `/api/values` returns the upstream body without touching it. **"Proxy" has to
mean pass-through and not transform** — a `TransformStream` touching each chunk
can hit 1102 halfway and truncate the body, which is worse than failing, because
a truncated JSON array is a shorter ledger rather than an error.
