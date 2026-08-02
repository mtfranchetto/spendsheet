# Importing history

There is **no CSV parser**, deliberately. Loading a file is File → Import, and the mapping is formulas in `_import_staged` you can read and correct without touching code — which is what makes a wrong guess about a column a spreadsheet edit rather than a release.

One menu item commits the result. That is not a retreat from the governing rule: the review still happens in the sheet, and what got automated is only the paste, which had four independent ways to silently corrupt an append-only tab.

What the repo does build is the tab in between. `_import_staged` is pure formulas: it reads whatever landed in `_import_raw`, maps it through `_import_map` and `_category_map`, and shows you the result **before** any of it becomes history. You see which rows are excluded and why, rather than trusting a log written afterwards. And when the mapping is wrong — it will be, because every export differs by app version and locale — the fix is editing a tab, not editing code.

The same procedure covers Satispay, DeGiro, or any bank Enable Banking can't reach: add rows to `_import_map` under a new preset name and point `import_preset` at it. See [Other providers](#other-providers).

## What a BudgetBakers export actually looks like

Probed against a real one, because it can't be verified from any primary source: their support page refuses automated fetches. The preset shipped before that probe was invention, and **four of its nine rows were wrong**. Worth knowing which, because two of them would have failed silently:

| | |
|---|---|
| **Semicolon-delimited** | so File → Import needs the separator set by hand |
| **The sign is not in the amount** | every amount is positive; direction lives in a `type` column of `Expense`/`Income`. Mapping `amount → amount` alone would have imported every expense as income and inverted the entire sheet |
| **`transfer` is a boolean, not a pair id** | it marks that a row *is* a transfer, not which row it pairs with |
| **Amounts are inconsistently formatted** | `116.87` and `1000` both appear, so nothing may assume a decimal point exists |

Columns deliberately left unmapped: `ref_currency_amount` (identical to `amount` unless you hold a non-EUR account), `payment_type` (the instrument — `Transfer` there means *bank transfer*, not a move between your own accounts, and is easy to confuse with the `transfer` column), and `transfer` itself, which is a boolean rather than a pair id — the category carries the meaning instead, via kind `transfer`, which is what keeps those rows out of spending totals.

`labels` **is** mapped. It was left out when importing meant a manual paste, on the grounds that a third block was one more chance to misalign; *Import staged rows* writes each column separately, so that reasoning expired. It matters more than the row count suggests: a real export had 588 labelled rows across six labels, and nobody re-labels a history by hand.

The shipped preset was later rebuilt against a **full year** — 1,464 rows, 57 distinct categories, where the first pass had been written off a 20-row sample and covered 36. See [the category map](#the-category-map).

## Before you start

**Name your accounts to match the export.** `_import_staged` resolves each row's `account_id` by matching the CSV's account name against `accounts` column B. Rename your rows there to whatever the export calls them — `Fineco EUR`, `Illimity`, `Revolut` — and the join is free. An account name that doesn't match still imports; it just arrives with `account_name` and no `account_id`, so it won't roll into that account's balance.

Expect more account names than you have banks. A real year's export carried eleven, of which four were reachable by open banking and the rest were a cash wallet, two brokerages, a savings pot and two property accounts. Every one of them needs a row in `accounts` — kind `cash` for the wallet, `asset` for the brokerages and property — or a chunk of the history arrives unattached.

That includes the accounts you've since closed. Give them a row, import their history, then set `active` to FALSE and clear `balance_api` — see [an account you no longer use](SHEET-SCHEMA.md#an-account-you-no-longer-use). Leaving them out of the import is the one decision here you can't reverse without doing the whole import again.

**Don't hand-create a row for an account you're going to connect.** The sync matches on `account_id`, and the id it uses comes from the provider — so a row you typed with your own id doesn't get recognised, and you end up with two rows for one bank: your history on one, the balance on the other. Connect it first, rename the row the sync created to whatever the export calls it, *then* import. The import joins on the name, so that's all it takes for the history to land on the real account.

If you import before connecting, the fix afterwards is a find-and-replace on `account_id` in `transactions` — recoverable, but it's a code-owned column and thousands of rows.

**Read `_category_map` first, not afterwards.** Their taxonomy is single-level and ours is two, so the second level is invented in that tab. These become `category_override` — the training signal the whole categorisation cascade learns from in phase 7. A category you wouldn't have chosen teaches the wrong thing about every future transaction from that merchant. Ten minutes there is worth more than any amount of correcting later.

## The category map

Two mistakes worth knowing about, because both survived a 20-row sample and both are the kind that look fine in the sheet:

**Some of their categories are income.** `Gifts` is a gift *received*; `Gifts, joy` is the expense. Filing both under Shopping/Gifts counted a year of presents received as a year of presents bought — €9,400 on the wrong side. The others that mean money in: `Wage, invoices`, `Rental income`, `Interests, dividends`, `Child Support`, `Sale`, `Refunds (tax, purchase)`, and the bare `Income`. A test now asserts every one of them maps to a category whose `kind` is `income`.

**A parent-level category is not its most common child.** `Food & Drinks` is BudgetBakers' parent of Groceries/Bar/Restaurant, and it gets used when nothing more specific fits. Mapping it to Groceries moved a year of stray coffees into the weekly shop — €8.60 average against Groceries' €41. Parent-level sources map to an `Other <parent>` child instead, which keeps them out of a total they'd distort while still saying more than "uncategorised".

`Missing`, `Unknown expense`, `Services` and `Others` map to Other/Uncategorised deliberately. They carry no information, and inventing a category for them hides rows that deserve a look in the needs-review queue.

The taxonomy grew to meet the export rather than the export being squashed into it: `Insurance` as its own parent rather than a child of Health, and income subcategories for rent, gifts and child support. **A distinction you spent a year making in BudgetBakers is data**, and collapsing it on the way in is the one loss the import can't be undone from.

It also shrank where the extra level earned nothing. `Bills & Utilities` folded into `Housing`, because rent, maintenance and the electricity bill are all what the home costs and splitting them meant adding up two figures to get the one worth watching. `Travel` folded into `Entertainment`, and `Family` retired to `Shopping / Kids` and `Entertainment / Life events`. Twelve top-level categories, not fifteen.

Merging `Travel` costs less than it looks, and only because **labels** exist. "What did the holiday cost" is a question about a trip, not a category — it spans flights, restaurants and a pharmacy, each of which means something ordinary the other fifty weeks of the year. A label answers it across categories; a category never could.

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

**3. Import it.**

**Spendsheet → Import staged rows.** It counts what will land, breaks it down by account, names the date range, and says how many rows are excluded and why — then asks before writing anything. Nothing moves until you say yes.

It skips rows already in `transactions`, matching on uid, so running it twice imports nothing the second time. That is the one guarantee the manual paste below could never offer.

It also warns about rows whose `account_name` matched nothing in `accounts`. Those would import unattached and nothing downstream would mention it again.

> **Why this has a menu item when the CSV loader deliberately doesn't.** The rule is that one-time operations get documented rather than coded, and this is the same exception `installCredentials()` earns: a procedure that silently corrupts is a trap, not a procedure. The paste was two blocks that had to land on the same row, values-only both times, after filtering, without crossing column P. Four ways to quietly damage a tab that is never rewritten once written. Loading the file and mapping the columns — the parts that were removed on purpose — are still File → Import and formulas you can read.

<details>
<summary>Doing it by hand instead</summary>

Cell `T1` of `_import_staged` spells out both targets with the row number computed live, so you don't count by eye. It reads something like:

> `Paste values: A2:O → transactions!A417   then   P2:P → transactions!T417`

Two pastes rather than one, because column P of `transactions` holds the `amount_eur` ARRAYFORMULA and a pasted blank would destroy it. **Paste special → Values only**, both times, at the same row. Filter on `include` first, or the blanked excluded rows paste in as empty rows.

</details>

## Several files — merge them first

BudgetBakers exports per year, so a full history arrives as one file per year. **Concatenate them into one file before you start.** The headers are identical across versions — five years of a real export, Oct 2022 to Jul 2026, matched byte for byte — so it's a `cat` with the extra header lines dropped, and it removes every one of the failure modes below at once: one import, one batch, one paste, nothing to clear in between, no way to lose your place.

Sort the merged file by date while you're there. `transactions` is append-only and **never sorted** — that rule is what keeps row identity and every formula reference intact, and it means paste order is the sheet's order forever. Nothing depends on it; every report goes through `QUERY`. But a sheet that runs 2024, 2019, 2022 can't be fixed later, and sorting the CSV is free.

Two things to check on the merged file, because both are silent:

**Exact duplicate rows.** If two exports overlapped at a year boundary you now have the overlap twice. Compare every field: a pair inside one source file is a genuine repeat — two train tickets on one day at the same fare is real, and the row-number uid keeps both — while a pair spanning two files is overlap, and one copy should go.

**Fields containing a line break.** Bank descriptors sometimes carry one, quoted, which is valid CSV and which Sheets parses correctly. It is still the one thing that could split a row and shift every column after it, so after importing check that `_import_raw` holds exactly as many data rows as the file has records. If it doesn't, that's where it went.

## Several files — one at a time

If you'd rather not merge, the steps above run once per file. Three things change between runs, and two of them are silent if you skip them.

**Import oldest first.** `transactions` is append-only and **never sorted** — that rule is what keeps row identity and every formula reference intact, and it means the order you paste in is the order the sheet is in forever. Nothing depends on it; every report goes through `QUERY` or a formula. But scrolling through a sheet that runs 2024, 2019, 2022 is unpleasant in a way you can't fix later. Ten seconds of ordering now.

**Change `import_batch` before each file.** It goes into the uid of every imported row — `csv:budgetbakers:2019#42` — and the number after `#` is the row of `_import_raw`. Leave the batch alone and the second file's row 42 gets the same key as the first file's row 42. Name it after the year and it stays obvious later.

**Clear `_import_raw` before each import, don't just re-import over it.** File → Import → *Replace data at selected cell* replaces the cells the new data lands on and leaves anything past it alone. So importing a 900-row year on top of a 1,400-row year leaves 500 rows of the previous file below it — which stage, look completely normal, and paste in a second time. Select `_import_raw`, ⌘A, Delete, then import.

Then the loop, per file:

1. Clear `_import_raw`, import the year into it
2. Set `import_batch` to that year
3. Check `_import_staged` — the paste targets in `T1` recompute themselves, so they're right without counting
4. Paste both blocks
5. Tie out one month against BudgetBakers before doing the next file

That fifth step only matters on the first file. Once one year ties out, the mapping is proven and the rest are mechanical.

**What the cutoff does and doesn't catch.** The `why` column excludes rows the API already has — it's derived per account from the oldest `enablebanking` row in `transactions`. It does **not** compare against rows you imported earlier, so importing the same year twice inserts it twice. Nothing detects that but you. Since the years are disjoint this only bites if you lose your place; the batch name in the uid is what tells you where you got to.

Imported rows use a readable key rather than a hash. Cross-source dedup can't work anyway: an imported row and the same transaction fetched from the bank share no field that's stable between them. The cutoff is what prevents overlap with the API, and a key you can read tells you where a row came from at a glance.

## Other providers

Yes — the mapping is data, not code, and nothing in it is BudgetBakers-specific. Satispay, DeGiro, a bank Enable Banking can't reach, a different PFM app: each gets a **preset**, which is just a name in column A of `_import_map` and `_category_map`.

To add one:

1. Add rows to `_import_map` under a new preset name, one per column you want, mapping *their* header to *our* column
2. Add rows to `_category_map` under the same name, mapping their categories to yours — or none, and categorise it in phase 7 instead
3. Set `import_preset` in `_config` to that name
4. Import their CSV into `_import_raw` and check `_import_staged`

`_import_staged` rebuilds itself from whichever preset is named, so switching providers is editing one cell. Presets coexist; you're only ever using one at a time.

**The four columns a row can't do without** are `booking_date`, `amount`, `account_name` and `description`. Everything else is optional and lands blank.

**The direction of the money is the part that differs most**, and it's handled two ways:

| The export | What to map |
|---|---|
| Unsigned amount + a direction column (BudgetBakers) | map `type`; the word for money out is `Expense` |
| Signed amount, `-42.00` for money out (most banks) | **don't map `type`** — the amount's own sign is used |

Don't map `type` to something that isn't a direction just to fill it in. An unmapped `type` is a supported state; a wrong one is a sheet where every expense is income.

Two constraints that aren't negotiable per-preset: the file must be **one row per transaction with a header line**, and dates must be **ISO** (`2024-03-15`, with or without a time). A `15/03/2024` export needs a find-and-replace in `_import_raw` first, or a column of `DATE()` alongside it that you map instead. Parsing that here would mean guessing between `03/04` as March 4th and April 3rd, and guessing wrong is invisible for eleven days of every month.

## Transfers

The export flags transfer rows without pairing them, so `transfer_group` is left empty. What survives is the category — `Transfer / Between accounts`, whose `kind` is `transfer`, which is what keeps both legs out of spending reports. That's the part that affects your numbers.

Pairing the legs is phase 7's job, and it has to work by amount and proximity regardless: in the export probed here the two legs of one €600 move were **three days apart**, and one €1,000 transfer had no counterpart at all because the other account isn't tracked.

## Checking it worked

Pick a past month and compare **spend by category** against what BudgetBakers reports for that same month.

This is the real test, and it's worth doing before importing everything. If the totals don't tie out, either the mapping is wrong or the sign convention is — and both are far easier to fix on twenty rows than on six years.
