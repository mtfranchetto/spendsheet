# spendsheet — Enable Banking → Google Sheets personal finance

## Context

Mattia wants a BudgetBakers/Wallet-style personal finance system where **Google Sheets is the database**, fed automatically from his banks (Revolut, Fineco ×N accounts, illimity) via Enable Banking's free "restricted production" tier.

This is the third attempt at the problem, and the design is shaped by why the first two failed:

- `~/firefly/` (Oct 2025) — self-hosted Firefly III via Docker. Abandoned: too complex to run, data locked inside an app that may rot.
- `~/development/my-finance-hub/` (Mar 2025) — Tink + Supabase + Appsmith + Resend + Gemini. Abandoned: five paid/managed services to keep alive for one person's budget.

So the hard constraints are: **zero servers, zero maintenance, ~zero cost, and the data must outlive the tooling.** Google Apps Script satisfies the first three (Google-hosted runtime, free, no deps to patch). Sheets-as-record-of-truth satisfies the fourth — if Enable Banking ever kills the free tier the way Nordigen did, the connector is disposable and the history, rules and reports survive untouched.

It also needs to be **open-sourceable**: a public git repo, no build step, no CLI required, and a README someone else can follow in ten minutes.

**Reused from `my-finance-hub`** — its schema already solves things v1 needs, so it carries forward rather than being redesigned:
- `accounts.type` = bank | manual | portfolio → becomes `kind` = bank | cash | asset, covering PSD2-invisible holdings (Fineco brokerage, DeGiro, property)
- hierarchical `categories` (`parent_id`) → category/subcategory
- `transactions.transfer_account_id` → inter-account transfer matching, essential once you have 3+ banks, or moving €500 Fineco→Revolut double-counts as income *and* expense
- `bank_connections.status` / `last_sync` / `error_message` → already the monitoring model; becomes the `_status` tab

**Decisions taken:** EUR-only reporting, with the `amount_eur` contract in place from day one so multi-currency is additive later · v1 = spending by category/month + cashflow & recurring detection + net worth with manual assets (no budgets-vs-actual) · monitoring = built-in + run log, no external services · **code only for what runs unattended and repeatedly** — everything else is a documented procedure.

---

## Architecture

```
Google Sheet (the database)
└── container-bound Apps Script  ← runs on Google's servers, free
      ├── trigger: syncAll()    daily 04:00   → fetch, dedup, append
      ├── trigger: selfCheck()  daily 09:00   → independent staleness alarm
      ├── doGet(e)                            → OAuth redirect target for bank consent
      └── onOpen()                            → "Spendsheet" menu
```

Two things worth calling out:

**The web app is how we avoid a server.** Enable Banking's `POST /auth` needs a `redirect_url` for the bank to send the browser back to after SCA. Deploying the script as a web app gives us an `https://script.google.com/.../exec` URL to use — so the whole consent round-trip is self-contained. `doGet(e)` receives `?code=…`, exchanges it via `POST /sessions`, writes the session to `_status`, renders "Connected ✅". No localhost, no ngrok, no VPS. Because the endpoint must be reachable by "Anyone" for the bank to redirect into it, `startAuth()` generates a `state` nonce into Script Properties and `doGet` rejects any callback whose `state` doesn't match.

**Two independent triggers, deliberately.** `selfCheck()` is not part of `syncAll()`. If it were, a crash in the sync would take the alarm down with it — the exact failure mode where you most need to hear about it.

Secrets (RSA private key, application ID) live in **Script Properties**, never in the Sheet and never in git.

### Google account requirements

**A free personal Gmail account is enough.** No Workspace subscription, no GCP project, no billing, no card. Apps Script is included with any Google account and the consumer quotas are far above what this needs:

| | Free Gmail | Workspace |
|---|---|---|
| Runtime per execution | 6 min | 6 min |
| Trigger runtime / day | 90 min | 6 hr |
| UrlFetch calls / day | 20,000 | 100,000 |

A daily sync of three banks is ~20 calls and a few seconds — roughly 0.1% of the free ceiling. Nothing in the revised design comes close to any of these limits: the historical import is a native Sheets CSV import plus a paste, so it doesn't touch Apps Script quotas at all.

**Use a personal account, not `@yourcompany.com`** — and not just for quota reasons. On a work Workspace account, years of personal financial data sit in a tenant your employer's admins can access, subject to their retention and DLP policies, and you lose the whole thing the day you leave. This should be yours.

### Enable Banking: sandbox and production apps

This needed clarifying, and the answer shapes both the setup flow and the test strategy.

**Environment is fixed at registration, not at call time.** You register an application as either `SANDBOX` or `PRODUCTION`. There's no environment parameter and no separate base URL — both use `api.enablebanking.com`. The `kid` in your JWT *is* the application ID, so which app's key you sign with determines which environment you reach. Separate app = separate ID = separate `.pem`.

So **we register two applications and hold both key pairs**:

| | Sandbox app | Production app |
|---|---|---|
| Registration asks for | name + redirect URLs | name, redirect URLs, description, data-protection email, privacy policy URL, ToS URL |
| Reaches | Mock ASPSP + a limited set of real bank sandboxes | your actual banks |
| Terminal state | usable immediately | **Restricted** |
| Used for | development, CI, failure-mode testing | real data |

**The production app never needs to become "Active".** Its lifecycle is Inactive → Restricted → Active, but Active requires a signed contract and company KYB. Restricted — activated by linking your own accounts — is the terminal state for personal use, and it's exactly what we want: authorization flows work normally, but data retrieval is limited to the accounts you whitelisted. That's the free tier, and it's a feature not a limitation.

**Mock ASPSP is more useful than I'd given it credit for.** It's a controllable simulator configured from the control panel, so it can produce the failure modes that are otherwise impossible to test on demand: expired sessions, 429 rate limits, absent `entry_reference`, missing balance types, non-EUR accounts. That's precisely the list I'd flagged as "assumed, resolved empirically" — so several of those become *testable* rather than merely observed. Phase 8's monitoring verification uses Mock ASPSP instead of hand-editing sheets to fake failures.

**But sandbox can't answer the provider questions.** It only exposes a limited set of real bank sandboxes, so Revolut/Fineco/illimity quirks — which balance types they return, whether they populate `entry_reference` or `merchant_category_code`, whether you hold non-EUR Revolut balances — must be probed against the **production restricted** app. That's a real sequencing constraint: sandbox proves the code paths, production restricted proves the data.

**Keys:** at registration you either let the browser generate the keypair (private key never transmitted, downloads as `.pem`) or generate externally with OpenSSL and upload only the public key. Either is fine; the browser path is one fewer step for the README.

**One practical snag worth pre-empting:** production registration demands a privacy policy URL and terms-of-service URL, which is awkward for a personal project. The repo ships `PRIVACY.md` and `TERMS.md` and we point at their GitHub URLs — accurate (the data goes to your own Sheet and nowhere else) and it unblocks everyone who clones this. **Note the dependency:** those URLs only resolve once the repo is public, so `mtfranchetto/spendsheet` has to be flipped from private before phase 3. Sandbox registration doesn't ask for them, so phases 1–2 are unaffected.

Script Properties therefore hold `EB_ENV` plus both pairs — `EB_SANDBOX_APP_ID`/`EB_SANDBOX_KEY`, `EB_PROD_APP_ID`/`EB_PROD_KEY` — and `02_api.gs` selects on `EB_ENV`. The same `/exec` web app URL serves as the redirect for both; it just has to be whitelisted in each app separately.

---

## Repo: `spendsheet`

### The name

`spendsheet` — no collision found, short, typeable, and it names the *outcome* rather than either vendor.

That last part is deliberate. Naming it after Enable Banking would contradict the plan's own premise that the connector is disposable — and with illimity being absorbed into Banca Ifis this year, a provider swap is plausible enough to plan for. "Sheet" is a generic English word, which sidesteps Google's brand rules: they explicitly prohibit "Google" in third-party project names and discourage G-naming (`gmoney`, `gsheets`).

**Ruled out, so we don't revisit it:** `bank2sheets` and `bank-to-sheets` are live commercial services (banktwosheets.com, banktosheets.com) · `budgetsheet` is a Workspace Marketplace add-on · `bank-account-to-sheets` is an existing Plaid-based GitHub project · anything with `openbank` collides with Santander's Openbank, which is a genuinely bad collision for something touching PSD2 · `ledgersheet` reads as plain-text accounting (ledger-cli/hledger) or a hardware wallet.

**Closest prior art:** [`youneedaspreadsheet`](https://github.com/scottrobertson/youneedaspreadsheet) — Open Banking → Sheets, a YNAB pun. Worth reading before phase 2 regardless of naming.

**Discoverability is handled by metadata, not the name.** A brandable name doesn't match what people search, so the GitHub description carries the keywords — *"Sync bank transactions into Google Sheets via open banking (PSD2). Free, no server, no subscription."* — plus topics: `open-banking`, `psd2`, `google-sheets`, `google-apps-script`, `personal-finance`, `enable-banking`, `nordigen-alternative`. GitHub search weights description and topics heavily, and `nordigen-alternative` in particular targets everyone stranded by that shutdown.

### Initial scaffolding — phase 1, concretely

Repo confirmed: **[github.com/mtfranchetto/spendsheet](https://github.com/mtfranchetto/spendsheet)**, created 2026-07-28, currently **empty** (no commits, no default branch, no license, no description) and **private**. `gh` is authenticated as `mtfranchetto` with `repo` scope over SSH, so pushing works without further setup.

Two things I found that need handling before the first commit:

**Your global `git user.email` is unset** (`user.name` is set to "Mattia Franchetto"). A commit would fail outright. I'll set it **repo-locally**, not globally, so nothing about your work repos changes — and to GitHub's privacy-preserving address rather than a real one:

```
git config user.email "3091286+mtfranchetto@users.noreply.github.com"
git config user.name  "Mattia Franchetto"
```

That keeps both your personal and your work address out of the permanent commit history of a repo that's going public. Commits still attribute correctly to your GitHub account.

**The repo is private, and that blocks phase 3.** Enable Banking's *production* registration requires a privacy policy URL and a ToS URL — we planned to point those at `PRIVACY.md`/`TERMS.md` in this repo, but those URLs 404 for anyone while it's private. So: **flip the repo public before phase 3**, or host those two files separately (a public gist works). Nothing before phase 3 is blocked, and sandbox registration doesn't ask for them at all — so this can wait until you're convinced the thing works, which was the point of the sandbox-first split.

The scaffolding sequence, with `.gitignore` deliberately first:

```
mv ~/finance-sheets ~/spendsheet          # existing empty folder
cd ~/spendsheet
git init -b main
git config user.email "3091286+mtfranchetto@users.noreply.github.com"
git config user.name  "Mattia Franchetto"

# .gitignore FIRST, before any .pem can ever land in the tree
#   *.pem  .clasp.json  *.csv  snapshots/  node_modules/  .DS_Store

# then: README.md, LICENSE (MIT), PRIVACY.md, TERMS.md,
#       appsscript.json, package.json, .claspignore,
#       .github/workflows/test.yml, docs/PLAN.md (this document),
#       src/00_config.gs, src/03_setup.gs, src/10_menu.gs,
#       tests/harness.mjs + a first passing test

git remote add origin git@github.com:mtfranchetto/spendsheet.git
git add -A && git commit && git push -u origin main
```

`.gitignore` lands in the first commit on purpose. Once a `.pem` is in git history, removing it means rewriting history — and for a key that grants access to your bank data, "it's only in an old commit" isn't good enough.

I'll also set the repo description and topics via `gh` in the same pass, since those are what make it findable later:

```
gh repo edit mtfranchetto/spendsheet \
  --description "Sync bank transactions into Google Sheets via open banking (PSD2). Free, no server, no subscription." \
  --add-topic open-banking,psd2,google-sheets,google-apps-script,personal-finance,enable-banking,nordigen-alternative
```

### Layout

Plain `.gs` JavaScript. **No TypeScript, no bundler, no npm.** A build step is the single biggest barrier to someone else adopting this, and it buys nothing here.

```
spendsheet/
├── README.md              sandbox-first setup, then production; screenshots of the menu
├── LICENSE               MIT
├── PRIVACY.md            required for Enable Banking production registration
├── TERMS.md              same
├── .gitignore            .clasp.json, *.pem, *.csv, snapshots — never commit data
├── .claspignore
├── appsscript.json       manifest: timezone Europe/Rome, V8, webapp config
├── package.json          devDependencies only — vitest. Users never run npm.
├── .github/workflows/test.yml
├── tests/
│   ├── harness.mjs       vm-loads src/*.gs with stubbed Google globals
│   ├── mapping.test.mjs  signedAmount, pickBalance, deriveCounterparty, joinRemittance
│   ├── dedup.test.mjs
│   ├── categorize.test.mjs
│   ├── transfers.test.mjs
│   ├── recurring.test.mjs
│   └── monitor.test.mjs
├── docs/
│   ├── SETUP.md          long-form, incl. both Enable Banking registrations
│   ├── IMPORT.md         the BudgetBakers / generic CSV procedure
│   ├── MONITORING.md     what breaks, how you find out, how you fix it
│   ├── SHEET-SCHEMA.md   every tab and column, and who owns it
│   ├── PROVIDERS.md      per-bank findings from the phase 3 probe
│   └── CONTRIBUTING.md   how to run the tests
└── src/
    ├── 00_config.gs      tab names, column maps, defaults
    ├── 01_jwt.gs         RS256 JWT via Utilities.computeRsaSha256Signature
    ├── 02_api.gs         Enable Banking client + typed errors
    ├── 03_setup.gs       setup() — builds every tab, header, formula, format, seed row
    ├── 04_auth.gs        listBanks(), startAuth(), doGet() callback
    ├── 05_sync.gs        syncAll() — trigger entry point, incl. Form-response ingest
    ├── 06_dedup.gs       uid hashing + existing-uid index
    ├── 07_categorize.gs  the cascade: transfers, learned memory, rules, corrections
    ├── 08_recurring.gs   detectRecurring() + buildCashflow()
    ├── 09_monitor.gs     runLog(), status writes, alerts, selfCheck()
    └── 10_menu.gs        onOpen() custom menu
```

### What earns a code file

Both times you pushed back, the answer was the same, so it's worth writing down as the rule this repo follows:

> **Code only for what runs unattended and repeatedly. One-time human operations get documented, not automated.**

That killed `12_manual.gs` (adding an account is typing a row) and it kills `11_import.gs` too — see below. It also merged `07_transfers.gs` into `07_categorize.gs`, since transfer detection is just tier 2 of the categorisation cascade rather than a separate concern.

Down from 13 files to 11, and the two that went were the two with the most incidental complexity in them.

Files are numbered because Apps Script has no module system — it concatenates sources in file order. Numbering makes load order explicit instead of accidental.

---

## Testing

Apps Script has no native test runner, so the approach is to make the logic testable rather than to test the runtime.

**Pure logic is separated from Sheet/HTTP I/O.** Every `.gs` file exposes its real work as pure functions taking plain arrays and objects — `signedAmount(amount, indicator)`, `pickBalance(balances)`, `deriveCounterparty(tx)`, `computeUid(row, ordinal)`, `normalizeMerchant(desc)`, `categorize(tx, memory, rules)`, `findTransferPairs(rows, windowDays)`, `detectRecurring(rows)`, `projectCashflow(balances, recurring, days)`. The Apps Script-touching wrappers stay thin enough to eyeball. This is the main reason to bother with the split — bugs here will live in sign conventions, dedup, merchant normalisation and recurrence detection, all of which are pure.

**Tests run in Node against the exact files that ship.** `tests/harness.mjs` uses `node:vm` to load `src/*.gs` into a context with stubbed `SpreadsheetApp`, `UrlFetchApp`, `PropertiesService`, `MailApp` and `Utilities`. So there is **no build step, no `export`/`import` statements, no duplicated source** — the same plain `.gs` files get pasted into Apps Script and executed by vitest. That keeps user setup at "paste the files" while contributors get `npm test` and a GitHub Actions check on every PR.

Representative cases, chosen because each one is a bug I'd otherwise expect to ship:

| Function | Cases that matter |
|---|---|
| `signedAmount` | string `"12.34"` parsed · `DBIT` → negative · `CRDT` → positive · **`"-12.34"` + `DBIT` does not double-negate** · missing indicator throws rather than guessing |
| `deriveCounterparty` | debit picks `creditor.name` · credit picks `debtor.name` · falls back to IBAN · both absent |
| `joinRemittance` | array joined · single string · null · whitespace collapsed |
| `pickBalance` | full preference order · **`DBIT` balance → negative** · none present → blank not zero |
| `computeUid` | stable across runs · `entry_reference` path scoped by account · **two identical same-day amounts produce different uids** · same entry_ref + different amount → anomaly, not dup |
| `normalizeMerchant` | strips dates, card suffixes, auth codes, city names · `PAGAMENTO POS 12/03 CARTA *1234 ESSELUNGA SPA TORINO` → `esselunga` · doesn't over-strip short names |
| `categorize` | cascade order: override → transfer → memory → mcc → text → unclassified · records `category_source` · unclassified never becomes "Other" |
| `matchRule` | priority order wins · mcc before text · regex vs contains · `account_filter` respected · disabled rules skipped |
| `findTransferPairs` | pairs opposite signs in date window · pairs ATM withdrawal to cash account · does **not** pair two coincidental €50 purchases |
| `detectRecurring` | monthly · weekly · 4-weekly · ±3 day drift tolerated · 2 occurrences rejected as noise |
| `projectCashflow` | 90-day sum · month-end edge · empty recurring set |
| `isStale` / alerts | threshold boundary off-by-one · 0-rows-for-3-days rule · cash/asset accounts excluded from consent alerts |

The first four are where the expensive bugs live: total inversion of the data, silently losing real transactions, and mis-normalising merchants so the learned memory never gets a hit.

`parseAmount`/`parseDate`/`mapCsvRow` are **gone** from this list, along with the code they tested — the revised import uses the spreadsheet locale and native CSV import instead. Deleting code deletes its tests.

The parts that genuinely need the Google runtime — JWT signing, Sheet reads/writes, the live API client — get a `runSmokeTests()` menu item instead, writing pass/fail to a `_tests` tab. Those aren't unit tests and won't run in CI, and the README will say so rather than implying coverage it doesn't have.

Tests are written **in the same phase as the code they cover**, not batched into a final phase.

`clasp` is documented in `docs/SETUP.md` as the **optional** developer path. The primary path in the README is copy-paste, so nobody needs Node installed to use this.

---

## Sheet scaffold

Built programmatically by `setup()` — idempotent, safe to re-run, creates only what's missing. That means the repo *is* the Sheet template; there's no binary artefact to keep in sync, and other people run one function instead of copying someone else's file.

### The core contract

On `transactions`, **columns A–O are owned by code, P onward are owned by formulas and you.** Sync only ever appends and never rewrites a row. This is what makes manual corrections safe and the sync logic trivial.

Categorisation uses a three-column pattern so rules stay live *and* overrides stick:
- `category_auto` — `ARRAYFORMULA` matching `description`/`mcc` against the `rules` tab. Edit a rule, all history recategorises instantly.
- `category_override` — you type here; code never touches it.
- `category` — `IF(override<>"", override, auto)`. Reports read only this.

### Pending transactions live somewhere else

You were right that append-only breaks on pending rows, and the API makes it worse: **`entry_reference` is only returned for booked transactions.** Pending ones typically have no stable identifier at all — Enable Banking exposes one only when the bank guarantees it survives the transition. So for most banks there is literally nothing to match a pending row against when it settles, and its amount, date and description can all change on the way (card hold → settlement, FX, tips).

Rather than solve an unsolvable matching problem, **pending never enters the history**:

- **`transactions`** holds `BOOK` rows only. Append-only, immutable, the thing all reports read.
- **`pending`** holds the current pending set and is **truncated and rewritten in full on every sync**. No merging, no matching, no updating.

When a pending transaction settles, it arrives in the booked feed with its own `entry_reference` and is inserted normally; its pending row simply isn't in the next response, so it disappears. No duplicate, no rewrite, and the append-only guarantee survives intact.

The tradeoff, stated plainly: a transaction that stays pending for three days is not in `transactions` for those three days. That's deliberate — it means your category totals and monthly reports don't wobble as holds settle at different amounts. The `pending` tab and a dashboard "in flight" tile cover the visibility gap, which is also how Wallet presents it.

### Dedup key, corrected

`entry_reference` is **immutable per account but not globally unique** — the same value legitimately appears on different accounts — and some ASPSPs emit duplicates even within one account.

```
uid = SHA256( account_id + "|" + entry_reference )                    when entry_reference present
    = SHA256( account_id + "|" + booking_date + "|" + amount_signed
              + "|" + normalized_description + "|" + ordinal )        otherwise
```

The `ordinal` matters more than it looks. Two genuine €3 coffees at the same bar on the same day hash identically without it, and one would be silently swallowed — a bug that loses real transactions and is nearly impossible to notice later. So the fallback key counts identical tuples within the batch and appends an occurrence index.

And because ASPSPs do emit bad duplicates: if the same `account_id|entry_reference` reappears with a **different** amount or date, that's a provider bug, not a duplicate. It goes to `_anomalies` for review rather than being silently dropped or double-inserted.

### Tabs

**`transactions`** — append-only, booked only, the record of truth
| A `uid` | B `account_id` | C `account_name` | D `booking_date` | E `value_date` | F `transaction_date` | G `amount` (signed, − = outflow) | H `currency` | I `description` | J `counterparty` | K `entry_reference` | L `bank_transaction_code` | M `mcc` | N `source` | O `imported_at` |
| P `amount_eur` | Q `category_auto` | R `subcategory_auto` | S `category_source` | T `category_override` | U `category` | V `subcategory` | W `type` (expense/income/transfer) | X `transfer_group` | Y `notes` | Z `excluded` |

`amount_eur` is what every report reads — see multi-currency below. `category_source` records which cascade tier decided the category.

Mapping from the verified API shape. Every point below was checked against the aggregation API reference, and three of them are corrections to what I first wrote:

- **The API is snake_case** — `entry_reference`, `credit_debit_indicator`, `booking_date`, `transaction_amount`. Worth stating because Enable Banking publishes a *second*, separate product (the self-hosted TPP API v1) whose docs use **camelCase** (`entryReference`, `transactionAmount`). Reading the wrong doc set is an easy way to write code that silently reads `undefined` on every field. We use the cloud aggregation API at `api.enablebanking.com` → snake_case.
- **`transaction_amount.amount` is a STRING**, not a number — a decimal using `.` as separator. It must be parsed, and parsed as a string-with-possible-sign, never handed to arithmetic directly.
- **Sign is not in the amount.** Direction comes from `credit_debit_indicator` (`CRDT`/`DBIT`), so `amount_signed = (indicator === 'DBIT' ? -1 : 1) * Math.abs(parseFloat(amount))`. The `Math.abs` is deliberate: if an ASPSP ever sends `"-12.34"` *and* `DBIT`, naive multiplication double-negates and turns an expense into income. Getting this wrong inverts the entire sheet, so it's the first thing under test.
- **`counterparty`** is derived by picking the opposite side based on the indicator — `creditor.name` on a debit, `debtor.name` on a credit — falling back to `creditor_account`/`debtor_account` IBAN when the name is absent.
- **`remittance_information` is an array of strings** (confirmed), joined and whitespace-normalised into `description`.
- **`merchant_category_code`** (confirmed present) is a standard merchant classification and a much stronger categorisation signal than regexes over `PAGAMENTO POS ...`. It becomes a first-class `field` in `rules`, tried before description matching.
- **`bank_transaction_code`** and **`reference_number`** distinguish fees, SDD, standing orders and reversals — useful for categorisation and for excluding bank noise from spend reports.
- **Not every bank sends `entry_reference` at all**, and some send duplicates. Confirmed in the docs, which is why the fallback key and `_anomalies` exist rather than being defensive over-engineering.

`source` = `enablebanking` | `csv:budgetbakers` | `csv:<name>` | `manual`. Imported history, manual cash entries and API rows share one timeline — no union queries — and `source` keeps them distinguishable and separately re-importable.

**`pending`** — same columns A–O, rewritten wholesale each sync. No user-owned columns, because nothing here is worth annotating; it's gone in a day or two.

**`_anomalies`** — `detected_at`, `account_id`, `kind` (dup_entry_ref / amount_changed / unmapped_column / non_eur), `detail`, `raw_json`. The place things go instead of being silently dropped.

**`accounts`** — `account_id`, `name`, `kind` (bank/cash/asset), `provider`, `iban_masked`, `currency`, `opening_balance`, `balance_api` (code), `balance_manual` (you), `balance` (ARRAYFORMULA — see manual accounts below), `balance_type`, `balance_updated_at`, `balances_raw`, `include_in_net_worth`, `active`.

Balances needed correcting twice over. The API returns **multiple typed balances** per account and the enum is wider than I first wrote — `CLBD`, `FWAV`, `ITAV`, `ITBD`, `OTHR`, `VALU`, `XPCD` — with each bank supporting only some, so a single `balance` column can't be filled unconditionally. Sync picks by preference order **CLBD → ITBD → ITAV → XPCD → VALU → FWAV → OTHR**, records which it used in `balance_type`, and keeps the full set in `balances_raw`.

More importantly: **a `Balance` object carries its own `credit_debit_indicator`**, so a balance can itself be a debit (negative) figure. That's a second, independent sign bug I'd have shipped — an overdrawn account would have displayed as a positive balance and inflated net worth. `pickBalance` applies the indicator, same as transactions do.

`docs/PROVIDERS.md` records which balance types each of your three banks actually returns, since that's only knowable empirically.

**`rules`** — `priority`, `field` (description/counterparty/**mcc**/bank_transaction_code), `match_type` (contains/regex/equals), `pattern`, `account_filter`, `category`, `subcategory`, `type`, `enabled`. First match by priority wins. Seeded with MCC mappings first (reliable, language-independent) then ~40 Italian-bank text patterns (`BONIFICO`, `PAGAMENTO POS`, `ADDEBITO SDD`, `F24`, `COMMISSIONI`, Satispay, Esselunga, Enel, TIM…) as fallback.

**`categories`** — `category`, `subcategory`, `kind`, `icon`. Drives data-validation dropdowns. Seeded with a sane default taxonomy.

**`recurring`** — `key`, `account_id`, `category`, `avg_amount`, `cadence_days`, `occurrences`, `last_seen`, `next_expected`, `confidence`, `active`. Written by `detectRecurring()`.

**`cashflow`** — 90-day forward projection: `date`, `opening`, `expected_in`, `expected_out`, `closing`. Driven by current balances + `recurring`.

**`dashboard`** — the Wallet-like view. Net worth tile, this-month vs last-month spend, spend by category (current month), 12-month trend, cashflow chart, upcoming payments — plus a **health strip** in row 1: last successful sync, nearest consent expiry, rows imported in last 7 days. Health lives where you already look, not in a tab you'll never open.

**`_status`** — one row per connection: `connection_id`, `provider`, `session_id`, `state` (ACTIVE/EXPIRING/EXPIRED/ERROR), `valid_until`, `days_left`, `last_success`, `last_error`, `accounts_covered`.

**`_runs`** — one row per execution: `run_id`, `started_at`, `duration_ms`, `trigger`, `accounts_attempted`, `accounts_ok`, `rows_fetched`, `rows_inserted`, `rows_duplicate`, `result` (OK/PARTIAL/FAIL), `message`. Trimmed to 500 rows.

**`_config`** — non-secret settings: timezone, sync window days, alert email, stale threshold, base currency.

**`_import_map`** — CSV column mapping: `source_header` → `target_column`, plus a `preset` field. Ships with a `budgetbakers` preset pre-filled.

**`_category_map`** — `source_category` → `category` + `subcategory`. Maps BudgetBakers' taxonomy onto the local one.

**`_memory`** — `merchant_key`, `category`, `subcategory`, `hits`, `last_seen`. The learned categorisation table: tier 3 of the cascade. Built by `deriveRules()` from imported history, extended by `learnFromCorrection()` every time you fix a row.

**`cash_entry`** — `date`, `account`, `amount`, `category`, `note`, `processed`. The mobile input surface for cash, with dropdowns. Drained into `transactions` by the daily trigger.

Plus three working tabs with no schema worth listing: **`_import_raw`** (CSV lands here), **`_import_staged`** (formula-mapped, you paste from it), **`_tests`** (smoke test results). Nineteen tabs total.

`_`-prefixed tabs are hidden by `setup()`.

---

## Manual accounts: cash wallet, brokerage, property

There are **two different kinds of non-bank account**, and conflating them is why this usually feels awkward in a spreadsheet:

| | `kind: cash` | `kind: asset` |
|---|---|---|
| Example | wallet, house cash | Fineco brokerage, DeGiro, car, property |
| You log | every transaction | nothing |
| You update | nothing | a single value, occasionally |
| `balance` is | **derived**: `opening_balance + SUM(transactions)` | **typed** by you |
| In spending reports | yes | no |
| In net worth | yes | yes |

So a cash wallet is a real account that happens to have a human as its sync source, while a brokerage is a valuation you refresh.

### Setting one up: no script at all

You were right to question this — I'd made it a code file and it doesn't need to be one. **You add a manual account by typing a row into the `accounts` tab.** That's the whole flow. No menu item, no prompt, no `12_manual.gs`.

What makes that work is splitting the balance columns so no column is ever written by both code and a formula:

- `balance_api` — code writes this, bank rows only
- `balance_manual` — you type this, `asset` rows only
- `balance` — a single **`ARRAYFORMULA`** over the whole column:

```
kind = "bank"  → balance_api
kind = "cash"  → opening_balance + SUMIF(transactions.account_id, this, transactions.amount)
kind = "asset" → balance_manual
```

So a cash wallet's balance maintains itself from its transactions, and adding an account is one row with data-validated `kind`. Nothing to copy down, nothing to remember. `setup()` writes that formula once and it covers every future row.

`_status` derives `MANUAL / never expires` from `kind` rather than storing it, so manual accounts are automatically excluded from consent alerts and the rate-limit budget.

From then on a cash wallet behaves like any other account: it appears in net worth, its transactions flow through the same categorisation cascade, and it can be one leg of a transfer — "withdrew €100 from the Fineco ATM" pairs the Fineco debit against the cash credit and nets to zero instead of reporting €100 of spending.

**The only part that genuinely needs code** is ingesting phone entries — because that runs unattended and repeatedly, which is exactly the bar. It's ~15 lines inside `05_sync.gs` reusing `computeUid()`: read unprocessed rows from `cash_entry`, append to `transactions` with `source=manual`, mark them done.

### Entering cash transactions

I had a Google Form as the primary path here. **Checking it, that was wrong**, and worth recording why so we don't circle back to it:

- Google Forms has **no native mobile app** on iOS or Android. "Add to Home Screen" gives you an icon, but it's a browser bookmark.
- **Forms cannot work offline at all.** Docs, Sheets and Slides have real offline modes; Forms has none — submitting always needs a live connection.

Logging a €3 coffee happens standing in a bar, sometimes with no signal. A input method that hard-fails exactly then is the wrong default.

**Revised primary path: a `cash_entry` tab in the Google Sheets mobile app.** Five columns — date, account, amount, category, note — with data-validation dropdowns, which mobile Sheets honours. Why this wins:

- **It works offline.** Sheets' offline mode queues your edits and syncs when you reconnect. This is the whole reason to switch.
- **It's an app you already have**, with a real icon, no bookmark theatre.
- **It removes surface** rather than adding it: no Form to create, no `_form_responses` tab, no `FormApp` dependency in `setup()`.

The ingest is unchanged and still earns its place, because it runs unattended and repeatedly: the daily trigger reads unprocessed `cash_entry` rows, appends them to `transactions` with `source=manual` and a real `uid`, and marks them done. ~15 lines in `05_sync.gs`.

The tradeoff is honest: a spreadsheet grid is fiddlier to type into than a form, and offline edits appear only after the app syncs. I'd take both over "doesn't work when I need it".

**A Google Form stays documented as an optional extra** for anyone who prefers it and always has signal — it's genuinely nicer to fill in, and the same ingest handles it. Just not the default.

**And the zero-effort option, stated plainly:** don't itemise cash at all. Your ATM withdrawal is already captured automatically by the bank sync as a single expense; you simply don't track where those €100 went. Cash is the highest-friction part of every PFM system and the first thing people abandon — going in knowing that beats building an elaborate capture flow you stop using in March. Start here, and add `cash_entry` only if you find you actually miss the detail.

**Manual `uid`s need a nonce.** Unlike bank rows there's no `entry_reference`, and unlike CSV import there's no batch to compute an ordinal against — two €3 coffees on the same day are genuinely two transactions. So manual uids hash in a monotonic counter from Script Properties. Without it the second coffee silently vanishes.

### What it looks like in the sheet

`accounts` gets a `cash:wallet` row sitting alongside the bank rows, its balance ticking down as you log spends. The dashboard needs no special-casing: net worth sums every `include_in_net_worth` row regardless of `kind`, spend-by-category includes cash spend automatically, and the health strip skips non-bank accounts when computing "oldest consent" because they have none. The only visible difference is a `MANUAL` badge in the accounts list and a "last updated N days ago" nudge on `asset` rows — a brokerage value you last touched in March is the one thing here that goes stale invisibly.

---

## Multi-currency: do the contract now, the machinery later

You asked whether it's hard to add later, or better added now. The answer is a split, because the expensive part of multi-currency isn't the FX — it's the column your whole analytics layer reads.

**What's genuinely cheap to defer.** ECB publishes free daily euro reference rates with no API key and no auth — I verified all three feeds are live: [daily](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml), [90-day](https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml), and **full daily history back to 1999**. That last one matters: it means retrofitting is never data-loss. A transaction from eight months ago can always have its correct historical rate recovered. So the FX plumbing — one tab, one extra UrlFetch per day, one lookup formula — is genuinely a "later" item, maybe 30 lines.

**What's expensive to defer.** If reports read `amount`, then switching to converted values later means touching *every* formula in the dashboard, cashflow, recurring detection and category rollups — and any frontend you build on top. Changing the meaning of the column your whole analytics layer depends on is invasive precisely because it's everywhere.

**So: add the column now, not the machinery.**

- `amount_eur` column ships in v1, populated as `= amount` when `currency = EUR`, blank and flagged otherwise
- **every report reads `amount_eur` from day one** — never `amount`
- turning on real multi-currency later is then purely additive: add an `fx` tab, add the ECB fetch, backfill the non-EUR rows from `eurofxref-hist.xml`. Zero changes to the dashboard, cashflow, recurring, or any frontend.

About fifteen minutes now converts a migration that touches everything into one that touches nothing.

**And it may never bite at all.** The subtlety with Revolut is that a foreign-currency *spend* from a EUR account already arrives converted to EUR by Revolut — that's not a multi-currency problem. It only bites if you hold an actual GBP or USD *balance* as a separate Revolut currency account. Whether you do is answerable from live data, so the phase 3 provider probe checks it alongside balance types. If you don't, the blank-`amount_eur` case never fires and there's nothing to build.

Until then the `_anomalies` `non_eur` entry plus a dashboard warning count means non-EUR rows are visibly excluded rather than silently mis-summed — wrong-but-loud beats wrong-and-quiet.

---

## Automatic categorisation

Yes — and it gets good without any ML or paid API, because the BudgetBakers import hands us years of *your own* labelled data. That's a better training signal than any generic ruleset.

It's a **cascade**, first hit wins, and each row records which tier decided it in a `category_source` column so you can always answer "why is this Groceries?":

| # | Tier | How it works | Maintenance |
|---|---|---|---|
| 1 | `category_override` | You typed it. Always wins. | — |
| 2 | Transfer detection | Paired legs get `type=transfer` and leave spending reports entirely | none |
| 3 | **Learned memory** | `merchant_key` → most-frequent category, mined from your history | self-improving |
| 4 | MCC rules | `merchant_category_code` → category, language-independent | none |
| 5 | Text rules | contains/regex on description | occasional |
| 6 | Unclassified | goes to a review queue — **not** silently "Other" | you, rarely |

**Tier 3 is the workhorse.** `normalizeMerchant()` strips the noise Italian bank descriptors are full of — dates, card suffixes, auth codes, city names, `PAGAMENTO POS`/`OPERAZIONE` prefixes — reducing `PAGAMENTO POS 12/03 CARTA *1234 ESSELUNGA SPA TORINO` to `esselunga`. A `_memory` tab maps that key to the category you've most often given it, built by `deriveRules()` from the imported history. It's a lookup, not a model: a dozen lines, fully unit-testable, no external calls.

**Tier 4 is a bonus, not a foundation.** MCC is a clean standardised signal when present, but PSD2 banks populate it inconsistently and I could not find authoritative data on how often Italian banks do. So MCC rules fire when the field exists and cost nothing when it doesn't — which is why the learned memory sits *above* it rather than depending on it.

**Tier 6 is what keeps it honest.** Unclassified rows surface as a `needs_review` count on the dashboard rather than being dumped into "Other", where miscategorised spending goes to die. When you fix one, `learnFromCorrection()` writes the merchant key into `_memory`, so that merchant is automatic forever after. That's the whole feedback loop, and it means the review queue shrinks toward zero on its own.

Realistically: after importing your history, tier 3 should catch the large majority of transactions on day one, and the queue should be a handful of genuinely-new merchants a month.

**Deliberately not included: LLM categorisation.** Calling Claude for unknown merchants would work and would cost pennies, but it adds an API key, an external dependency and a per-row cost to something whose whole premise is free and maintenance-free — and tier 3 makes it largely unnecessary. `docs/` will note it as an opt-in hook for anyone who wants it, defaulting off.

---

## Importing BudgetBakers history

You were right about this one too. I had a chunked importer with a resume cursor in Script Properties — for an operation **you run once, ever**. That's the definition of over-engineering, and it was solving problems the spreadsheet already solves.

**Revised: no import code at all.** It becomes a documented procedure plus a formula-driven staging tab.

1. **File → Import** the BudgetBakers CSV into `_import_raw`. Native Sheets, no code, no 6-minute limit, no chunking, no cursor.
2. `_import_staged` is a formula tab that reads `_import_raw` and produces properly-shaped rows: `INDEX/MATCH` against `_import_map` for columns, `_category_map` for categories, and a flag column marking anything at or after the account's cutoff date.
3. You eyeball it — including *seeing exactly which rows are excluded as overlapping* rather than trusting a log — select the good rows, and paste-values into `transactions`.

Three complications from the earlier design evaporated:

- **No hashing needed.** The whole reason imported rows needed a SHA-256 `uid` was dedup against API rows — but we already established that can't work across sources, which is why the cutoff exists. So imported rows use a plain readable key: `csv:budgetbakers:<filename>#<row>`. A formula can build that; `Utilities` isn't involved.
- **No amount/date parsing code.** Set the spreadsheet locale to Italy and Sheets natively parses `1.234,56` and `dd/mm/yyyy` on import. The parsing I was going to write and unit-test is a locale setting.
- **No chunking.** Paste-values doesn't time out.

Still preserved: **transfers** (BudgetBakers marks pairs → `transfer_group`, so historical inter-account moves stay netted), and **your categories** via `_category_map` — which is the real prize, because it feeds the learned memory in tier 3 of the cascade.

`deriveRules()` stays in code, but it belongs to categorisation, not import: it groups thousands of rows by normalised merchant and counts frequencies, it runs repeatedly as you correct things, and it's genuinely painful in formulas. It lives in `07_categorize.gs`.

The mapping tabs survive because BudgetBakers' export columns vary by app version and locale, and I could not verify the current header list from a primary source — their support page returns 403 to automated fetches. Mapping-by-formula is the safety net for me being wrong, and it costs nothing.

Same procedure covers Satispay, DeGiro, or any bank Enable Banking can't reach — `~/development/satispay-csv-transformer/` suggests that'll get used.

---

## Backups and bad-edit protection

Partly provided by Sheets, but there's a real gap and one failure mode that version history doesn't save you from.

### What Sheets gives you free

| Feature | Reality |
|---|---|
| Version history | **On a free account: 30 days *or* 100 versions, whichever comes first.** Revisions older than 30 days also get merged/condensed. |
| Named versions | Capped at **15** per spreadsheet |
| Undo | Session-scoped only |
| Trash | 30 days after deletion |
| Cell edit history | Right-click → Show edit history, per cell |
| Protected ranges | Programmable from Apps Script |
| Data validation | Prevents garbage in dropdowns |

**The 30-day/100-version limit is the problem.** A daily sync plus your own edits burns through 100 revisions in a couple of months. If you discover in June that something went wrong in March, version history will not have it — and this is financial history you want to keep for years. That's a real gap, and it's worse on free accounts than on Workspace.

### The failure mode that matters most isn't a script bug

It's **a sort, or an inserted column.** If you sort a *subset* of `transactions`, or insert a column mid-sheet, row identity and every formula reference break simultaneously and silently. That's the classic spreadsheet catastrophe, and no amount of careful script-writing prevents it because it isn't the script doing it.

The structural fix, which costs nothing: **`transactions` stays in insert order forever and is never sorted.** All viewing, sorting and filtering happens through filter views or `QUERY()` on other tabs. That removes the failure mode rather than mitigating it, and it's why the dashboard is formula-driven off `transactions` rather than being a rearrangement of it.

### What gets built

1. **Protected ranges, applied by `setup()`.** `range.protect().setWarningOnly(true)` on the machine-owned columns A–O, every formula column, and the `_` tabs. Deliberately **warning-only, not locked** — on a single-user sheet a hard lock is just friction, and you legitimately need to fix things sometimes. A confirmation prompt catches the accident without blocking the intent.

2. **Weekly CSV snapshot to a Drive folder.** A trigger exports `transactions` and `accounts` to timestamped CSVs. ~15 lines, runs unattended and repeatedly, so it clears the code-file bar. This is the actual answer to the 30-day limit: point-in-time files going back indefinitely, diffable, and independent of revision history. It also means a corrupted sheet is recoverable from a clean file rather than from a merged revision.

3. **Row-count regression guard — failure mode 6.** `_runs` already records row counts. If the count *decreased* since the last run, that's never legitimate in an append-only tab: alert loudly and don't proceed. Cheap, and it catches both accidental deletions and a destructive bug on the first occurrence rather than the fiftieth.

4. **Append-only, reconsidered as a safety property.** It was chosen for simplicity, but it's also the main reason the blast radius here is small: code can add rows, never mutate them. So the worst a script bug can do is append junk — visible and deletable — rather than silently rewriting history, which would be invisible and unrecoverable.

### One thing to be careful about, given the repo goes public

**Never commit data.** `.gitignore` covers `*.pem`, `*.csv`, and any export or snapshot. Committing a transaction history to a public GitHub repo is a one-command, irreversible mistake, and it's exactly the sort of thing that happens at 1am during a `git add -A`. The README will say this in as many words.

For genuinely off-Google backup, the honest note is that Drive snapshots are still Google — if the account itself is lost, they go with it. A periodic **File → Download → xlsx** kept somewhere else covers that, and it's a manual step I won't pretend to automate.

---

## Monitoring

Six distinct failure modes. Each needs its own detector, because none of them catches the others.

| # | Failure | Detector | You find out via |
|---|---|---|---|
| 1 | Script threw | Apps Script's built-in trigger failure email (set to *notify immediately*), plus the Executions panel which logs every run with status and duration | Email, same day |
| 2 | One bank broke, others fine | per-account try/catch → `_status.last_error`, run marked `PARTIAL` | `_status` + dashboard strip |
| 3 | Consent expiring / expired | `valid_until` → `days_left`; alert at ≤7 days; catch `EXPIRED_SESSION` at runtime | Email with a one-click re-auth link |
| 4 | Runs "fine" but returns nothing | `rows_fetched` in `_runs`; 0 rows across all accounts for 3 consecutive days → alert | Email |
| 5 | Never ran at all | `selfCheck()` on a **separate** trigger, reads `_runs` only, emails if `last_success` older than threshold | Email |
| 6 | **Rows disappeared** | row count in `_runs` went *down* — never legitimate in an append-only tab. Alert and abort the run. | Email, immediately |

Failure 4 is the one that quietly ruins these systems — a green run that silently fetched nothing. Failure 5 is why `selfCheck` is its own trigger. Failure 6 is the data-loss detector, and it catches accidental deletions as readily as destructive bugs.

**Honest limit of the chosen approach:** `selfCheck` catches `syncAll` being broken, hung or crashing. It cannot catch *both* triggers being deleted or the whole project being disabled — nothing inside the script can report that the script isn't running. An external dead-man's switch (healthchecks.io, free) is the only fix, and it's deliberately out of scope to keep third-party setup at zero. `docs/MONITORING.md` will document it as a ten-line opt-in for anyone who wants it.

**Rate-limit budget is tighter than it looks.** Most ASPSPs cap unattended fetching at **4 calls/day per account**, answering `ASPSP_RATE_LIMIT_EXCEEDED` with a ~6h penalty. A full sync of one account is **3 calls** — balances, booked, pending. That leaves exactly one spare, so a single impatient "Sync now" after the nightly run can trip the limit. Mitigations: `_status` tracks calls-per-account-per-day, "Sync now" warns before exceeding, pending fetch is skippable per account via `_config`, and 429s are logged `PARTIAL` and left for the next day — never retried in-loop.

**Alert volume is capped.** `MailApp` allows 100 recipients/day on a free account (1,500 on Workspace) and `MailApp.getRemainingDailyQuota()` reports what's left. Daily triggers make ~5 emails/day the realistic ceiling, but alerts are deduplicated by `kind + account` per 24h anyway, so a persistent failure sends one email a day rather than one per detector. An alarm system that burns its own quota and goes silent is worse than no alarm.

---

## Setup, as the README will tell it

Deliberately split so you can prove it works before doing any paperwork.

**Part 1 — sandbox, ~5 minutes, no paperwork**
1. Create a blank Google Sheet → Extensions → Apps Script → set the sheet locale to Italy
2. Paste the files from `src/` (or `clasp push` — optional dev path)
3. Deploy → Web app → copy the `/exec` URL
4. Register a **sandbox** app at Enable Banking (name + that redirect URL is all it asks), download the `.pem`
5. Run `installCredentials()` → prompts, stores to Script Properties with `EB_ENV=SANDBOX`
6. Sheet menu → **Setup sheet** → builds every tab
7. Sheet menu → **Connect a bank** → pick Mock ASPSP → fake SCA → transactions land ✅

At this point you've seen the whole thing work end to end without registering a production app or handing over any real credentials.

**Part 2 — production, once you're convinced**
8. Register a **production** app: same redirect URL, plus description, data-protection email, and the `PRIVACY.md`/`TERMS.md` URLs from the repo
9. Download its `.pem`, re-run `installCredentials()`, flip `EB_ENV=PRODUCTION`
10. Sheet menu → **Connect a bank** → your real bank → SCA on your phone. This is what moves the app from *Inactive* to *Restricted* — the free tier's terminal state.
11. Repeat for each bank
12. Sheet menu → **Install triggers** → daily sync + daily self-check

Menu: Setup sheet · Connect a bank · Sync now · Re-categorise all · Learn from corrections · Detect recurring · Rebuild cashflow · Health check · Run smoke tests · Install triggers.

No "Add manual account" (you type a row) and no "Import CSV" (File → Import, then paste-values) — both are documented procedures rather than buttons.

Contributors additionally get `npm install && npm test`. Users never need Node.

---

## Build order

Each phase ends somewhere verifiable — nothing depends on a bank connection until phase 3.

1. **Repo + scaffold + test harness** — the full sequence above: rename the folder, `git init -b main`, repo-local git identity, `.gitignore` first, then docs/manifest/`00_config`/`03_setup`/`10_menu`/`tests/harness.mjs`/CI, `docs/PLAN.md`, remote, first push, description + topics. Verify: `setup()` builds all 19 tabs (15 listed above plus `_import_raw`, `_import_staged`, `_form_responses`, `_tests`), seeded and formatted, re-running changes nothing; `npm test` green on a first trivial test.
2. **API client, against sandbox** — `01_jwt`, `02_api`, sandbox app registered. Verify: JWT is accepted, `listBanks()` returns a list, Mock ASPSP fetches transactions end to end. All code paths proven before any real credential is involved.
3. **Consent flow + production restricted** — `04_auth` + web app deploy, production app registered and moved to Restricted by linking Revolut. Verify: session lands in `_status` with a real `valid_until`. **Then run the provider probe**, which sandbox cannot answer: which balance types each bank returns, whether `entry_reference` and `merchant_category_code` are populated, each bank's real max consent duration, and whether any non-EUR Revolut balances exist. Findings go into `docs/PROVIDERS.md` and settle four of the open assumptions.
4. **Sync + dedup + pending** — `05_sync`, `06_dedup`. Backfill uses `strategy=longest` on first run, because full history is only reachable for ~1h after authorization and drops to a rolling ~90 days after that. Verify: rows land; re-running inserts 0 duplicates; a pending row that settles produces exactly one booked row and no orphan.
5. **Manual + cash accounts** — no new code file: `accounts` gets the `balance` ARRAYFORMULA, plus `cash_entry` ingest inside `05_sync`. Verify: a cash wallet's derived balance tracks its entries; an ATM withdrawal pairs Fineco↔cash and nets to zero; two identical same-day coffees both survive; **an entry typed offline in the Sheets mobile app arrives after sync**.
6. **BudgetBakers import** — `_import_staged` formulas + `docs/IMPORT.md`. Needs your actual export file to finalise the mapping. Verify: history lands, overlapping rows visibly flagged and excluded, historical transfers netted, category map applied.
7. **Categorisation cascade** — `07_categorize`, `_memory`, `deriveRules()`, `learnFromCorrection()`. Runs after import so it has your labelled history to learn from. Verify: tier-3 memory hit rate on your own data; correcting a row makes that merchant automatic; unclassified lands in review, not "Other".
8. **Monitoring + backups** — `09_monitor`, protected ranges in `setup()`, weekly CSV snapshot trigger. Verify: force each of the 6 failure modes and confirm the right email arrives — using **Mock ASPSP** on the sandbox app to produce genuine `EXPIRED_SESSION` and 429 responses rather than faking them by editing sheets. Staleness, never-ran and row-loss get simulated by clock/row manipulation, since no API can produce those. Also confirm editing a protected column raises a warning, and that a snapshot CSV lands in Drive.
9. **Recurring + cashflow + dashboard** — `08_recurring`. Verify: salary and known subscriptions detected with correct cadence; 90-day projection populates.
10. **Docs** — README, SETUP, IMPORT, MONITORING, SHEET-SCHEMA, PROVIDERS, CONTRIBUTING.

The test harness lands in phase 1 rather than later so that every subsequent phase has somewhere to put its tests. Phases 2 and 3 are the thinnest coverage — network and OAuth are stubbed, so what's tested there is request construction and error mapping, not real calls.

Import lands before both categorisation and recurring detection deliberately. The cascade's learned memory is trained on your imported history, and cadence detection over years of it is dramatically better than over the ~90 days PSD2 gives us — the cashflow forecast is only as good as the recurrence data under it.

Then connect Fineco (all accounts — one consent covers every payment account under a single login; separate logins mean separate consents) and illimity.

**What I need from you:** a BudgetBakers CSV export (even a 20-row sample is enough) so the `budgetbakers` preset maps to your real headers instead of my guess.

**illimity caveat, designed around:** Banca Ifis took illimity to 92.5%, delisted it Sept 2025, and completes full integration in **autumn 2026** — months away. Its connector will move or die. Provider identity is one field in `accounts`/`_status`, so migrating is a config edit, and the transaction history is unaffected either way.

## Verification

- `npm test` green in CI on every phase's PR; the table above is the floor for coverage, not the ceiling
- `setup()` idempotency: run twice, diff the Sheet — no change
- Dedup: run `syncAll()` three times in a row → `rows_inserted` 0 on runs 2 and 3
- Consent expiry: hand-set a `valid_until` to tomorrow → expiry email fires
- Staleness: hand-set `_runs.last_success` back 5 days → `selfCheck()` emails
- Rate limit: assert 429 is logged `PARTIAL`, not retried in-loop
- Transfers: seed a matched pair, confirm net-zero in the category report
- Import totals: monthly spend-by-category for a past month must match what BudgetBakers reports for that same month. This is the real test of the import — if the numbers don't tie out, the mapping or the sign convention is wrong.
- Import overlap: with a file covering dates the bank already supplied, `_import_staged` visibly flags those rows as excluded before you paste anything
- Categorisation hit rate: measure what fraction of your real transactions tier 3 resolves. If it's low, `normalizeMerchant` is over- or under-stripping, and that's the thing to tune before adding text rules.
- Feedback loop: correct one unclassified row, run "Learn from corrections", confirm the next transaction from that merchant categorises itself
- Sign sanity: pick a known expense in the bank's own app and assert it is **negative** in the sheet. Then an overdrawn or negative balance, and assert net worth went *down*. These two catch the `credit_debit_indicator` bugs, which no unit test can prove against real provider data.
- Pending lifecycle: capture a pending card payment, wait for it to settle, assert exactly one row in `transactions` and none left in `pending`
- Cash: log two identical €3 entries same day → two rows, both present
- Row-loss guard: delete a row by hand, run `syncAll()` → alerts and aborts rather than carrying on
- Protected ranges: try typing into `transactions` column G → warning prompt appears
- Restore drill: actually restore from a weekly snapshot CSV into a blank sheet and confirm the dashboard rebuilds. An untested backup isn't a backup.
- Cold start: on a throwaway free Gmail account, follow the README verbatim and time it. If it takes more than ~10 minutes or needs a step not in the README, the README is wrong, not the user.

---

## What's verified vs. assumed

Since this plan is now load-bearing for a build, here's the confidence split.

**Verified against primary docs:** Enable Banking restricted-production is free for self-linked accounts and persists until an agreement is signed · environment is fixed at app registration (SANDBOX or PRODUCTION), separate app IDs and keys, same base URL, `kid` implies environment · production lifecycle Inactive → Restricted → Active, with Active requiring a contract + company KYB we neither want nor qualify for · sandbox registration needs only name + redirect URLs, production additionally needs description, data-protection email, privacy and ToS URLs · Mock ASPSP is a control-panel-configurable simulator · aggregation API is snake_case (the camelCase docs belong to their separate self-hosted TPP API v1) · `transaction_amount.amount` is a string · `credit_debit_indicator` is `CRDT`/`DBIT` and carries the sign · `remittance_information` is a string array · `merchant_category_code` exists · `entry_reference` is booked-only, not globally unique, sometimes duplicated, sometimes absent · balance enum is CLBD/FWAV/ITAV/ITBD/OTHR/VALU/XPCD and `Balance` has its own indicator · consent up to 180 days, `EXPIRED_SESSION` on early death · ~4 unattended calls/day/account, `ASPSP_RATE_LIMIT_EXCEEDED`, ~6h penalty · full history ~1h post-auth then rolling ~90 days · JWT is RS256 with `kid`/`iss`/`aud`/`iat`/`exp` · Apps Script quotas (6 min, 90 min/day triggers, 20k UrlFetch, 100 mail recipients/day on free) · `Utilities.computeRsaSha256Signature` and `MailApp.getRemainingDailyQuota` exist · **Google Forms has no native mobile app and cannot submit offline**, whereas Sheets does have offline mode — which is why cash entry uses a Sheets tab, not a Form · **Sheets version history on a free account is 30 days or 100 revisions, whichever comes first**, with named versions capped at 15 — which is why weekly CSV snapshots exist · `Range.protect().setWarningOnly(true)` is available from Apps Script · GoCardless/Nordigen free tier closed to new signups · illimity delisted Sept 2025, Ifis integration completing autumn 2026 · Revolut has an Enable Banking connector · Fineco is behind CBI Globe · all three ECB FX feeds live, no auth, daily history back to 1999.

**Assumed, resolved by the phase 3 provider probe** (production restricted — sandbox cannot answer these, since it exposes only a limited set of bank sandboxes): that Fineco and illimity appear by name in the ASPSP list (Fineco is very likely via CBI Globe; neither is confirmed by name in published material) · which balance types each bank returns · whether each populates `entry_reference` and `merchant_category_code` · actual max consent duration per bank · whether any non-EUR Revolut balances exist · that a `script.google.com/…/exec` URL is accepted as a redirect URL in their control panel.

**Known unverified:** the BudgetBakers CSV header list — their support page returns 403 to automated fetches, so the `budgetbakers` preset is built from your actual export file in phase 6, not from my guess. This is why the importer is mapping-driven rather than hardcoded.
