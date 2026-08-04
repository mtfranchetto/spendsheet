# Working notes for Claude

Conventions that are load-bearing here and not obvious from reading the code.

**The reasoning behind a decision lives in the comment above it.** File headers and function docstrings in `src/*.gs` carry the *why*, deliberately and at length — including what was tried and rejected. Read the header of the file you're changing before changing it, and **don't re-litigate a decision it already argues.** If you disagree with one, say so; don't quietly reverse it.

(An earlier `docs/PLAN.md` held the original design document and build plan. It was removed once every phase shipped — it had become a historical artefact that read as a roadmap. `git log -- docs/PLAN.md` if you ever want it. A second one covered the dashboard rebuild, the reports tab and the review queue, and was removed the same way when they landed.)

## The governing rule

> **Code only for what runs unattended and repeatedly. One-time human operations get documented, not automated.**

This is why there's no CSV importer (File → Import, then paste-values) and no "add manual account" wizard (you type a row). Both were removed deliberately. Don't reintroduce them; if a new feature is one-time, write it into `docs/` instead.

The one accepted exception is `installCredentials()`: a documented procedure that silently corrupts a multi-line PEM is a trap, not a procedure.

## Where things go

Files are numbered because Apps Script has no modules — it concatenates `src/*.gs` in filename order into one global scope. The numbering is layering, not just sequence: nothing lower may depend on anything higher.

| | |
|---|---|
| `00_config.gs` | pure data. No `SpreadsheetApp`, no network. |
| `01_jwt.gs` | RS256 signing. |
| `02_api.gs` | Enable Banking HTTP. Speaks no tab names, reads no cells. |
| `03_sheets.gs` | spreadsheet primitives — addressing, appending, `_config`, `_anomalies`. |
| `04_setup.gs` | builds the book. Idempotent. |
| `05_auth.gs` | the consent round-trip and `doGet`. Nothing about what a session *means*. |
| `06_accounts.gs` | sessions → `accounts` and `_status`, plus balance selection. |
| `07_transactions.gs` | provider transaction → row. Pure. |
| `08_dedup.gs` | identity: uid, ordinal, conflict detection. Pure. |
| `09_sync.gs` | orchestration only. What to ask for, in what order, what to do when one bank fails. |
| `10_cash.gs` | `cash_entry` → `transactions`. Money no API knows about. |
| `11_triggers.gs` | the daily schedule. Idempotent by construction. |
| `12_monitor.gs` | the six failure detectors, alerting, Drive snapshots. |
| `13_import.gs` | formula builders for `_import_staged`. No importer — see the governing rule. |
| `14_categorize.gs` | the cascade: merchant keys, learned memory, transfer pairing, confirming. |
| `15_recurring.gs` | cadence detection and the forward cashflow projection. Both pure at the core. |
| `16_dashboard.gs` | every formula on the dashboard and on `recent` — the two read-only views. Called from `setup()` through `functionExists_`. |
| `17_analytics.gs` | period arithmetic, the `reports` tab, and every chart in the book. |
| `17_review.gs` | the review queue and the `onEdit` write-back. |
| `18_diagnostics.gs` | smoke tests and raw dumps. Nothing here runs unattended. |
| `19_menu.gs` | last, so every function it names is defined. |

The gap before `18` is deliberate — adding a phase should not renumber anything. It got used, and by **two** files: analytics and review are different kinds of thing (one reads, one writes back) and splitting them was cheaper than a 900-line file. Two names at the same number is fine because the numbering is load order, and `17_analytics.gs` sorts before `17_review.gs`, which is the dependency direction. It is not licence to keep adding — a third would mean 17 has become a bin.

**Where the dashboard seam is:** 16 owns what you read, 17 owns what you plot. Charts need ranges that already exist, so they are built after every formula is written, and 16 exposes its layout through `DASH` for 17 to point at.

When a file starts holding two kinds of thing, split it before adding a third. `04_auth.gs` reached 769 lines by owning the consent flow, the accounts domain, the sheet primitives and the diagnostics at once; the primitives in particular were invisible there, and the sync would have grown its own copy.

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
- **`getLastRow()` is not a record count.** Several tabs carry an open-ended `ARRAYFORMULA` in row 2, so Sheets reports ~1000 rows of content on a tab holding nothing — which once put a real account at row 1001 while every run reported success. Never append at `getLastRow() + 1`; use `appendRows_` (strictly after the last record) or `nextEmptyRow_` (upserts, reuses a gap). `sheet.appendRow()` has the same bug baked in and the harness reproduces it faithfully.
- **An empty cell is not zero. Call `isBlankCell_` *before* `Number()`.** `Number('')` is `0` and `isFinite(0)` is true, so the obvious guard passes and a cleared cell reads as a value someone deliberately typed. This has bitten four times now: a cleared `sync_window_days` fetched nothing while looking like a healthy sync, a blank cash amount became a €0 transaction, a cleared `sync_hour` scheduled midnight. Every one failed silently *and* plausibly — which is why the rule is check the input, not the result. `parseFloat` and `parseInt` are the same. Treat any new numeric read of a cell as suspect until it has a blank test.
- **A boolean column an `ARRAYFORMULA` builds must say `FALSE` on the empty rows, not `""`.** `QUERY` infers a column's type from what is in it, and an `ARRAYFORMULA` spills to the *sheet's* last row rather than the last record. Thirty booleans among nine hundred empty strings is a **text** column, so `where AC = true` matches nothing — on the newest books, which are exactly the ones where a blank dashboard reads as "not set up yet" rather than as a bug. `in_reports` is the column this applies to; the other derived columns emit `""` correctly, because a blank number is not a false number.
- **A conditional-format rule does not pass through `localizeFormula`.** That helper translates the formulas written into *cells*, at the one boundary they all cross. `setConditionalFormatRules` is not that boundary, so `=AND(a,b)` in a decimal-comma locale is a parse failure with no cell to show `#ERROR!` in — the rule simply never fires and the thing it was watching goes on looking fine. Write such a condition with **no comma at all**: two tests multiplied and compared to zero needs no separator and returns a real boolean.
- **A formula that will be compared to `TRUE` must return a boolean, not `1`.** Sheets does not coerce across types in a comparison: `=1=TRUE` is FALSE there, where in Excel it is TRUE. A condition built by multiplying two tests yields `1`, so `include=TRUE` silently misses and every column gated on it blanks. The symptom is two columns contradicting each other — `include` showing `1` while `why` gives the excluded-row reason — because only one of them is comparing types Sheets thinks are comparable. End such an expression with a comparison (`(…)>0`).
- **A generated sheet reference needs its `!`.** `TABS.IMPORT_RAW + '$A$2:$A'` reads correctly at the call site and produces `_import_raw$A$2:$A`, which does not parse. Build the whole reference in one helper rather than leaving a bare range for callers to prefix. Both this and the rule above shipped green: the harness never hands a formula to a spreadsheet, so parens, quotes and localisation were all it could check. `tests/import.test.mjs` now checks reference shape and result type too — the two things a string test *can* prove.
- **Never write a literal control character into a source file.** A `join('\0')` written as a real NUL byte works perfectly at runtime — and makes `grep` classify the file as binary and report *nothing*, silently. Two separate wrong conclusions came from that: "no formula builds column J" and "the balance `ARRAYFORMULA` doesn't exist", both drawn from an empty grep over `04_setup.gs`, which contains eleven of them. Write the escape, not the character. This has now happened twice — most recently in the very test written to catch it — so it is a test rather than a rule: `tests/manifest.test.mjs` fails on any control character under `src/`. `file src/*.gs` reporting `data` rather than `text` is the manual check.
- **A second definition of a function name silently wins.** Apps Script concatenates `src/*.gs` into one global scope, so two `function needsReviewFormula()` in the same file is not an error — the later one replaces the earlier, and every existing caller quietly changes meaning. It happened by adding a dashboard block whose formula builder reused a name the health strip was already using, which would have put a ten-row `QUERY` where a count belonged. `grep -c 'function name('` before naming anything, and prefer a name that says which block it builds.
- **The schema grows rightwards and so do you — into the same column.** "Append to the right is safe" and "a new schema column lands on the first free column" describe the same slot. `buildTable_` wrote the header row straight over it, which cost the name of that column *and* the new formula: an `ARRAYFORMULA` anchored at row 2 cannot expand through a column that already has data and gives `#REF!` instead — one broken formula on one tab, one header quietly renamed, and nothing connecting them. `in_reports` shipped green and landed as an empty dashboard on the only book that mattered. `makeRoomForNewColumns_` now inserts a column when the slot is occupied. Test **against a book that already has data in that slot**, not just a fresh one — the harness builds every tab from nothing, where the collision cannot happen.
- **A conditional-format rule may not contain a comma, which rules out every function you would reach for.** `AND`, `IF`, `OR` and `VLOOKUP` all need one. The dashboard's answer is a hidden severity column: a formula in a *cell* — which does pass through `localizeFormula` — computes `2`, `1`, `0` or blank, and every rule is `=$G4=2`. That also puts the thresholds in `_config` rather than freezing them as literals inside a rule no test can evaluate. Reach for a hidden helper cell before reaching for a cleverer rule.
- **A layout decision made for the desktop has to be re-checked against the phone.** The dashboard's blocks were separated by *column* so a growing `QUERY` could not collide with its neighbour — correct reasoning, and it produced a tab twenty-nine columns wide on a device that scrolls vertically. The fix was not to abandon the guarantee but to get it a cheaper way: bound every block with an explicit `limit` and stack them. When a constraint forces an awkward layout, ask whether the constraint can be removed at the source.
- **Bulk writes go through one `setValues`.** A per-cell loop is fine for `accounts`; at a few thousand transactions it burns the six-minute limit on round-trips alone.
- **`transactions` is never sorted, and no column is ever inserted mid-schema.** Both break row identity and every formula reference silently. Append to the right is fine — that is why `connection_id` is the last `accounts` column rather than sitting next to `provider`.
- **Code owns `transactions` A–O; formulas and the user own P onward.** Sync appends, never rewrites. A row already in the sheet is never touched again.
- **The sign is never in the amount.** Direction is `credit_debit_indicator`, applied to `Math.abs(...)` — on transactions *and* independently on balances. Both are places where getting it wrong inverts a total while looking plausible.
- **Every report reads `amount_eur`, never `amount`.**

## Testing

Tests go in the **same phase as the code they cover**, never batched at the end. The harness fakes the Google services, so it proves logic — not that Sheets accepts what we hand it. That gap is real: the locale `#ERROR!` bug passed every test. Things needing the live runtime go in `runSmokeTests()`, which writes to `_tests`.

`setup()` must stay idempotent, and must not discard user customisations — see `tests/customization.test.mjs` for the boundary.

## Never

Commit a `.pem`, a `.clasp.json`, or any CSV or export. `.gitignore` covers them; `git add -f` doesn't care. The repo is intended to go public.
