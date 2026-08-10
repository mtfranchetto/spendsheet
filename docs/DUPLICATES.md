# When a transaction is in the book twice

Every total in this project is a sum over rows, so a row that exists twice is wrong twice. This page is about finding those, deciding which copy goes, and — the part that is easy to get wrong — making the fix stick.

## Which kind you have

Column **N**, `source`, answers it in one look.

| Both rows say | What you have |
|---|---|
| `enablebanking` | Same source. Rare, and a bug — see below |
| One `csv:budgetbakers`, one `enablebanking` | Cross-source. Almost certainly what you have |
| One `manual` or `transfer-leg` | Not a duplicate. Something typed a row on purpose |

**Same-source duplicates are a failure of identity**, and there is no cleanup tool for them because there is almost never anything to clean up. A bank's transactions are keyed on `entry_reference` where one exists and on a hash of account, date, amount and description where it does not — so the way to get two is for the bank to change one of those fields between syncs. When that happens the sync notices and writes a row to `_anomalies` rather than guessing. If you find a pair with no anomaly behind it, that is worth reporting; delete one by hand using the procedure at the bottom of this page.

**Cross-source duplicates are the ordinary kind**, and they come from one situation: you imported a history for an account before the bank's sync had reached back that far. The import had nothing older to compare against, so every row staged legitimately; the next nightly run then fetched its rolling ninety-day window and wrote a second copy of everything the two overlapped on. See [IMPORT.md](IMPORT.md#importing-before-a-banks-first-sync) for how that arises.

## The one-day problem

A sync suppresses a fetched row when an imported row already in the book matches it on **account, booking date and amount** — all three exactly. That is deliberate, and the reasoning is in the header of `src/08_dedup.gs`: a date tolerance would also make every recurring €50 withdrawal a candidate for every other one, and the exports checked at the time agreed with the bank to the day.

They do not always. A refund from Amazon was recorded by BudgetBakers on 16 June, the day it appeared, and booked by Revolut on 17 June. Same account, same €24.08, the same description word for word — and one day between them, which was enough for the sync to see nothing, for **Remove synced duplicates** to report nothing to do, and for the row to sit in the book twice for two months.

So the cleanup now matches in two passes. The first is the exact rule, unchanged. The second takes only what the first did not pair and relaxes **the date alone**, up to `duplicate_window_days` in `_config` (three by default).

What makes relaxing it safe is not the window, it is that a pair always has **one imported side and one synced side**. Two €120 withdrawals a day apart are both synced; they are never offered to each other, whatever their dates. Description is used to break a tie between two otherwise identical candidates and is never a requirement — your export says `Esselunga` where the bank says `PAGAMENTO POS 12/07 ESSELUNGA SPA TORINO`, so requiring agreement would find nothing.

## Removing them

> Spendsheet → Import → Remove synced duplicates

It reads the whole tab, pairs what it can, and shows you what it found before touching anything. Exact pairs come as a count, a per-account breakdown and a date range — there are usually many and reading them one by one tells you nothing. Pairs that are a few days apart are **listed individually**, with the gap, both dates and both descriptions, because a pair the machine had to relax a rule to find is one you should look at.

Saying yes does three things, in this order: copies the imported row's category, subcategory, labels and notes onto the surviving row wherever the survivor has none of its own; copies every doomed row to **`_removed`**; deletes them.

### Why the imported row is the one that goes

This is the part worth reading, because the obvious answer is the wrong one and it fails in a way you would not notice for a day.

The two rows describe the same money, so neither is more true. The tie used to be broken by what was attached — the imported row carries the category you gave it in the tool it came from, the tick that says you meant it, and its labels, while the synced row carries an `entry_reference` nothing downstream reads. That reasoning is right about the rows and incomplete about time.

**Only one of the two comes back.** `sync_window_days` is 90, so a synced row inside that window is fetched again on the very next run, under the same uid, and re-inserted — and for a pair the exact rule cannot see, nothing suppresses it. Delete the bank's copy on Tuesday and the duplicate is back on Wednesday morning, with nothing anywhere saying it ever went. An import is something you do by hand; it does not re-create itself.

So the survivor is the bank's row, and what the imported row was carrying is copied onto it first. **Blanks only** — if the survivor already has a category you set from the phone, that is newer information about the same money and it wins.

### The safety rails

- Every removed row is written to **`_removed`** first, with the same columns as `transactions`, so putting one back is a paste. A second run appends rather than overwriting the first run's evidence.
- It refuses if row 2 is one of the rows to go. Row 2 anchors every `ARRAYFORMULA` from column P onward; deleting it does not move those formulas, it destroys them, and the tab loses `amount_base` and every category column at once.
- It re-baselines the row-loss detector afterwards. That detector aborts a sync when the tab shrinks, correctly, and this is the one shrink that was asked for.
- If it proposes more than a quarter of the tab, it says so and asks you to check a few first. That is not an overlap, it is a match that has gone wrong.

The undo lives in a tab rather than in Drive on purpose. A Drive snapshot reaches outside the book and everything out there can refuse — and it did, for want of a scope, on every run for months (see [MONITORING.md](MONITORING.md)). An undo that fails on exactly the books most likely to need one is worse than none.

### One thing it cannot know

Re-importing the same CSV under the same `import_batch` after a cleanup brings the removed rows straight back, because the uid of an imported row is its position in the file and nothing else. `Import staged rows` skips uids already in the book, and after a cleanup those uids are no longer in the book. Change `import_batch` before re-importing anything, which you should be doing anyway.

## When you would rather not delete

**Tick `excluded` (column Z) instead.** The row stays where it is, stays searchable, and drops out of every total — `in_reports` reads that column, and every report reads `in_reports`. This is the better answer whenever you are not certain the two rows are the same money, and the honest answer for a row you want to keep a record of.

## Editing `transactions` by hand

Sometimes it is one row and a tool is overkill. That is fine, within limits, and the limits are not all obvious.

**Safe:**

- Deleting a row **whose `source` is `csv:...`, `manual` or `transfer-leg`**. Nothing will ever fetch those again.
- Ticking `excluded`, editing `category_override`, `subcategory_override`, `labels`, `notes` — columns P onward are yours.
- Editing `description` on a row that is *not* from `enablebanking`.

**Not safe:**

- **Deleting a synced row dated inside the last 90 days.** It comes back. Use `excluded` or remove its imported twin instead.
- **Sorting the tab**, or any part of it. Row identity is positional in more places than it looks, and every `ARRAYFORMULA` reference goes with it. Silently.
- **Inserting a column mid-schema.** Same reason. Append to the right is fine.
- **Touching row 2.** Every `ARRAYFORMULA` from P onward is anchored there.
- **Editing `description` on an `enablebanking` row.** Where a bank sends no `entry_reference` the uid is a hash that includes the description, so a future sync would not recognise the row and would append a duplicate days later, with nothing pointing back at the edit. The phone app already refuses this for the same reason.

**After deleting any row by hand, run Spendsheet → Set up and maintain → Accept row count.** The row-loss detector has just watched the tab shrink and will abort the next sync — correctly, since from where it sits an unexplained shrink and a catastrophe look identical. Nothing copies a hand-deleted row to `_removed`, so if you might want it back, copy it there yourself first.

See [SHEET-SCHEMA.md](SHEET-SCHEMA.md) for what every column is and who owns it.
