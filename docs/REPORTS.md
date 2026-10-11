# Reports and the review queue

The two tabs you open on purpose. Both built.

Everything here is a formula, a checkbox, a dropdown or a native chart — never a menu item — and that is one decision rather than two.

## The constraint that shaped all of it

**Custom menus do not exist in the Google Sheets mobile app.** Neither do sidebars, dialogs, or anything else `HtmlService` renders. What the phone has is: formulas, native charts, checkboxes, data validation, conditional formatting, filters, and `onEdit`.

There is now a second answer to that constraint, alongside these tabs rather than instead of them: a web app, described in [`docs/MOBILE.md`](MOBILE.md). It runs in a browser rather than the Sheets app, reads the same data and writes back to the same columns. Everything below still applies, and still works on the phone, in the Sheets app, exactly as it did.

So a feature whose entry point is a menu item is a **desktop** feature, and there are now exactly two of them:

| Desktop only | Why |
|---|---|
| **Refresh review queue** | filling the queue reads every transaction; a formula cannot, safely — see below |
| **Rebuild charts** | the phone can read a chart and cannot create one |

Both are also done for you: the nightly sync refills the queue, and the charts are built once when the book is created. The menu items are for when you want them sooner.

That constraint is also the right one for this project independently of phones. A formula recalculates the moment a row lands, needs no run, cannot half-finish, and is still there if the code is not.

---

## `reports`

Dropdowns at the top, one `QUERY` underneath, charts beside it.

| Filter | Values |
|---|---|
| Period | This month · Last month · This year · Last year · Last 12 months · All time · Custom |
| Account | All · each active account |
| Category | All · each parent |
| Label | All · each label |
| Type | All · expense · income · transfer |
| Group by | Category · Subcategory · Merchant · Account · Type |

Everything is data validation, so it all works on the phone. **Custom** reads the two date cells below, and they are ignored unless Period is Custom — a date left in one of them does nothing until you actually choose it.

Three blocks:

- **Top 30**, grouped by whatever *Group by* says. Drilling down is the same tab with that dropdown changed: Category → Subcategory → Merchant, one click each.
- **By month**, under the same filters. This is how you get "Groceries, month by month, last year".
- **Year on year**, which deliberately ignores the filters — it answers "am I spending more than I was", about the whole year. Wiring it to the dropdowns would make it move whenever you drilled into something, which is the fastest way to stop trusting a number.

### The query is in a cell you can read

`E6` holds the query that the block below runs, assembled from the dropdowns. That is the most useful thing on the tab.

A `QUERY` built by string concatenation is precisely the formula this project cannot unit-test — the harness never hands a formula to a spreadsheet, and five bugs have shipped green through that gap. A generated string you can read is the difference between "the report is empty" and "the report is empty *because the where clause says `where C = 'All'`*". It costs one cell.

A filter set to **All** contributes no clause at all, so the default query is short and the clauses that appear are exactly the ones you chose.

### Two things it deliberately does not do

**Group by month.** Every other dimension is one column, which a chart can use as its domain directly; a month is `year(D)` and `month(D)`, which is two, and `QUERY` has no way to join them into a label. The *By month* block answers the same question under the same filters and can carry the extra column it needs.

**Show more than thirty groups.** A chart of four hundred merchants is a smear. The cap is in the query, and the block says so.

### The blue cells are the ones you change

Nothing else on the tab is editable — every other cell is a formula or a label — and until recently nothing said so. A dropdown looks exactly like a result until you happen to tap it, which is how a filtering UI becomes a tab people scroll past.

The eight inputs (six filters, two custom dates) carry `FILL_COLOR.INPUT`, the same blue the two cells that are yours on `review` use, so "blue means mine" is one rule across the book. A flat background rather than a conditional-format rule: which cells are inputs is a fact about the layout, not about the data.

### Charts read blocks, blocks read `transactions`

A chart is configuration pointed at a range, so it stays live as the formulas underneath recalculate. Nothing needs refreshing.

The one wrinkle: `amount_base` is signed, so a spending total is negative, and a bar chart of negative bars is legible but reads as a mistake. `QUERY` cannot negate an aggregate — arithmetic on `sum()` is not in the query language — so there is one extra column next to each result that flips the sign, and that is what the chart plots. The table beside it shows the signed truth.

---

## `review`

The unconfirmed backlog, small enough to fit on one screen, with the two cells that are yours next to each row.

| | |
|---|---|
| Read | date · account · description · amount · the cascade's guess · which tier guessed it |
| **Yours** | `confirmed` — a checkbox · `category_override` — a dropdown |
| Written by the trigger | `status` |

Tick, or pick a different category, or both. Either one writes straight back to `transactions`, and `status` says whether it landed.

**A row you have done goes grey and struck through, and stays put.** It leaves when the queue is next refilled — by the nightly sync, or by **Refresh review queue**. That is the snapshot design working, not a failure to notice your tick: see below for why a self-refilling queue would be a trap. The two cells that are yours are blue, the same blue `reports` uses for its filters.

**An override on its own is enough** — either one, category or subcategory. Picking the category is a stronger statement than ticking a box next to it, and a row carrying one counts as confirmed either way.

### Why it is filled by a run rather than by a `QUERY`

A `QUERY` of the unconfirmed rows would refill itself, need no run, and work on the phone — and it would be a trap. The rows a `QUERY` produces **move** when the underlying data changes: confirm the third row and everything below it shifts up by one. The tick you were about to put on row 8 would land on a different transaction, and nothing anywhere would say so.

So the queue is a snapshot with a hidden `uid` in it. That is what makes the write-back safe: a review row is a *pointer*, and a pointer survives the tab being thrown away and rebuilt.

Refilling happens **on every nightly sync**, so the list you find in the morning is current. **Spendsheet → Refresh review queue** is for when you want it sooner, and it is desktop-only — the phone can clear a queue and cannot refill one.

### The `onEdit` trigger

The write-back is a **simple `onEdit`** — a function of that name, no installation step. It is the only mechanism that fires from the mobile app, and it now serves two tabs: this one and `cash_entry`.

This reopens a decision `00_config.gs` argues against. The `confirmed` comment there rejects an `onEdit` trigger as *"no extra information"*, and that is exactly right where it was made: a row carrying a `category_override` already tells you everything a tick would. It does not extend to here, where the tick **is** the only signal there is and the alternative is no phone workflow at all.

What it costs, stated plainly:

- It runs on **every** edit to the spreadsheet. The first thing it does is compare the sheet name and return.
- It fails **silently** — no toast survives, no alert fires, and on a phone there is nowhere for an error to appear. That is what the `status` column is for, and why a failure is also written to `_anomalies`.
- It has **no lock**. The sync only ever appends to `transactions` and this only ever rewrites two cells of an existing row, so the two cannot fight over the same cell. That is why it is acceptable, not why it is safe.
- It writes **at most 100 rows** per edit. The only way to edit hundreds of review rows at once is a paste that went somewhere unintended, and confirming four thousand transactions is the one thing the `confirmed` flag is supposed to make impossible.

Set `review_queue_size` in `_config` to change how many rows the queue holds (default 50). The backlog is expected to be well under thirty; the cap is really a guard for the first run on an imported history, where the honest answer is four thousand rows and writing them all would produce a tab nobody can face rather than a queue.

---

## Upgrading an existing sheet

Charts are built **on the run that creates the tab, and never again**. An `EmbeddedChart` has no id — only options — so there is no way to recognise one on a later run and update it in place: rebuilding every time would stack another copy on every `setup()`, and matching on options would silently discard a chart you had dragged, resized or restyled.

So a book that already has a `reports` tab gets new blocks from **Setup sheet** and no new charts. **Spendsheet → Set up and maintain → Rebuild charts** is the explicit way to ask for them, and it says it will discard your layout before it does. Run them in that order: the charts read ranges that Setup sheet has to have written first.

`in_reports` also lands as a new column on `transactions`. It is hidden for you on the upgrade run — the only case where `setup()` changes a column's visibility after the first run, because a column that did not exist five seconds ago carries no decision to respect.

Same contract as the hidden columns: a sensible default on a new book, and your call for ever afterwards.
