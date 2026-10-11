# Working notes for Claude

Conventions that are load-bearing here and not obvious from reading the code. Each rule below is the short form. Where it names a file or a test, the argument is in that file's header or docstring; where it names none, the rule is the whole of it.

**The reasoning behind a decision lives in the comment above it.** File headers and function docstrings in `src/*.gs` carry the *why*, deliberately and at length — including what was tried and rejected. Read the header of the file you're changing before changing it, and **don't re-litigate a decision it already argues.** If you disagree with one, say so; don't quietly reverse it.

## The governing rule

> **Code only for what runs unattended and repeatedly. One-time human operations get documented, not automated.**

**It governs features of the book** — what a person does in the Sheet or on the phone. This is why there's no CSV importer (File → Import loads the file) and no "add manual account" wizard (you type a row). Don't introduce them; if a new feature is one-time, write it into `docs/` instead.

A one-time feature earns code only where the documented procedure fails silently. `installCredentials()` is the model: a procedure that silently corrupts a multi-line PEM is a trap, not a procedure. `11_triggers.gs` and `importStagedRows` in `13_import.gs` argue the same ground in their own comments.

**Technical setup is outside it.** Installing tools, building the book's infrastructure and deploying get scripted wherever an API allows; `docs/SETUP.md` holds the steps no API reaches.

## Where things go

Files are numbered because Apps Script has no modules — it concatenates `src/*.gs` in filename order into one global scope. The numbering is layering, not just sequence: nothing lower may depend on anything higher.

| | |
|---|---|
| `00_config.gs` | pure data. No `SpreadsheetApp`, no network. |
| `01_jwt.gs` | RS256 signing. |
| `02_api.gs` | Enable Banking HTTP. Speaks no tab names, reads no cells. |
| `03_sheets.gs` | spreadsheet primitives — addressing, appending, `_config`, `_anomalies`. |
| `04_gates.gs` | who may run what: `requireInteractive_`, `requireScheduled_`, `requireOwner_`, and the `owner_email` they read. Below everything that calls them, and in no front door's file — a test holds them there. |
| `04_setup.gs` | builds the book. Idempotent; seeds only ever add rows. |
| `05_auth.gs` | the consent round-trip and `doGet`. Nothing about what a session *means*. |
| `06_accounts.gs` | sessions → `accounts` and `_status`, plus balance selection. |
| `07_transactions.gs` | provider transaction → row. Pure. |
| `08_dedup.gs` | identity: uid, ordinal, conflict detection. Pure. |
| `09_sync.gs` | orchestration only. What to ask for, in what order, what to do when one bank fails. |
| `10_cash.gs` | `cash_entry` → `transactions`. Money no API knows about. |
| `11_triggers.gs` | the daily schedule. Idempotent by construction. |
| `12_monitor.gs` | the six failure detectors, alerting, Drive snapshots. A drop in the row count is excused only by rows archived to `_removed` since the count was remembered whose uid is gone. |
| `13_import.gs` | formula builders for `_import_staged`. No importer — see the governing rule. |
| `14_categorize.gs` | the cascade: merchant keys, transfer pairing, confirming, and **one priority-ordered match list** — `rules` and `_memory` are matched together, with `memory_priority` in `_config` deciding where learned history sits. `_memory` is rebuilt nightly by `learnScheduled`. |
| `15_duplicates.gs` | one transaction, two rows, two sources. The only code in the project that deletes a row of history. No cadence detection or cashflow projection: `reports` reaches that question directly. |
| `16_migrations.gs` | what lies past "setup only adds": `applySeedDefaults()` and `tidyCategories()`. Both rewrite a book with history in it, and both ask first. |
| `17_analytics.gs` | period arithmetic, the `reports` tab, and every chart in the book. Charts are built after every formula that fills their range. |
| `17_review.gs` | the review queue and the `onEdit` write-back. |
| `18_diagnostics.gs` | smoke tests and raw dumps. Nothing here runs unattended. |
| `19_menu.gs` | the Spendsheet menu. |

Two names at one number is fine when the load order between them is the dependency direction (`04_gates` before `04_setup`, `17_analytics` before `17_review`). It is not licence to keep adding — a third would mean the number has become a bin. When a file starts holding two kinds of thing, split it before adding a third.

**The phone app is not in `src/`.** It lives in `web/` — a static page and a small Cloudflare Worker that read and write the book through the Sheets API with the signed-in person's own `drive.file` grant. The book is the only thing the two share, and `viewer_url` in `_config` is the one handshake. `web/README.md` maps its files; each header argues its decisions. It aggregates in the browser (`web/src/domain/`), and `tests/parity.test.mjs` holds those answers to recorded snapshots and to the `.gs` it shares logic with — `runChecks_`, `normalizeMerchant`.

**There is no dashboard tab, by design.** The phone computes position and recent activity from the ledger; a tab would need some fifty `ARRAYFORMULA` anchors to do it. `reports` stays because it is the only independent implementation of the same aggregates, and two implementations that agree is the only evidence the numbers are right.

**It is off Apps Script for two platform reasons no code could change:** an Apps Script web app pays seconds of fixed overhead per page and per call, and its iframe origin is third-party storage to WebKit — ephemeral, so nothing cached survives a Home Screen launch. `web/` owns its origin.

## After pushing code

`npm run deploy` does the sequence: `npm test` → check the manifest still says `ANYONE_ANONYMOUS` → `clasp push --force` → if anything versioned changed, cut a version and move the redirect deployment onto it → read it back from Google and fail if it is not what it must be. `npm run deploy:dry` prints the plan and touches nothing. `docs/DEPLOY.md` is the reference; `scripts/deploy.mjs` argues the reasoning. The phone app deploys separately, from `web/`, and runs the compiler and the suite first.

`clasp push` updates the project, so menu items pick it up at once. It does **not** update the live `/exec` deployment, which serves a frozen version **of the whole project**. So any change under `src/` needs a new version on the existing deployment, not only a change to `doGet`.

**There is one deployment: the consent redirect, access Anyone, whose URL is registered with Enable Banking.** Three traps, all of which have fired:

- *New deployment* mints a different URL, which breaks the registered redirect. Always update in place.
- **A redeploy rebuilds the deployment's access from the manifest.** `entryPoints` is output-only in the API, so `src/appsscript.json` *is* the access setting, and the deploy script refuses to push one that does not say `ANYONE_ANONYMOUS`.
- **The API answers a write with the state from before it**, on both the deployments endpoint and `clasp list-versions` — and the stale answer is a real, plausible version number. Every version a run creates must come back strictly above the highest that existed before it (`settledVersion`, `createVersion`). Never read back a write here without a floor to check it against.

Flag all of this explicitly when a push needs it — don't leave it to be discovered as a Drive error on the bank's redirect.

## Cutting a release

A release is an annotated tag `vX.Y.Z` on `main` and a GitHub release with generated notes. **The tag goes on a commit whose `package.json` already says that version** — so the bump comes first, and the order is:

1. `npm version X.Y.Z --no-git-tag-version` at the root and again in `web/`. That moves both `package.json` files and both lockfiles, and nothing else.
2. Land it on `main` through a PR. **Stop here until it is merged** — a tag cut before the merge publishes a tree that names the previous version, and moving a published tag is a rewrite.
3. Pull, confirm CI is green on the merge commit, then `git tag -a vX.Y.Z -m vX.Y.Z`, push the tag, and `gh release create vX.Y.Z --generate-notes --notes-start-tag <previous tag> --verify-tag`.
4. Read it back: the tag's commit shows `X.Y.Z` in both `package.json` files.

Nothing reads the version field, so no test goes red when it is stale. The tag is the only place the mismatch shows, which is why the check is a step here.

**A release deploys nothing.** `npm run deploy` and the `web/` deploy are separate, and say so in the report.

## Constraints that break things quietly

### The runtime

- **No `import`/`export` in `src/*.gs`.** The tests load those exact files via `node:vm`; an export breaks the project for every user. CI greps for it.
- **A second definition of a function name silently wins.** One global scope, so the later replaces the earlier and every caller changes meaning. `grep -c 'function name('` before naming anything.
- **`oauthScopes` are explicit.** `tests/manifest.test.mjs` derives the required set from what `src/` calls — add a service and add its scope. It also fails on scopes nothing uses.
- **Never write a literal control character into a source file.** It makes `grep` treat the file as binary and report nothing. Write the escape. `tests/manifest.test.mjs` fails on any under the repo.
- **A rule written out quoting the thing it forbids defeats its own guard.** Write the rule, not the token.

### Who may run what

- **The `_` suffix is a privacy rule, and authorization is a separate line.** A browser bridge reaches every global without the suffix, with the owner's authority. Three gates in `04_gates.gs` draw the real boundary: `requireInteractive_()` fronts what the Sheet reaches (deciding on UI context, falling back to `requireOwner_()` in a dialog callback), `requireScheduled_(e)` fronts what a trigger names. **Side effects are what a gate protects, not only return values.** Anything with no browser caller takes the `_`. `tests/gates.test.mjs` holds every public function to it: gate on the first statement, be a reserved entry point (`doGet`, `onOpen`, `onEdit`), or reach no Google service transitively.
- **The consent redirect answers in plain text** through `ContentService`, which carries no bridge. `doGet` is the whole anonymous surface.

### Reading and writing cells

- **Author formulas with commas and write them through `setFormula_()`.** Decimal-comma locales need `;` and `setFormula()` does not convert. `localizeFormula()` translates once at the write boundary.
- **A conditional-format rule does not pass through `localizeFormula`, so it may not contain a comma** — which rules out `AND`, `IF`, `OR`, `VLOOKUP`. Multiply two tests and compare to zero, or compute in a hidden helper cell and write the rule against that.
- **A formula compared to `TRUE` must return a boolean, not `1`.** Sheets does not coerce: `=1=TRUE` is FALSE. End such an expression with a comparison (`(…)>0`).
- **A boolean column an `ARRAYFORMULA` builds must say `FALSE` on the empty rows, not `""`.** `QUERY` types a column by majority, so booleans among empty strings are text and `where X = true` matches nothing. `in_reports` is the column this applies to.
- **A generated sheet reference needs its `!`.** Build the whole reference in one helper rather than leaving a bare range for callers to prefix.
- **A grouped `QUERY` must group by every non-aggregate it selects, verbatim.** `month(D)+1` is not `month(D)`; the correction for the zero-based month goes in the label formula.
- **`INDEX` does not vectorise inside an `ARRAYFORMULA`; `VLOOKUP` does** — and cannot look left. That is why `categories` carries `child_key`/`child_parent`.
- **An `IFERROR` must not name a cause it did not check.** "Nothing matches" and a malformed query both produce no rows; a fallback that cannot tell them apart has to say so.
- **`getLastRow()` is not a record count.** An open-ended `ARRAYFORMULA` makes an empty tab report ~1000 rows. Never append at `getLastRow() + 1` or with `sheet.appendRow()`; use `appendRows_` or `nextEmptyRow_`.
- **An empty cell is not zero. Call `isBlankCell_` before `Number()`**, `parseFloat` or `parseInt`. `Number('')` is `0`, so the obvious guard passes and a cleared cell reads as a value someone typed.
- **Bulk writes go through one `setValues`.**
- **The bank is an untrusted input, and `setValues` writes what someone typing that string would get.** A description beginning with `=` lands as a live formula. `textSafe_` in `03_sheets.gs` prefixes an apostrophe at `writeCell_`, `toRow_`, `appendRows_` and `writeStagedColumn_`; it must test `typeof value === 'string'` or a negative number becomes text.
- **A response body's charset is a claim the bank makes.** `responseText_` decides on the bytes, and counts what it corrected.

### The schema

- **`transactions` is never sorted, and no column is ever inserted mid-schema.** Both break row identity and every formula reference. Append to the right.
- **Code owns `transactions` A–O; formulas and the user own P onward.** Sync appends, never rewrites.
- **The schema grows rightwards and so does the user — into the same column.** `makeRoomForNewColumns_` inserts a column when the slot is occupied. Test against a book that already has data in that slot; the harness builds every tab from nothing.
- **A spilled cell and a typed cell are indistinguishable through the API.** The anchor is the only evidence: a formula in row 2 means the column is ours, and the rows below must not be consulted. **Renaming a schema column is a migration, not an edit.**
- **A wholesale rewrite must stop at the stored columns.** Clearing at full schema width erases every `ARRAYFORMULA` anchor and stores what they had spilled. Schemas with both kinds say so — `CATEGORY_COLUMNS_STORED`/`_DERIVED`.
- **A subcategory's name has to identify exactly one parent.** `VLOOKUP` takes the first match and the dropdown source is `UNIQUE`. A test holds the seed to it and a smoke test holds the live tab.
- **Renaming a seed row is a migration, and `RETIRED_CATEGORIES` is where it goes.** `setup()` only adds, so a rename appends the new name beside the old. A rename keeps its parent (`retiredParents_`), and a `subcategory_override` whose old name survives under another parent cannot be applied — report those and leave them.
- **A blank in a seed is a question, not a default, and nothing can diverge from it.** `seedRowDiffers_` is the one comparison both the report and the rewrite use. A *non-blank* seed cell that changes is a divergence on every existing book until **Update mappings to defaults** is run.
- **`description` and `amount` are the only A–O cells anything edits, and only on rows no bank will fetch again.** Without an `entry_reference` the uid hashes the description, so a later sync would not recognise an edited row. `descriptionIsEditable` is asked twice — by the page and again by the writer. `amountIsEditable` is its own question: an imported amount is half of `crossSourceKey`, and a transfer leg has a partner holding the same figure. **An amount edit changes how much, never which way** — `editedAmount` keeps the stored sign.
- **The sign is never in the amount.** Direction is `credit_debit_indicator`, applied to `Math.abs(...)` — on transactions and independently on balances.
- **Every report reads `amount_base`, never `amount`.**
- **Changing `normalizeMerchant` changes every merchant key, and `_memory` holds the old ones** until the nightly rebuild. Don't change it for style.

### Google services

- **`drive.file` is a REST-API scope, and `DriveApp` cannot use it.** The fix for a Drive permission error is almost never a wider scope. An error naming one method is evidence about the service, not the method.
- **A scope is permission to use an API; it does not switch that API on.** This script's Cloud project is a default one the console will not open; declaring the advanced service in `appsscript.json` is what enables it, which is why `12_monitor.gs` calls `Drive.Files`. `tests/manifest.test.mjs` holds the source to the version the manifest declares.
- **A backup is the one feature whose failure has no other symptom.** `checkSnapshotPermitted_` in the smoke tests writes a probe file and deletes it.

### The phone

- **A control the phone renders natively can ignore `width`.** iOS sizes `input[type="date"]` to its content; `-webkit-appearance: none` fixes it, with `overflow-x: clip` and `overscroll-behavior: none` on `html` as the belt. **Verifying mobile-only CSS in a desktop browser proves the rule is applied and cannot prove the bug is fixed** — say which you did.
- **A chart drawn with `preserveAspectRatio="none"` cannot carry its own labels.** The scale is HTML in a gutter, positioned through the one conversion in `web/src/app/geometry.ts`. A truncated baseline with no scale reads as starting from zero, and two labels that land close together are worse than one — `spacedMarks` drops the loser, with marks passed in priority order.
- **A layout decision made for the desktop has to be re-checked against the phone.** When a constraint forces an awkward layout, ask whether it can be removed at the source.

### Measuring and faking

- **A fake must be no more forgiving than the real thing.** A faked enum has exactly the members the real one has; a fake that answers for a member the real one lacks cannot fail on a typo.
- **One timing is not a measurement.** The same spreadsheet read varies several-fold within an hour. Time the parts separately and compare them within one run.

## Testing

Tests go in the **same phase as the code they cover**, never batched at the end. The harness fakes the Google services, so it proves logic — not that Sheets accepts what we hand it. Things needing the live runtime go in `runSmokeTests()`, which writes to `_tests`.

`setup()` must stay idempotent, and must not discard user customisations — see `tests/customization.test.mjs` for the boundary.

**`tests/` is for `src/`. Everything in `scripts/` keeps its test beside it.** Vitest's default `include` is the whole repository, so a new `scripts/*.test.mjs` is collected with no config change — and **a suite that stops being collected reports green**. Check the file list, not the total, after moving one. A stale `node_modules` does the same thing — an older Vitest at the root collected two files fewer and said nothing. `npm ci` at the root before trusting a local total, and in `web/` for the compiler.

**`web/` is TypeScript with its own tests beside each file**, collected by the same root Vitest run and typechecked by `npm run typecheck` in `web/` — Vitest transpiles and never asks the compiler a question. `tests/` holds what crosses the boundary: `tests/parity.test.mjs`, and the handshakes in `tests/config.test.mjs` that hold seed names the page spells as literals to the seed that defines them.

**There are two suites and two runners, and `npm test` is only the first.** `npm run test:e2e` drives the built phone app with Playwright — `playwright.config.mjs`, `web/e2e/`, against `vite preview`, with every Worker path answered by the test itself.

- **It runs WebKit and nothing else.** The device descriptor's `hasTouch` is what makes the swipe and pull listeners reachable. WebKit's touch APIs are the old ones, so a synthesised gesture goes through `document.createTouch`/`createTouchList`.
- **WebKit is still not iOS Safari.** Say whether you checked on the device or only in a browser.
- **Vitest claims `*.spec.*` as well as `*.test.*`**, so `vitest.config.mjs` excludes `web/e2e/` and `.claude/` by directory.

A browser test is worth writing when it can go red. Break the thing on purpose and watch it fail before you keep it.

## Never

Commit a `.pem`, a `.clasp.json`, or any CSV or export. `.gitignore` covers them; `git add -f` doesn't care. The repo is intended to go public.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `mtfranchetto/spendsheet`, via the `gh` CLI — and an issue is as public as the repo, so the "Never" rule above applies to issue bodies too. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical roles, each label string equal to its name; only `wontfix` exists on the repo so far. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` and one `docs/adr/` at the root, both created lazily and neither present yet. See `docs/agents/domain.md`.
