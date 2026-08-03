# Plan — from syncing database to something you'd open

**Scope:** turn a correct record of transactions into a personal-finance tool you look at on purpose. Balances at a glance, a review queue you can act on, charts, and reports you can slice.

**Lifecycle:** this file is deleted when the last phase ships, the same as the previous one. It is a roadmap, not a design document — the reasoning behind each decision lands in the header of the file that owns it. `git log -- docs/PLAN.md` recovers it either way.

---

## The constraint that reshapes everything

**Custom menus do not exist in the Google Sheets mobile app.** Neither do sidebars, dialogs, or anything else `HtmlService` renders. The phone gets: formulas, native charts, checkboxes, data-validation dropdowns, conditional formatting, filters, and `onEdit`.

Everything phone-facing therefore has to be **formula-driven or checkbox-driven**. A feature whose entry point is a menu item is a desktop feature, and should be honest about that.

This rules out the obvious build for half of what was asked. It is also the right constraint for this project: a formula recalculates the moment a row lands, needs no run, cannot half-finish, and is still there if the code is not. Every phase below is designed to that.

### What it costs, stated plainly

- No "refresh" buttons. If something needs a run to be correct, it is wrong.
- No custom review UI. The review queue is a tab with checkboxes.
- Reports are dropdowns driving `QUERY`, not a query builder.

---

## What is missing today, precisely

| Asked for | Today | Gap |
|---|---|---|
| Balances of all active accounts, at a glance | `accounts` tab, 18 columns wide | No compact view; net worth exists nowhere on the dashboard |
| List of unconfirmed records | A count in the health strip | The count is a number you cannot click |
| Confirm without hunting through `transactions` | `Confirm visible rows`, off a selection or filter view | Menu item — desktop only. Nothing on the phone |
| Expenses month-to-date, charted | One `QUERY` block of numbers | **No charts exist anywhere in the project** |
| Balance trend over 90 days | — | **No balance history exists.** `accounts.balance` is a snapshot, overwritten every sync |
| Reports for any period | Fixed blocks: this month, 6-month trend, labels | No period selection, no account or category filter |
| Which category has the most spend | Sort the month block by eye | No ranking, no drill-down |

Two of those are not "the dashboard is thin" — they are **missing data**. There is no balance history to chart and no month bucket to group by. That is why the first phase builds numbers rather than views.

---

## Phase 11 — the numbers worth charting

Nothing visual until the data underneath it exists.

**`_balances` — one row per account per day.** `account_id`, `date`, `balance`, `currency`, `kind`, `included_in_net_worth`. Appended by the sync, one row per account per day, idempotent on `account_id + date` so two runs in a day do not double up. This is the honest record and it is the only thing that can chart an `asset` account, whose value moves without a transaction ever existing.

**Backfilled once from `transactions`**, so the chart is not empty for its first 90 days: `balance_at(d) = balance_now − Σ amount_eur after d`, per account. Only valid for accounts whose transaction history is complete, which after the import is all the bank ones. Asset and cash accounts flat-line at their current value, which is the truth about what we know rather than a guess dressed as a series.

> **The trap:** the derived curve is anchored to *today's* balance, so one missing transaction shifts the entire history by that amount rather than showing a step. The backfilled portion is therefore marked as derived in the tab, and the sync's own rows supersede it from day one.

**Two derived columns on `transactions`, appended to the right** (AC, AD — appending right is safe; inserting mid-schema is what breaks row identity):

- `month` — `YYYY-MM`, so every report groups by a string instead of re-deriving a date bucket six times
- `in_reports` — boolean. `NOT excluded` and `type <> transfer`. One place decides what counts as spending, instead of every block re-litigating it and one of them getting it wrong

Ends with a comparison, not a product — `1` is not `TRUE` in a Sheets comparison, which has already cost this project one silent blanking.

**Tests:** `_balances` idempotency, the backfill arithmetic, `in_reports` returning a boolean. All pure. Plus a `runSmokeTests()` case that reads AC and AD back from the live sheet and asserts they are a string and a boolean rather than `#ERROR!` — see *Testing* below.

---

## Phase 12 — a dashboard you would open on purpose

Rebuild `dashboard`. Blocks still grow downwards and stay apart horizontally, for the reason in `16_dashboard.gs`: a `QUERY` that outgrows its neighbour shows `#REF!` across the whole block.

**Balances strip.** Every active account: name, kind, balance, currency, when it was last updated. Net worth as the total, `include_in_net_worth` respected. Stale balances flagged by conditional formatting rather than by a column of dates you have to read.

**This month.** Spent, earned, net, versus the same point last month. Month-to-date compared against month-to-date, not against a full month — the comparison that flatters you on the 3rd is worse than no comparison.

**Three charts.** Native `EmbeddedChart`, built by code, reading ranges fed by `QUERY`. They read a range, so they stay live as formulas recalculate — a chart is configuration, not a snapshot.

1. **Spend by category, this month** — bar, ranked descending. Answers "where did it go" in one look
2. **Monthly spend, this year vs last** — two series, columns. Answers "is this normal for me"
3. **Net worth, 90 days** — line, from `_balances`

**Unconfirmed, as something you can act on.** The count stays, and gains the number of rows and the oldest date, so a backlog looks like a backlog. Acting on it is phase 14.

**Chart idempotency is a real problem.** `setup()` must not stack a fourth copy on every run, and must not stomp a chart you have dragged or resized. Charts have no id, only options. The rule: build on the run that *creates* the tab, and never again — the same contract as `applyColumnVisibility_` and the hidden columns. Rebuilding is an explicit, desktop-only `Rebuild dashboard` that says it will discard your layout.

Your `dashboard` tab already exists, so this will need that menu item once.

---

## Phase 13 — reports

A `reports` tab. Dropdowns at the top, one `QUERY` underneath, a chart beside it.

**Dropdowns**, all data-validation so they work on the phone:

| Filter | Values |
|---|---|
| Period | This month · Last month · This year · Last year · Last 12 months · All time · Custom |
| Account | All · each active account |
| Category | All · each parent |
| Label | All · each label |
| Type | All · expense · income · transfer |
| Group by | Category · Subcategory · Merchant · Account · Month · Label |

**The query string is assembled in a visible cell**, and that is deliberate rather than untidy. A `QUERY` built by concatenation is precisely the formula this project cannot unit-test — the harness never hands a formula to a spreadsheet, and five bugs have shipped green through that gap. A generated string you can read is the difference between "the report is empty" and "the report is empty *because the where clause says `where U = 'All'`*".

**Custom period** takes two date cells, ignored unless Period is Custom.

**Drill-down** is the same tab with `Group by` changed, not a second mechanism. Category → Subcategory → Merchant, each one click.

**Year-over-year** is its own small block rather than a seventh dropdown: same month last year, same year-to-date last year, and the delta.

---

## Phase 14 — the review queue

The one that needs the most care, because it writes back.

A `review` tab holding the oldest N unconfirmed transactions — date, account, description, amount, the cascade's guess, and **two cells that are yours**: a `confirmed` checkbox and a `category_override` dropdown. Tick, or type a correction and tick.

**Write-back is an `onEdit` trigger**, which fires from the mobile app and is the only mechanism that does. Editing a row on `review` finds the transaction by `uid` and writes `confirmed` — and `category_override` when you changed it — back to `transactions`.

> **This reopens a decision `00_config.gs` argues against.** The `confirmed` comment says a row carrying an override counts as confirmed *"because requiring both would mean an onEdit trigger for no extra information"*. That reasoning holds exactly where it was made — an override already tells you everything a tick would. It does not extend to a review queue, where the tick is the only signal there is and the alternative is no phone workflow at all. Reopening it deliberately, not by accident.

**What an `onEdit` costs, up front:**

- It runs on *every* edit to the spreadsheet, so it must return immediately for any sheet that is not `review`
- It has no `LockService` protection by default and can overlap the sync
- It fails silently — no toast survives, no alert fires, and the run log is somewhere you will not look
- It needs its own installable trigger, so `installTriggers()` grows a third entry and stops being purely time-based

Mitigations: a hard sheet-name guard first, one row at a time, and every write-back recorded to `_anomalies` on failure so a silent one is still findable.

**Refilling the queue needs a run**, so it is a menu item — desktop. The phone can clear a queue but not refill it. That is the mobile constraint biting, and it should be documented rather than papered over.

---

## Testing, and the gap this plan sits squarely in

Almost everything here is a formula or a chart. **The harness proves logic; it cannot prove Sheets accepts what we hand it.** Five bugs have shipped green through that gap: the locale `#ERROR!`, a missing `!`, `1` not equalling `TRUE`, `INDEX` not vectorising inside `ARRAYFORMULA`, and a too-wide `setValues`. This plan is the most formula-heavy work the project has done.

So every phase carries **live smoke tests**, not just unit tests:

- `runSmokeTests()` reads the computed values back out of the new tabs and asserts they are a number, a string or a boolean — never `#ERROR!`, never `#REF!`, never `#N/A`
- Every generated `QUERY` string is asserted for shape in a unit test *and* read back for result type in the live one
- Charts are asserted to exist and to point at a range that is not empty

A unit test that a formula string balances its parentheses is worth having and is not evidence that it works.

---

## Sequencing, and what lands when

| Phase | Ships | Depends on |
|---|---|---|
| 11 | `_balances`, backfill, `month`, `in_reports` | — |
| 12 | Dashboard rebuild, three charts | 11 |
| 13 | `reports` tab | 11 |
| 14 | `review` tab, `onEdit` write-back | — |

12 and 13 are independent of each other. 14 is independent of all of it and could come first if the review backlog is the thing that actually stings.

**File layout.** `17_analytics.gs` — the free slot — takes the period logic, the query builders and the chart builders, called from `04_setup.gs` and `16_dashboard.gs` through `functionExists_`, the same forward reference the dashboard already uses. Balance snapshotting belongs in `06_accounts.gs`, which already owns balance selection, called from `09_sync.gs`. `review` write-back goes in `17` too, with the trigger registered in `11_triggers.gs`.

No renumbering. 17 was left free for exactly this.

---

## Open questions

1. **How big is the unconfirmed backlog?** Under a hundred and the review queue is one screen. Several thousand and it needs paging and a bulk "confirm everything from this merchant", which is a different feature.
2. **Does `Sara` belong in net worth?** It reads as an insurance or investment holding. Charting net worth means deciding, and `include_in_net_worth` is already the column for it.
3. **Multi-currency.** `amount_eur` is blank rather than converted for non-EUR rows. Every chart here reads `amount_eur`, so a non-EUR account is silently absent from all of them. Worth knowing before it looks like a bug.
