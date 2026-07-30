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
| Rows you add, edit or delete in `rules`, `categories`, `_config`, `_import_map` | kept as-is |
| Anything in a column marked *yours* — `category_override`, `notes`, `excluded`, `balance_manual` | never written by code |
| Column widths, conditional formatting, filter views, charts, notes | not touched at all |
| Unhiding a `_` tab | respected — tabs are hidden only on the run that creates them |

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

### Formulas and yours (P–Z)

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

`amount_eur` is blank rather than unconverted for non-EUR rows, on purpose: a GBP figure summed as though it were EUR looks entirely plausible and is silently wrong. Blank plus an `_anomalies` entry plus a dashboard count is wrong-but-loud. Enabling real FX later changes this one formula and nothing downstream.

`type` is derived, never stored, so recategorising a row fixes its type for free — and it's what keeps transfers out of spending reports.

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

Three balance columns rather than one is what lets you **add a manual account by typing a row** — no script, no menu item. `balance` is a single `ARRAYFORMULA` written once by `setup()` covering every row you'll ever add:

```
kind = bank  → balance_api
kind = cash  → opening_balance + SUMIF(transactions, this account, amount_eur)
kind = asset → balance_manual
```

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

Manual entries have neither an `entry_reference` nor a batch to count against, so their uid includes a monotonic counter from Script Properties.

---

## Categorisation tabs

**`rules`** — `priority` · `field` (description/counterparty/mcc/bank_transaction_code) · `match_type` (contains/regex/equals) · `pattern` · `account_filter` · `category` · `subcategory` · `type` · `enabled`. First match by priority wins. Seeded with MCC mappings (10–99, language-independent) then Italian text patterns (100+).

**`categories`** — `category` · `subcategory` · `kind` · `icon`. Drives the dropdowns, and `kind` is what `type` is derived from.

**`_memory`** — `merchant_key` · `category` · `subcategory` · `hits` · `last_seen`. The learned table, and the workhorse of the cascade. Built from your imported history and extended every time you correct a row.

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
| `_tests` | smoke test results |

`_runs` is what powers the row-count regression guard: if the row count *decreased* since the last run, that's never legitimate in an append-only tab, so the sync alerts and aborts rather than carrying on.

---

## Other tabs

**`recurring`** — written by `detectRecurring()`. **`cashflow`** — 90-day forward projection. **`dashboard`** — the Wallet-like view, formula-driven, with a health strip in row 1 so status lives where you already look. **`cash_entry`** — `date` · `account` · `amount` · `category` · `note` · `processed`, with dropdowns, designed for the Sheets mobile app; drained into `transactions` by the daily trigger.

Cash entry is a Sheets tab rather than a Google Form because **Forms has no native mobile app and cannot submit offline at all**, whereas Sheets has a real offline mode. Logging a €3 coffee happens standing in a bar, sometimes with no signal.
