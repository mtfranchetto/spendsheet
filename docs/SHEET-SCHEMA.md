# Sheet schema

Nineteen tabs, all built by `setup()`. This documents what each one holds and — more importantly — **who owns each column**, because the whole design rests on code and formulas never writing to the same cell.

`_`-prefixed tabs are machinery and are hidden. Unhide them freely; nothing breaks.

## The core contract

On `transactions`:

> **Columns A–O are owned by code. P onward are owned by formulas and by you.**
> Sync only ever appends. It never rewrites a row.

That single rule is what makes manual corrections safe, keeps the sync logic trivial, and bounds the blast radius of a bug — the worst a broken script can do is append visible junk, never silently rewrite history.

Two further rules that cost nothing and remove entire categories of failure:

- **`transactions` is never sorted.** Sorting a *subset* of it, or inserting a column mid-sheet, breaks row identity and every formula reference simultaneously and silently. No amount of careful scripting prevents this, because it isn't the script doing it. Sort and filter through filter views or `QUERY()` on another tab instead. This is also why the dashboard is formula-driven off `transactions` rather than being a rearrangement of it.
- **Every report reads `amount_eur`, never `amount`.**

## Customising it, and what `setup()` does on a re-run

`setup()` is meant to be re-run — after an upgrade, or any time you think something's out of shape. It creates what's missing and reasserts what code owns. It is not a reset.

**Safe. Survives every re-run:**

| | |
|---|---|
| Extra columns **appended to the right** of the last schema column | untouched |
| Whole tabs you create yourself | untouched — not reordered ahead of yours, not deleted |
| Rows you add, edit or delete in `rules`, `categories`, `_config`, `_import_map`, `_category_map` | kept as-is — see below |
| Anything in a column marked *yours* — `category_override`, `notes`, `excluded`, `balance_manual` | never written by code |
| Column widths, conditional formatting, filter views, charts, notes | not touched at all |
| Unhiding a `_` tab | respected — tabs are hidden only on the run that creates them |

### When the defaults move underneath you

`setup()` adds seed rows your sheet is missing and **never changes one it already has**, because it cannot tell a mapping you edited from one an older version wrote. It does now say when they disagree:

> `1 seeded row(s) differ from the defaults (unchanged):`
> `  budgetbakers / Child Support: you have "Other / Uncategorised", default is "Income / Child support"`

with the full list in `_anomalies`, since a toast lasts ten seconds.

That was a dead end on its own. When the taxonomy shrank from fifteen top-level categories to twelve, eleven mappings still pointed at parents that no longer existed, and retyping them was the only remedy on offer.

**Spendsheet → Update mappings to defaults** is the other half. It shows every divergence side by side — yours, then the default — and replaces them only if you say yes. Keys are never touched, so nothing is added or removed; only the answer part of a row you already have changes, and any key not in the defaults is left alone entirely.

It also names **orphans**: mappings pointing at a category that isn't in `categories` at all. Those it leaves for you, because they may be yours. They're worth knowing about because the failure is silent — the override gets written, and every report that groups by category simply never shows it.

**Reasserted. Your change is reverted:**

| | Why |
|---|---|
| Header row text | code addresses columns by position and reads row 1 to confirm the contract. A renamed header makes the sheet lie about itself |
| The formulas in `amount_eur`, `category`, `subcategory`, `type`, `balance` | these are the contract, not decoration |
| Number formats on date and amount columns; bold header styling | cosmetic, rewritten each time |
| Data validation on the dropdown ranges | |
| Tab order of the nine main tabs | your own tabs keep their relative position after them |

**Seed data has a deliberate middle behaviour.** `rules`, `categories`, `_config` and `_import_map` are seeded **only when the tab has no data rows**. So editing or deleting individual rules is permanent — but empty the tab completely and re-run, and you get the defaults back. That's the intended way to reset a tab you've made a mess of.

### The one thing that will hurt you

**Never insert a column in the middle of a schema tab.** Appending to the right is fine and supported; inserting shifts every column after it, so code writing to "column G" writes to what is now the wrong field, and `setup()` will relabel row 1 to match positions that no longer hold what the labels say. Nothing errors. The data just quietly becomes wrong.

The same applies to sorting `transactions` — see below.

If you want a different column order for reading, build it on another tab with `QUERY()`. That's what the dashboard does, and it's why the dashboard is formula-driven rather than a rearrangement of the source.

---

## `transactions` — the record of truth

Append-only. **Booked transactions only** (see `pending` below).

### Written by sync (A–O)

| | Column | Notes |
|---|---|---|
| A | `uid` | SHA-256. See [dedup](#deduplication) |
| B | `account_id` | |
| C | `account_name` | denormalised for readability |
| D | `booking_date` | |
| E | `value_date` | |
| F | `transaction_date` | |
| G | `amount` | **signed** — negative is money out |
| H | `currency` | |
| I | `description` | `remittance_information` joined and whitespace-normalised |
| J | `counterparty` | the opposite side, picked by direction |
| K | `entry_reference` | the bank's own ID. Booked-only, and absent at some banks |
| L | `bank_transaction_code` | distinguishes fees, SDD, standing orders, reversals |
| M | `mcc` | `merchant_category_code`, when the bank populates it |
| N | `source` | `enablebanking` \| `csv:<name>` \| `manual` |
| O | `imported_at` | |

`source` is what lets imported history, manual cash entries and API rows share one timeline without union queries — and lets any one source be re-imported independently.

### Formulas and yours (P–AC)

| | Column | Owner | Notes |
|---|---|---|---|
| P | `amount_eur` | formula | **what every report reads.** `= amount` when the currency matches, blank otherwise |
| Q | `category_auto` | cascade | tiers 2–5 |
| R | `subcategory_auto` | cascade | |
| S | `category_source` | cascade | which tier decided — `override`/`transfer`/`memory`/`mcc`/`rule`/`unclassified` |
| T | `category_override` | **you** | code never touches this |
| U | `category` | formula | override if present, else auto |
| V | `subcategory` | formula | blank when you override — a subcategory from a different parent rolls up wrongly |
| W | `type` | formula | `expense`/`income`/`transfer`, from the category's `kind` |
| X | `transfer_group` | cascade | pairs the two legs of an internal move |
| Y | `notes` | **you** | |
| Z | `excluded` | **you** | drop a row from reports without deleting it |
| AA | `labels` | **you** | comma-separated, cross-cutting. Never affects a total |
| AB | `confirmed` | **you** | you agreed with the category. The only rows memory is learned from |
| AC | `in_reports` | formula | whether the row counts as spending. **Every money block reads this** |

`amount_eur` is blank rather than unconverted for non-EUR rows, on purpose: a GBP figure summed as though it were EUR looks entirely plausible and is silently wrong. Blank plus an `_anomalies` entry plus a dashboard count is wrong-but-loud. Enabling real FX later changes this one formula and nothing downstream.

`type` is derived, never stored, so recategorising a row fixes its type for free — and it's what keeps transfers out of spending reports.

**`in_reports` is the one place that decides what counts as spending**, and it exists because there used to be six. Every dashboard block filtered `type <> 'transfer'` and nothing else, so `excluded` — a documented column you can tick — was honoured by recurring detection and by nothing you actually look at. A row you had deliberately excluded still counted in this month's spending, in the trend, and in every label total.

It is a column rather than one more condition per query for a reason worth knowing before you write another report: `excluded` is blank on nearly every row, and `QUERY` infers a column's type from what is in it and treats blanks as null. `where Z = false` would drop nearly every row and blank the whole block. A formula that emits a real boolean on **every** row — including the ones with no transaction in them — removes both the null case and the majority-type case. That is also why the empty rows say `FALSE` rather than `""`: on a new book, thirty booleans among nine hundred empty strings is a *text* column, and `= true` would match nothing.

Tick `excluded` on a row and it leaves every report at once. Nothing else changes; the row stays exactly where it is.

**`confirmed` is what separates a guess you agreed with from a guess.** Synced rows arrive blank; imported rows arrive ticked, because you categorised them once already in the tool they came from. A row carrying a `category_override` counts as confirmed without the tick — typing the category is a stronger statement than ticking a box next to it.

It earns a column rather than being inferred because **`Learn from corrections` reads confirmed rows and nothing else.** Learn from everything and the cascade trains on its own output: one wrong guess about a frequent merchant becomes a memory entry, which produces more rows carrying that guess, which reinforces the entry. The review queue is the side benefit, not the reason.

Confirming a row also **freezes** its `category_auto`. Re-categorising later leaves it exactly as it was, so a rule change can never silently move a row while the tick still claims a human agreed with where it ended up.

---

## `pending` — everything not yet booked

Columns A–O only, identical to `transactions`. **Truncated and rewritten in full on every sync.** No merging, no matching, no user-owned columns.

This looks blunt but it solves an otherwise unsolvable problem. `entry_reference` is returned **only for booked transactions** — banks expose one for a pending row only when they can guarantee it survives settlement, which most don't. So for most banks there is literally nothing to match a pending row against when it settles, and its amount, date and description can all change on the way (card hold → settlement, FX, tips).

So pending never enters the history. When a transaction settles it arrives in the booked feed with its own `entry_reference` and is inserted normally; its pending row simply isn't in the next response, so it disappears. No duplicate, no rewrite, append-only intact.

**The tradeoff, stated plainly:** a transaction that stays pending for three days isn't in `transactions` for those three days. That's deliberate — it means your category totals don't wobble as holds settle at different amounts. The `pending` tab and the dashboard's "in flight" tile cover the visibility gap.

---

## `accounts`

| | Column | Owner |
|---|---|---|
| A | `account_id` | you / sync |
| B | `name` | you |
| C | `kind` | you — `bank` \| `cash` \| `asset` |
| D | `provider` | |
| E | `iban_masked` | |
| F | `currency` | |
| G | `opening_balance` | you |
| H | `balance_api` | **code**, bank rows only |
| I | `balance_manual` | **you**, asset rows only |
| J | `balance` | **formula** over all three kinds |
| K | `balance_type` | code — which balance the API gave us |
| L | `balance_updated_at` | code |
| M | `balances_raw` | code — the full typed set, for debugging |
| N | `include_in_net_worth` | you |
| O | `active` | you — untick to stop syncing a closed account without losing its history |
| P | `connection_id` | code — which `_status` consent covers this account |

`connection_id` is at the end rather than next to `provider` on purpose: inserting a column mid-schema renames the headers without moving the data underneath them. Appending to the right is always safe; inserting never is.

**`connection_id` is not the session id**, though it used to be. A session is the API handle and is replaced every time you redo SCA; a connection is the bank link itself and outlives any particular session. It reads like `revolut-it` — the bank, slugified — and a second login at the same bank gets `revolut-it-2`.

Keying on the session id meant a reconnect couldn't find its own row and wrote a second one, leaving a row behind with a dead session and a `valid_until` in the past. That is exactly what the consent-expiry detector looks for, so it would have alerted daily, forever, about a bank that was working. Which id a connection ends up with is decided by `resolveConnectionId_`: **an account already filed under a connection wins**, so re-authorising keeps whatever id that connection already had — including a session-id-shaped one from before this rule existed, which is why an existing sheet needs no migration.

Three balance columns rather than one is what lets you **add a manual account by typing a row** — no script, no menu item. `balance` is a single `ARRAYFORMULA` written once by `setup()` covering every row you'll ever add:

```
kind = bank  → balance_api
kind = cash  → opening_balance + SUMIF(transactions, this account, amount_eur)
kind = asset → balance_manual
```

### An account you no longer use

Common, and it has a right answer that isn't "delete it". A closed bank account, a payment app you moved off, a wallet you stopped topping up — all of them have history that is still true, and history is the thing this system exists to keep.

| | |
|---|---|
| `active` → **FALSE** | the sync skips the row entirely. This is what the column is for |
| `balance_api` → **clear it** | code only writes this for syncable rows, so once `active` is off the last figure sits there forever. A 2024 balance in today's net worth is the actual failure mode here |
| `include_in_net_worth` → **FALSE** | if the account is closed and empty |
| `transactions` | **leave every row** |

Deleting the history costs more than it looks. It understates the years the account was live, so a year-over-year comparison reads as a drop in spending that never happened. And a payment app is an *instrument*, not a destination — the merchants behind those rows are places you still go, and they're training data for the categorisation cascade, which learns merchant → category from labelled history.

The asymmetry is the argument: you can hide a dormant account at any point, but you cannot un-delete its history without redoing the import.

If you do decide to delete rows from `transactions`, the row count goes down, the row-loss detector fires and the next sync **aborts** — by design, since an append-only tab losing rows is never legitimate. Run **Accept row count** from the menu immediately afterwards.

### The two kinds of non-bank account

Conflating these is why manual accounts usually feel awkward in a spreadsheet.

| | `cash` | `asset` |
|---|---|---|
| Example | wallet, house cash | brokerage, car, property |
| You log | every transaction | nothing |
| You update | nothing | one value, occasionally |
| `balance` is | derived from its transactions | typed by you |
| In spending reports | yes | no |
| In net worth | yes | yes |

A cash wallet is a real account whose sync source happens to be a human. A brokerage is a valuation you refresh. `_status` derives `MANUAL / never expires` from `kind`, so neither appears in consent alerts or the rate-limit budget.

### Balances are typed, and can be negative

The API returns **multiple typed balances** per account — `CLBD`, `FWAV`, `ITAV`, `ITBD`, `OTHR`, `VALU`, `XPCD` — and each bank supports only some, so a single balance column can't be filled unconditionally. Sync takes the first available in preference order **CLBD → ITBD → ITAV → XPCD → VALU → FWAV → OTHR**, records which in `balance_type`, and keeps the whole set in `balances_raw`.

A `Balance` object **carries its own `credit_debit_indicator`**, so a balance can itself be a debit figure. Ignoring it would display an overdrawn account as positive and inflate net worth.

`docs/PROVIDERS.md` records what each bank actually returns.

---

## Deduplication

```
uid = SHA256(account_id + "|" + entry_reference)                       when present
    = SHA256(account_id + "|" + booking_date + "|" + amount_signed
             + "|" + normalized_description + "|" + ordinal)          otherwise
```

`entry_reference` is immutable per account but **not globally unique** — the same value legitimately appears on different accounts — so it's always scoped by `account_id`.

**The `ordinal` matters more than it looks.** Two genuine €3 coffees at the same bar on the same day hash identically without it, and one would be silently swallowed — a bug that loses real transactions and is nearly impossible to notice later. The fallback key counts identical tuples within the batch and appends an occurrence index.

The ordinal is stable across syncs because a fetch always covers **whole days**: `date_from` and `date_to` are dates, so a day is either entirely inside the window or entirely outside it, and a day that is inside arrives complete. The same day fetched tomorrow therefore produces the same groups in the same order.

The one case it doesn't cover: two identical transactions where the second settles later *and* the bank sorts it ahead of the first. They swap ordinals, so one row inserts a second time and the other never matches its earlier self. The count stays right — two coffees, two rows — which is why this is a wrinkle rather than something worth carrying per-transaction state to fix.

And because some banks emit bad duplicates: if the same `account_id|entry_reference` reappears with a **different** amount or date, that's a provider bug, not a duplicate. It goes to `_anomalies` rather than being silently dropped or double-inserted.

Cash entries have neither an `entry_reference` nor a batch to count against — two identical coffees can be typed hours apart and drained by different runs, where a within-batch ordinal would give both the same key and silently discard the second. So their uid carries a counter that only ever goes up, kept in Script Properties. The content is hashed in alongside it, so losing the property makes a collision merely possible again rather than certain.

---

## Categorisation tabs

**`rules`** — `priority` · `field` (description/counterparty/mcc/bank_transaction_code) · `match_type` (contains/regex/equals) · `pattern` · `account_filter` · `category` · `subcategory` · `type` · `enabled`. First match by priority wins. Seeded with MCC mappings (10–99, language-independent) then Italian text patterns (100+).

**`categories`** — `category` · `subcategory` · `kind` · `icon`. Drives the dropdowns, and `kind` is what `type` is derived from.

**`labels`** — `label` · `description` · `transactions` · `total_eur`. The cross-cutting axis a category cannot express: `category` answers *what did I buy*, a label answers *what was this for*. The last two columns are formulas over `transactions.labels`, so the tab is both the known set and the report on it.

Labels are comma-separated in one column, many per transaction, and **never affect a category, a `type` or any total** — the moment a label changes a number, two systems own the same fact.

There is deliberately **no dropdown** on `transactions.labels`. A list rule would flag every multi-label row with a warning triangle, which trains you to ignore warnings. The `labels` tab catches a typo instead: the misspelling shows up there with zero transactions against it, next to the real one with all of them.

One caveat, because the report matches by wildcard: **a label that is a substring of another counts both.** `kids` would include `kids-school`. Keep label names distinct.

**`_memory`** — `merchant_key` · `category` · `subcategory` · `hits` · `last_seen`. The learned table, and the workhorse of the cascade. Built from your confirmed history by **Learn from corrections**.

`_memory` is **derived and replaced wholesale**, not merged. A categorisation you want to *impose* belongs in `rules`, which is yours and is never rewritten. `hits` is the count behind the answer given, not the number of times the merchant was seen — twenty rows split 11/9 is not a twenty-row certainty, and the column says so.

See **[CATEGORIES.md](CATEGORIES.md)** for the cascade itself.

---

## Machinery tabs

| Tab | Holds |
|---|---|
| `_status` | one row per connection: `state`, `valid_until`, `days_left`, `last_success`, `last_error` |
| `_runs` | one row per execution: counts, duration, result, message. Trimmed to 500 rows |
| `_anomalies` | `detected_at`, `account_id`, `kind`, `detail`, `raw_json` — where things go instead of being silently dropped |
| `_config` | non-secret settings. **Secrets live in Script Properties, never here** |
| `_import_map` | CSV header → target column, per preset |
| `_category_map` | source category → your taxonomy |
| `_import_raw` | where a CSV lands via File → Import |
| `_import_staged` | formula-mapped rows, ready to paste-values |
| `_removed` | same columns as `transactions`. Rows that **Remove synced duplicates** deleted, so putting one back is a paste |
| `_tests` | smoke test results |

`_runs` is what powers the row-count regression guard: if the row count *decreased* since the last run, that's never legitimate in an append-only tab, so the sync alerts and aborts rather than carrying on.

---

## Other tabs

### Typing a cash entry

`cash_entry` is `date` · `account` · `amount` · `category` · `note` · `processed`, and it is a **form rather than a queue**: you type on the blue row 2, and a simple `onEdit` moves it into `transactions` and empties the row again the moment it has an account and an amount. The sync still drains it at the end of every run, which is the backstop — a simple trigger fails silently, so the row staying put is how a failed one is recovered rather than lost.

**Type the amount without a sign.** A bare number is spending, which is what almost every cash entry is — standing in a bar you type `3`, not `-3`. Picking an **Income** or **Transfer** category counts it the other way, so an ATM withdrawal *adds* to the wallet while the matching debit on the bank side nets the pair to zero. A minus sign you type deliberately always wins, which is how you record cash going back into a bank. The rule is also a note on the `amount` header, visible by tapping it in mobile Sheets.

The category you pick lands in `category_override`, not `category_auto`: you chose it, so the cascade doesn't get to overrule it.

A row missing an account or an amount is **left unprocessed rather than rejected** — on a phone that's someone mid-typing, not an error. It's picked up whenever it's finished, and the run message says how many are waiting so it can't sit there unnoticed. Columns can be filled in any order; a row whose date you haven't typed yet is still visible to the drain.

### `recurring`, `cashflow`, `dashboard`

**`recurring`** — `key` · `account_id` · `category` · `avg_amount` · `cadence_days` · `occurrences` · `last_seen` · `next_expected` · `confidence` · `active`. Rebuilt by **Detect recurring**.

An item needs **three occurrences** at a recognisable cadence. Two is a coincidence: with one gap between them, every pair fits *some* cadence perfectly, so the detector can't tell a subscription from two unrelated payments a month apart.

Weekly, fortnightly, 4-weekly, quarterly and yearly are matched on the **median** gap — one missed payment leaves a double-length gap that would drag a mean far enough to match nothing, and a subscription you paused for a month is still a subscription. Monthly is detected separately, by **day-of-month stability**, because Jan 15 → Feb 15 is 31 days and Feb 15 → Mar 15 is 28. Both explanations are scored and the better one wins; a tie goes to monthly, which is the case where a charge on the 15th also fits 4-weekly exactly.

`active` is **yours**, and it survives a re-detect. It's how you say "yes this repeats, and no, don't forecast it" — and it's the column the projection reads.

**`cashflow`** — `date` · `opening` · `expected_in` · `expected_out` · `closing`, one row per day for `cashflow_horizon_days` (default 90). Rebuilt after every sync, since the balances it starts from have just moved.

Opening is **liquid** balance, not net worth: bank and cash only. A projection asks whether money runs out, and a flat you can't sell by Thursday doesn't stop that happening.

**`dashboard`**, **`reports`** and **`review`** have a page of their own: [`docs/REPORTS.md`](REPORTS.md). The short version is that all three are formulas, checkboxes and dropdowns — never a menu item — because **custom menus, sidebars and dialogs do not exist in the Google Sheets mobile app**, and those are the tabs you open on a phone.

`review` is the only tab in the book with a schema you have not seen: `uid` · `booking_date` · `account_name` · `description` · `amount_eur` · `guess` · `why` · `confirmed` · `category_override` · `status`. `uid` is hidden and is not for reading — it is the pointer that lets a tick written on your phone find the right transaction after the queue has been thrown away and rebuilt.

**`cash_entry`** — `date` · `account` · `amount` · `category` · `note` · `processed`, with dropdowns, designed for the Sheets mobile app. One blue input row, drained on the edit that completes it and again by the daily trigger. `processed` is hidden; the row it stamps is cleared moments later.

**`recent`** — no schema of its own. Two `QUERY` blocks over `pending` and `transactions`, newest first, because `transactions` is append-only and never sorted.

Cash entry is a Sheets tab rather than a Google Form because **Forms has no native mobile app and cannot submit offline at all**, whereas Sheets has a real offline mode. Logging a €3 coffee happens standing in a bar, sometimes with no signal.
