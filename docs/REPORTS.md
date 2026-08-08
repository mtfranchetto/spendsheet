# Dashboard, reports and the review queue

The three tabs you open on purpose. All built.

Everything here is a formula, a checkbox, a dropdown or a native chart — never a menu item — and that is one decision rather than three.

## The constraint that shaped all of it

**Custom menus do not exist in the Google Sheets mobile app.** Neither do sidebars, dialogs, or anything else `HtmlService` renders. What the phone has is: formulas, native charts, checkboxes, data validation, conditional formatting, filters, and `onEdit`.

There is now a second answer to that constraint, alongside these tabs rather than instead of them: a web app on the same project, described in [`docs/MOBILE.md`](MOBILE.md). It is where `HtmlService` *does* work — a browser rather than the Sheets app — and it reads the same data and writes back to the same three columns. Everything below still applies, and still works on the phone, in the Sheets app, exactly as it did.

So a feature whose entry point is a menu item is a **desktop** feature, and there are now exactly two of them:

| Desktop only | Why |
|---|---|
| **Refresh review queue** | filling the queue reads every transaction; a formula cannot, safely — see below |
| **Rebuild charts** | the phone can read a chart and cannot create one |

Both are also done for you: the nightly sync refills the queue, and the charts are built once when the book is created. The menu items are for when you want them sooner.

That constraint is also the right one for this project independently of phones. A formula recalculates the moment a row lands, needs no run, cannot half-finish, and is still there if the code is not.

---

## `dashboard`

Entirely formulas, so it is correct the moment a row lands rather than being a snapshot that needs refreshing. It is also what keeps the never-sort rule intact: every view of `transactions` happens *here*, through `QUERY`, instead of by rearranging the record of truth.

### What is on it

It is **one column wide and stacked vertically**, in the order you need it:

| | |
|---|---|
| **Next step** (A2) | the one sentence a book needs — blank when there is nothing to do |
| **Health** (A3:C7) | last successful sync · nearest consent expiry · rows in the last 7 days · needs-review count · unconfirmed count, **with the date of the oldest one** |
| **This month** (A11:C16) | net worth · spent so far · earned so far · net · the same point last month · the difference |
| **Needs review** (A19:D28) | the first ten of the review queue — date, description, amount, guess |
| **Charts** (A31, A51, A71) | this month by category · spending by month, this year against last · net worth over 90 days |
| **Accounts** (A92:F107) | every active account, biggest balance first, with when its balance last moved and **what is wrong with it, if anything** |
| **Labels** (A111:C126) | spend per label |

### Why it is vertical, when it used to be horizontal

The blocks used to sit in their own column bands — A, E, K, O, S, V, Z — because a `QUERY` that outgrows its neighbour's start row collides, and a collision shows as `#REF!` across a whole block rather than as one wrong cell.

That reasoning was right and the layout was still wrong: **the phone scrolls vertically**, and a dashboard twenty-nine columns wide is one you cannot read on the device it is most often opened on. Avoiding a collision by spreading sideways solved a real problem by creating a worse one.

So the collision is prevented at the source instead. **Every block that can grow carries an explicit `limit`**, and the slot below it is sized to that limit with room over. A bounded block cannot reach its neighbour — a stronger guarantee than separation was, which only moved the collision somewhere you would not notice it.

### The hidden feed, G:S

Three of the blocks existed only to be plotted: the category totals, the twelve-month pair, and the ninety-day net worth series. Reading those as rows was never the point, and ninety rows of dates is most of what "the dashboard is endless numbers" meant.

They are still on the tab, because a chart reads a range and the range has to be somewhere — but they live in G:S and are **hidden on every run**, not once. That is deliberately not the contract the hidden `transactions` columns use: those are columns you might legitimately want to see, where this is chart plumbing. If you unhide it, the next **Set up and maintain → Setup sheet** puts it back.

`G` is the odd one: it holds a severity number, and it is what makes the colours work.

### Colour means three things and no more

| | |
|---|---|
| **Red** | act now — a consent has expired, the sync has stopped |
| **Amber** | act soon — a consent is lapsing, a backlog is forming, a balance has stopped moving |
| **Blue** | this cell is yours; type or pick here |

Nothing is coloured for being fine. Green-when-healthy spends your attention every day to say what silence already says, and it is what makes a red one stop registering.

An account row goes red or amber as a whole, and the **Sync** column beside it says which of the three things is wrong in words. A red row you have to go and investigate is a red row you learn to scroll past. A cash tin or a flat reads `—` rather than "no consent": it is not failing to sync, it has nothing to sync.

**Every conditional-format rule on the dashboard is `=$G<row>=2` or `=$G<row>=1`.** All of the thinking is in that hidden severity column, and that is forced rather than stylistic: a conditional-format rule does not pass through `localizeFormula`, so **it cannot contain a comma** — which rules out `AND`, `IF`, `OR` and `VLOOKUP`, i.e. everything you would reach for. It also means the thresholds can live in `_config` (`consent_warning_days`, `stale_balance_days`) instead of being frozen as literals inside a rule no test can evaluate.

**A2 says what to do next**, and it is the whole of onboarding. A fresh copy of this project opens on twenty tabs and a `reports` tab reading `never`, with nothing saying what to do about it — and the person who most needs `docs/` is the one who has not opened it. So it answers in the order the answers stop mattering: no accounts → *Connect a bank*; accounts but no rows → *Sync now*; a consent expired → *reconnect*; nothing ever synced → *Install triggers*; rows waiting → *open the review tab*. Blank on the ordinary day, which is the same rule the net worth caveat follows: a line printed every day is a line nobody reads.

Health belongs where you already look; a status tab you have to remember to open is how you find out the sync died a fortnight ago. The **oldest unconfirmed date** is new and earns its place: thirty unconfirmed rows from this week is a normal Tuesday, thirty going back to March means the queue stopped being cleared and nothing said so.

**"Same point last month" is month-to-date against month-to-date**, never against a full month. A comparison that flatters you on the 3rd and alarms you on the 30th is worse than no comparison, because it is wrong in a way that feels like information.

### The review block reads the queue, not `transactions`

It is `QUERY(review!…)`, and that is deliberate. Asking `transactions` for unconfirmed rows walks into the trap that produced `in_reports`: `confirmed` is blank on almost every row, `QUERY` types a column by majority, and `where AB = false` against a column Sheets decided was text is either an error or a silent nothing. The `review` tab is built row by row in code, so it has no blank majority to misread — and the two can never disagree, because it is the same queue showing its first ten.

**Read-only, on purpose.** Ticking here would need the `uid` beside each row, and a `QUERY`'s rows move when the data under them changes — the argument in the `review` section below. Act on the `review` tab.

### Net worth, and what it refuses to add

An account's `balance` is in **that account's** currency, and Fineco alone supplies CHF, GBP and USD pockets. Adding those into a euro total gives a number that is wrong by whatever the exchange rate is, while looking exactly like a right one.

So net worth sums only accounts that are **active**, **included in net worth**, and **in the base currency** — and column C says how many active accounts that left out, whenever it left out any. Blank on the ordinary day, because a caveat printed every day is a caveat nobody reads.

Same decision `amount_base` already makes for transactions: blank rather than unconverted.

### The net worth chart is derived, not recorded

There is no balance history tab, and there deliberately never will be:

```
balance_at(d) = balance_now − Σ amount_base booked after d
```

A snapshot tab would have been a tab, a sync change and a backfill job, to produce something strictly worse — it would start accumulating from the day it shipped, where this reaches back as far as the transactions do.

**The one case where derivation used to be weak has been closed at the source.** An `asset` balance moved only when you typed a new number into `balance_manual`, so its line was flat and then jumped the whole curve on the day you retyped it — and a daily snapshot of one would have flat-lined in exactly the same way, so it was never the fix. The phone's **Update balance** screen now records the *difference* as one `Transfer › Valuation change` transaction, which is a dated row like any other and which this formula therefore sees. A brokerage account revalued four times a year has four steps in the right places instead of one at the end.

Three things it costs, worth knowing before the line looks wrong:

- **It is anchored to today.** A missing transaction shifts the whole curve by that amount rather than showing a step. The shape and the current value stay right, which is what a trend is for.
- **It counts transfers.** A move between your own accounts changes a balance, so it belongs — this is the one place in the project that reads every row, and it is correct precisely because net worth is not a spending question.
- **Non-EUR rows contribute nothing**, since `amount_base` is blank for them, while their balance is in today's figure. Those accounts flat-line.

Change the window with `trend_days` in `_config` and re-run **Spendsheet → Set up and maintain → Setup sheet** — the chart's range is fixed when the chart is created, so a formula that resized itself would leave the plot reading a range that no longer matches.

---

## `recent`

Newest first, which `transactions` itself can never be.

`transactions` is append-only and **never sorted** — a partial sort destroys row identity and every formula reference at once — so the newest row is the bottom row of four thousand, and the tab holding the truth is the one tab you cannot skim. This sorts a copy.

Two blocks, not one merged list:

- **Year / Month** (B3:B4) — two dropdowns, `All` by default
- **Pending** (A8) — taken but not settled. Date, account, description, amount, currency.
- **Booked** (A37) — the last 200 of whatever the filters say. Date, account, description, `amount_base`, category.

The filters apply **inside** the query, before `limit`. Filtering the result instead would cap you at the newest 200 rows overall and then show whichever of them matched — a block that quietly lies about being the most recent. The year list is read out of your own data, newest first, rather than hard-coded: a fixed span offers you years you have nothing in and stops working eventually. `All` contributes no clause at all.

**Only the booked block is filtered.** A pending charge is a handful of rows from the last few days by definition, so a year filter over it either changes nothing or empties it, and a control that can only mislead is worse than no control.

They are separate for a reason that starts as a constraint and ends as the better layout. Merging them would need an array literal — `{booked; pending}` — and **this project cannot use array literals**: `localizeFormula` rewrites unquoted commas at the write boundary so a decimal-comma locale gets something it can parse, and an array literal's separators mean something. The rewrite would corrupt it silently.

But a pending charge is a different kind of fact anyway. The amount can still change, it counts towards no total on the dashboard, and `pending` carries only columns A–O — no `amount_base`, no category, because none of that has been derived for a row the bank has not booked. An interleaved list would need a column saying which is which, read on every row. Two blocks say it once, and the pending one names its currency rather than implying euros.

Read-only. Correct a category on `review`, or in `transactions` itself.

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

The eight inputs (six filters, two custom dates) carry `DASH_COLOR.INPUT`, the same blue the two cells that are yours on `review` use, so "blue means mine" is one rule across the book. A flat background rather than a conditional-format rule: which cells are inputs is a fact about the layout, not about the data.

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

**An override on its own is enough.** Typing the category is a stronger statement than ticking a box next to it, and `Learn from corrections` counts a row carrying one as confirmed either way.

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

Charts are built **on the run that creates the tab, and never again**. An `EmbeddedChart` has no id — only options — so there is no way to recognise one on a later run and update it in place: rebuilding every time would stack a fourth copy on every `setup()`, and matching on options would silently discard a chart you had dragged, resized or restyled.

That means a book that already has a `dashboard` tab gets the new blocks from **Setup sheet** and no charts. **Spendsheet → Set up and maintain → Rebuild charts** is the explicit way to ask for them, and it says it will discard your layout before it does.

The blocks themselves do move between versions, so `setup()` **blanks columns A–S of the dashboard** before rewriting them — otherwise the previous arrangement sits there as orphaned headers and live `QUERY`s, two dashboards on one tab, both plausible and one months out of date. Anything you have put to the right of column S is untouched, which is the same boundary every other "yours" region uses. That boundary is derived from the rightmost generated column rather than written down — adding a block cannot leave a strip of the old layout behind.

The layout moved a long way in this version: if your dashboard was built by an older one, **Spendsheet → Set up and maintain → Setup sheet** then **Rebuild charts** from the same submenu, in that order. The charts read ranges that the rebuild has to have written first.

`in_reports` also lands as a new column on `transactions`. It is hidden for you on the upgrade run — the only case where `setup()` changes a column's visibility after the first run, because a column that did not exist five seconds ago carries no decision to respect.

Same contract as the hidden columns: a sensible default on a new book, and your call for ever afterwards.
