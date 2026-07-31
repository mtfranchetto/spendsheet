# Importing history

There is **no import code**, deliberately. Importing your history is something you do once, ever, and the governing rule of this repo is that code exists only for what runs unattended and repeatedly. Loading a CSV is File → Import; moving the result into `transactions` is a paste. Neither is improved by a menu item that can only fail in new ways.

What the repo does build is the tab in between. `_import_staged` is pure formulas: it reads whatever landed in `_import_raw`, maps it through `_import_map` and `_category_map`, and shows you the result **before** any of it becomes history. You see which rows are excluded and why, rather than trusting a log written afterwards. And when the mapping is wrong — it will be, because every export differs by app version and locale — the fix is editing a tab, not editing code.

The same procedure covers Satispay, DeGiro, or any bank Enable Banking can't reach: add rows to `_import_map` under a new preset name and point `import_preset` at it.

## What a BudgetBakers export actually looks like

Probed against a real one, because it can't be verified from any primary source: their support page refuses automated fetches. The preset shipped before that probe was invention, and **four of its nine rows were wrong**. Worth knowing which, because two of them would have failed silently:

| | |
|---|---|
| **Semicolon-delimited** | so File → Import needs the separator set by hand |
| **The sign is not in the amount** | every amount is positive; direction lives in a `type` column of `Expense`/`Income`. Mapping `amount → amount` alone would have imported every expense as income and inverted the entire sheet |
| **`transfer` is a boolean, not a pair id** | it marks that a row *is* a transfer, not which row it pairs with |
| **Amounts are inconsistently formatted** | `116.87` and `1000` both appear, so nothing may assume a decimal point exists |

Columns deliberately left unmapped: `ref_currency_amount` (identical to `amount` unless you hold a non-EUR account), `payment_type` (the instrument — `Transfer` there means *bank transfer*, not a move between your own accounts, and is easy to confuse with the `transfer` column), `transfer`, and `labels` (free-form tags on a small minority of rows; preserving them would need a third paste block, which isn't worth the chance of misaligning one).

## Before you start

**Name your accounts to match the export.** `_import_staged` resolves each row's `account_id` by matching the CSV's account name against `accounts` column B. Rename your rows there to whatever the export calls them — `Fineco EUR`, `Illimity`, `Revolut` — and the join is free. An account name that doesn't match still imports; it just arrives with `account_name` and no `account_id`, so it won't roll into that account's balance.

**Read `_category_map` first, not afterwards.** Their taxonomy is single-level and ours is two, so the second level is invented in that tab. These become `category_override` — the training signal the whole categorisation cascade learns from in phase 7. A category you wouldn't have chosen teaches the wrong thing about every future transaction from that merchant. Ten minutes there is worth more than any amount of correcting later.

## The steps

**1. Import the CSV into `_import_raw`.**

> File → Import → Upload → select the file → **Import location: Replace data at selected cell**, with `_import_raw!A1` selected → **Separator type: Custom → `;`** → *Convert text to numbers, dates and formulas*: **No**

The last one matters. Left on, Sheets parses each cell using the spreadsheet's locale, and `116.87` in a decimal-comma locale is not a number it recognises. The staged formulas handle both cases — they use the value if Sheets parsed one, and otherwise parse the text themselves by splitting on the dot and reading each side as an integer, because integers mean the same thing in every locale. Turning conversion off just removes the guesswork.

**2. Look at `_import_staged`.**

Every row of `_import_raw` appears. Two columns at the right explain each one:

- **`include`** — whether it's coming through
- **`why`** — in words, when it isn't

Excluded rows are blanked across the whole pasteable block, not merely flagged. So you can copy everything without first remembering to filter, and an excluded row shows its reason and nothing else. A row that looks importable and is only kept out by your attention is a worse design.

The reason you'll see is **"already covered by the API for this account"**. The cutoff is derived, not configured: for each account it's the oldest API-sourced row already in `transactions`. Nothing to set, nothing to keep current, and it stays correct when you connect a second bank six months later. Rows on or after it are what the sync already has.

**3. Paste, twice.**

Cell `T1` of `_import_staged` spells out both targets with the row number computed live, so you don't count by eye. It reads something like:

> `Paste values: A2:O → transactions!A417   then   P2:P → transactions!T417`

Two pastes rather than one, because column P of `transactions` holds the `amount_eur` ARRAYFORMULA and a pasted blank would destroy it. **Paste special → Values only**, both times, at the same row.

## Importing a second file

Change `import_batch` in `_config` first. It goes into the uid of every imported row, so leaving it alone would give the second file's row 2 the same key as the first file's row 2.

Imported rows use a readable key — `csv:budgetbakers:import1#42` — rather than a hash. Cross-source dedup can't work anyway: an imported row and the same transaction fetched from the bank share no field that's stable between them. The cutoff is what prevents overlap, and a key you can read tells you where a row came from at a glance.

## Transfers

The export flags transfer rows without pairing them, so `transfer_group` is left empty. What survives is the category — `Transfer / Between accounts`, whose `kind` is `transfer`, which is what keeps both legs out of spending reports. That's the part that affects your numbers.

Pairing the legs is phase 7's job, and it has to work by amount and proximity regardless: in the export probed here the two legs of one €600 move were **three days apart**, and one €1,000 transfer had no counterpart at all because the other account isn't tracked.

## Checking it worked

Pick a past month and compare **spend by category** against what BudgetBakers reports for that same month.

This is the real test, and it's worth doing before importing everything. If the totals don't tie out, either the mapping is wrong or the sign convention is — and both are far easier to fix on twenty rows than on six years.
