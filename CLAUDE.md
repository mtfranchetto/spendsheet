# Working notes for Claude

Conventions that are load-bearing here and not obvious from reading the code. `docs/PLAN.md` holds the design and its reasoning — **don't re-litigate decisions recorded there.**

## The governing rule

> **Code only for what runs unattended and repeatedly. One-time human operations get documented, not automated.**

This is why there's no CSV importer (File → Import, then paste-values) and no "add manual account" wizard (you type a row). Both were removed deliberately. Don't reintroduce them; if a new feature is one-time, write it into `docs/` instead.

The one accepted exception is `installCredentials()`: a documented procedure that silently corrupts a multi-line PEM is a trap, not a procedure.

## After pushing code

`npm test` → `npx clasp push --force` → **say whether a redeploy is needed.**

`clasp push` updates the Apps Script project, so menu items and anything run from the sheet pick it up at once. It does **not** update the live `/exec` deployment, which serves a frozen version. Anything touching `doGet` or the web app needs:

> Manage deployments → pencil → Version: New version → Deploy

*New deployment* would also work but mints a different URL, breaking the redirect registered with Enable Banking. Flag this explicitly when a push needs it — don't leave it to be discovered as a Drive "unable to open the file" error.

## Constraints that break things quietly

- **No `import`/`export` in `src/*.gs`.** Apps Script concatenates files into one global scope; the tests load those exact files via `node:vm`. An export would make a function reachable from a test and break it for every user. CI greps for it.
- **File numbering is load order.** Apps Script has no modules and sorts by name.
- **Author formulas with commas and write them through `setFormula_()`.** Decimal-comma locales (it-IT and friends) need `;`, and `setFormula()` does not convert — a comma form lands as `#ERROR!`. `localizeFormula()` translates once at the write boundary.
- **`oauthScopes` are explicit**, so a missing one fails at the moment of the call. `tests/manifest.test.mjs` derives the required set from what `src/` calls — add a service and add its scope, or CI fails. It also fails on scopes nothing uses.
- **`transactions` is never sorted, and no column is ever inserted mid-schema.** Both break row identity and every formula reference silently. Append to the right is fine.
- **Code owns `transactions` A–O; formulas and the user own P onward.** Sync appends, never rewrites.
- **Every report reads `amount_eur`, never `amount`.**

## Testing

Tests go in the **same phase as the code they cover**, never batched at the end. The harness fakes the Google services, so it proves logic — not that Sheets accepts what we hand it. That gap is real: the locale `#ERROR!` bug passed every test. Things needing the live runtime go in `runSmokeTests()`, which writes to `_tests`.

`setup()` must stay idempotent, and must not discard user customisations — see `tests/customization.test.mjs` for the boundary.

## Never

Commit a `.pem`, a `.clasp.json`, or any CSV or export. `.gitignore` covers them; `git add -f` doesn't care. The repo is intended to go public.
