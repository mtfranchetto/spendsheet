# Plan — from syncing database to something you'd open

**Scope:** turn a correct record of transactions into a personal-finance tool you look at on purpose. Balances at a glance, a review queue you can act on, charts, and reports you can slice.

**Lifecycle:** deleted when the last phase ships, the same as the previous one. It is a roadmap, not a design document — the reasoning behind each decision lands in the header of the file that owns it.

---

## The constraint that reshapes everything

**Custom menus do not exist in the Google Sheets mobile app.** Neither do sidebars, dialogs, or anything else `HtmlService` renders. The phone gets: formulas, native charts, checkboxes, data-validation dropdowns, conditional formatting, filters, and `onEdit`.

Everything phone-facing therefore has to be **formula-driven or checkbox-driven**. A feature whose entry point is a menu item is a desktop feature, and should be honest about that.

That is also the right constraint for this project: a formula recalculates the moment a row lands, needs no run, cannot half-finish, and is still there if the code is not.

### What it costs, stated plainly

- No "refresh" buttons. If something needs a run to be correct, it is wrong.
- No custom review UI. The review queue is a tab with checkboxes.
- Reports are dropdowns driving `QUERY`, not a query builder.

---

## Two things this plan first got wrong

Both were claims that data was missing. Both were wrong, and correcting them removed a whole phase.

**"There is no month bucket."** There is. `monthlyTrendFormula()` already groups by `year(D), month(D)` straight off `booking_date`, and already handles QUERY's zero-based `month()`. A derived month column would buy a nicer axis label and nothing else. Dropped.

**"There is no balance history."** Not needed. `balance_at(d) = balance_now − Σ amount_eur after d` derives the whole curve from `transactions`, per account, and does it over five years of history rather than starting to accumulate from today. A `_balances` snapshot tab would have been a tab, a sync change and a backfill job to produce something worse.

It would not even have helped where derivation is weakest. An `asset` balance only moves when you type a new number into `balance_manual`, so a daily snapshot of it flat-lines exactly as the derived series does.

**What the derivation genuinely costs, and it is worth knowing before the chart looks wrong:**

- It is anchored to *today's* balance, so a missing transaction shifts the entire curve by that amount rather than showing a step. The shape stays right and the current value stays right, which is what a trend chart is for.
- `asset` accounts flat-line at their current value. That is the truth about what we know, not a guess dressed as a series, and the chart should say so.

---

## A real defect, found while checking the above

**`excluded` is ignored by everything you look at.** It is a documented column, you can tick it, and the only thing in the project that honours it is recurring detection (`15_recurring.gs:110`). Every dashboard block filters `type <> 'transfer'` and nothing else, so a row you have deliberately excluded still counts in this month's spending, in the six-month trend, and in every label total.

Fixing it is not a new feature and should not wait for one.

The fix is a derived boolean column on `transactions`, appended to the right (AC — appending right is safe; inserting mid-schema is what breaks row identity), rather than another condition bolted onto each `QUERY`:

- `in_reports` — `NOT excluded AND type <> 'transfer'`, ending in a comparison so it yields a real boolean and not `1`

**Why a column rather than `where Z <> TRUE` in each query.** `excluded` is blank on almost every row, and QUERY types a mostly-blank column by majority and treats blanks as null. `where Z = false` then drops every blank row — which is nearly all of them — and the dashboard goes empty. An `ARRAYFORMULA` that emits a real boolean on *every* row removes the null case entirely, so the comparison is type-safe. This is the same class of trap as `1` not equalling `TRUE`, which has already cost this project one silent blanking.

It also means one place decides what counts as spending, instead of six blocks each re-litigating it and one of them getting it wrong.

---

## Phase 11 — a dashboard you would open on purpose

Rebuild `dashboard`. Blocks still grow downwards and stay apart horizontally, for the reason in `16_dashboard.gs`: a `QUERY` that outgrows its neighbour shows `#REF!` across the whole block.

**Balances strip.** Every active account: name, kind, balance, currency, when it was last updated. Net worth as the total, `include_in_net_worth` respected — **`Sara` counts**. Stale balances flagged by conditional formatting rather than by a column of dates you have to read.

**This month.** Spent, earned, net, against the same point last month. Month-to-date compared with month-to-date, not against a full month — a comparison that flatters you on the 3rd is worse than none.

**Three charts.** Native `EmbeddedChart`, built by code, reading ranges fed by `QUERY`. A chart is configuration pointed at a range, so it stays live as formulas recalculate.

1. **Spend by category, this month** — bar, ranked. "Where did it go", in one look
2. **Monthly spend, this year vs last** — two series, columns. "Is this normal for me"
3. **Net worth, 90 days** — line, derived per the formula above

**Unconfirmed** gains the oldest date next to the count, so a backlog looks like a backlog. Acting on it is phase 13.

**Chart idempotency is a real problem.** `setup()` must not stack a fourth copy on every run, and must not stomp a chart you have dragged or resized. Charts have no id, only options. The rule: build on the run that *creates* the tab and never again — the same contract as the hidden columns. Rebuilding is an explicit, desktop-only `Rebuild dashboard` that says it will discard your layout.

Your `dashboard` tab already exists, so this needs that menu item once.

---

## Phase 12 — reports

A `reports` tab. Dropdowns at the top, one `QUERY` underneath, a chart beside it.

**Dropdowns**, all data-validation, so they work on the phone:

| Filter | Values |
|---|---|
| Period | This month · Last month · This year · Last year · Last 12 months · All time · Custom |
| Account | All · each active account |
| Category | All · each parent |
| Label | All · each label |
| Type | All · expense · income · transfer |
| Group by | Category · Subcategory · Merchant · Account · Month · Label |

**The query string is assembled in a visible cell.** Deliberate, not untidy. A `QUERY` built by concatenation is precisely the formula this project cannot unit-test, and five formula bugs have shipped green through that gap. A generated string you can read is the difference between "the report is empty" and "the report is empty *because the where clause says `where U = 'All'`*".

**Custom period** takes two date cells, ignored unless Period is Custom.

**Drill-down** is the same tab with `Group by` changed, not a second mechanism. Category → Subcategory → Merchant, one click each.

**Year-over-year** is its own small block rather than a seventh dropdown: same month last year, same year-to-date last year, and the delta.

---

## Phase 13 — the review queue

The one that needs the most care, because it writes back.

**The backlog is under thirty**, so this is one screen. No paging, no bulk "confirm everything from this merchant" — those are a different feature and this does not need them.

A `review` tab holding the unconfirmed transactions — date, account, description, amount, the cascade's guess, and **two cells that are yours**: a `confirmed` checkbox and a `category_override` dropdown. Tick, or type a correction and tick.

**Write-back is an `onEdit` trigger**, which fires from the mobile app and is the only mechanism that does. Editing a row on `review` finds the transaction by `uid` and writes `confirmed` — and `category_override` when you changed it — back to `transactions`.

> **This reopens a decision `00_config.gs` argues against.** The `confirmed` comment rejects an `onEdit` trigger as *"no extra information"*. That reasoning holds exactly where it was made — a row carrying an override already tells you everything a tick would. It does not extend to a review queue, where the tick is the only signal there is and the alternative is no phone workflow at all. Reopened deliberately, not by accident.

**What an `onEdit` costs, up front:**

- It runs on *every* edit to the spreadsheet, so it must return immediately for any sheet that is not `review`
- It has no `LockService` protection by default and can overlap the sync
- It fails silently — no toast survives, no alert fires
- It needs its own installable trigger, so `installTriggers()` grows a third entry and stops being purely time-based

Mitigations: a hard sheet-name guard first, one row at a time, and every failed write-back recorded to `_anomalies` so a silent failure is still findable.

**Refilling the queue needs a run**, so it is a menu item — desktop. The phone can clear a queue but not refill it. That is the mobile constraint biting, and it belongs in the docs rather than papered over.

---

## Testing, and the gap this plan sits squarely in

Almost everything here is a formula or a chart. **The harness proves logic; it cannot prove Sheets accepts what we hand it.** Five bugs have shipped green through that gap: the locale `#ERROR!`, a missing `!`, `1` not equalling `TRUE`, `INDEX` not vectorising inside `ARRAYFORMULA`, and a too-wide `setValues`.

So every phase carries **live smoke tests**, not only unit tests:

- `runSmokeTests()` reads the computed values back out of the new tabs and asserts they are a number, a string or a boolean — never `#ERROR!`, `#REF!` or `#N/A`
- Every generated `QUERY` string is asserted for shape in a unit test *and* read back for result type in the live one
- Charts are asserted to exist and to point at a range that is not empty

A unit test proving a formula string balances its parentheses is worth having and is not evidence that it works.

---

## Sequencing

| Phase | Ships | Depends on |
|---|---|---|
| — | `in_reports`, so `excluded` stops being ignored | — |
| 11 | Dashboard rebuild, three charts | `in_reports` |
| 12 | `reports` tab | `in_reports` |
| 13 | `review` tab, `onEdit` write-back | — |

11 and 12 are independent of each other. 13 is independent of both and could come first.

**File layout.** `17_analytics.gs` — the free slot — takes the period logic, the query builders, the balance derivation and the chart builders, called from `04_setup.gs` and `16_dashboard.gs` through `functionExists_`, the same forward reference the dashboard already uses. `review` write-back goes there too, with the trigger registered in `11_triggers.gs`. No renumbering; 17 was left free for exactly this.

---

## Settled

- **Backlog is under thirty** — review queue is one screen, no paging
- **`Sara` counts toward net worth**
- **Non-EUR is out of scope.** `amount_eur` is blank rather than converted for non-EUR rows, so a non-EUR account is absent from every chart here. Known, accepted, not worked around.
