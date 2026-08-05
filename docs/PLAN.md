# A mobile web app for spendsheet

*This is a build plan, not documentation. Delete it once every phase has shipped —
the two before it were kept too long and started reading as a roadmap for work that
was already done. `git log -- docs/PLAN.md` has them.*

## Context

The Google Sheets mobile app is where 99% of this book gets used, and it is bad at
it — not because of layout, but because it is a general-purpose grid renderer that
must open a 4,600-row book with ~50 `ARRAYFORMULA`s before showing anything. The
dashboard was already reworked for the phone; that route is spent.

The decision taken: **keep the Sheet as the datastore, add a second front door.**
An Apps Script web app served from the same container-bound project. Every founding
constraint survives — no server, no cost, no build step, data outlives the tooling.

Rejected, with reasons: a **second Apps Script project** is impossible (a Sheet has
exactly one bound script) and every workaround forces `spreadsheets.currentonly` up
to the broad `spreadsheets` scope, which `tests/manifest.test.mjs:59` refuses.
**AppSheet/Glide** add a vendor and a subscription. **A full pivot** throws away the
PSD2 pipeline and 4,600 categorised rows.

## The four pages

1. **Dashboard** — account totals and sync status; most recent transactions,
   including the ones awaiting confirmation, confirmable in place; month-to-date
   expenses by category.
2. **Records** — every transaction, filterable, paged.
3. **Analytics** — a date range plus optional account and label filters, and a set
   of result blocks assembled from them: expenses, income, cashflow, balance trend,
   by category. Defaults to month-to-date, all accounts, all labels.
4. **Add** — register a cash transaction.

## Aggregate on the server, not in the browser

The obvious design — ship the ledger once, filter in the browser — would work today.
A transaction compacted for charting is ~30 bytes, so 4,600 rows is ~140KB.

It is still the wrong design, because **that number only grows**. This book
accumulates forever; 25,000 rows is 750KB re-downloaded on every open. Aggregating
server-side makes the payload the size of *the answer*, which never grows.

So: **one server call per filter change.** It reads the ledger once, aggregates in
memory, and returns only what gets drawn — three totals, ~30 category rows, and two
series of 30–365 points. **~5–15KB regardless of ledger size.**

### Where the aggregation happens: Apps Script JS, not the sheet

The rule is **precompute what is fixed, compute what is variable.** The dashboard
asks the same questions every time, so formulas already answer them and the page
just reads `A1:S130`. Analytics assembles its question at runtime from date × account
× label — an unbounded space no formula can be waiting on.

Driving the `reports` tab as the engine (write `B3:B8`, `flush()`, read back) is
rejected on three counts, in order of severity:

1. **It is a write.** Every filter change would mutate shared state — the desktop
   `reports` tab shifts under you, and two devices cannot both use the app.
   Read-only is a property worth protecting.
2. **`flush()` is the slow part.** Recalculating ~50 array formulas is not obviously
   cheaper than a JS loop, which is microseconds over 4,600 rows.
3. **Another derived tab is another set of anchors that can stop spilling** — the
   failure the session before this one was spent on.

Quotas are not a constraint and were checked rather than assumed: Apps Script meters
*runtime*, not rows — there is no per-read cell or row quota, and the Sheets REST
API's 60-reads-per-minute limit does not apply to `SpreadsheetApp`. The documented
daily cap (90 min, consumer) is named "Triggers total runtime" and is spent by the
sync; at ~1.5s a query it would still allow thousands of filter changes a day. The
only long-term ceiling is a Sheets one — 10 million cells, which at 30 columns is
~330,000 transactions.

The loop is free; **the whole cost is the read** — roughly 125,000 cells (4,600 rows
× the C–AC span the aggregates need). Phase 2 therefore includes a diagnostic that
*times* that read on the live book rather than assuming it. If it exceeds ~1s, the
remedy is a read-through cache: the compacted ledger in `CacheService`, chunked
(100KB per key) and invalidated on transaction row count, so only the first query
after a sync pays for the read. Written if the measurement calls for it, not before.

The shape that makes this feel fast:

- **One pass produces every block**, so the response carries all of them. Changing
  filters costs a round trip (~0.5–1s, with a loading state); toggling which blocks
  are *shown* costs nothing.
- Results cached client-side against the filter signature, so revisiting a slice is
  instant.
- Filters apply on release, not per tap.

An earlier draft put the filtering in the browser and therefore needed a
`shared_logic.html` the test harness could also load, since anything inside a page
is invisible to `node:vm`. Aggregating on the server **removes that whole
mechanism** — it is ordinary `.gs` code, tested like everything else.

Records uses the same approach — server-side filtering and pagination, ~100 rows a
page. 4,600 DOM nodes was never a good idea.

## Two deployments, one project

Apps Script allows many deployments of one project, each with its own URL and access
setting. Same code, two doors.

| | Door 1 — consent redirect | Door 2 — the app |
|---|---|---|
| URL | already registered with Enable Banking | new, private |
| Who has access | Anyone (anonymous) | **Only myself** |
| Execute as | Me | User accessing |

Door 1 **must** stay anonymous: PSD2 consent often completes inside the bank's own
webview, which carries no Google session. A login wall there kills
`ebCreateSession(params.code)` and the authorisation code expires.

Door 2 is locked by Google before any of our code runs. The code gate exists for one
reason: both doors run the same `doGet`, so an anonymous visitor to Door 1 would
otherwise be served the app.

## Constraints discovered during exploration

1. **`doGet` already exists** at `src/05_auth.gs:224`. A second definition would
   silently win. The existing one must *delegate* via the established
   `functionExists_` forward-reference pattern.
2. **`google.script.run` serialises.** `readRecords_` returns real `Date` objects,
   which do not survive; dates are formatted or reduced to day numbers server-side.
3. **`refreshReviewQueue()` (`17_review.gs:182`) and `confirmVisibleRows()`
   (`14_categorize.gs:935`) call `SpreadsheetApp.getUi()`** and throw outside a
   container UI. Use `refreshReviewQueueQuietly_()` (`17_review.gs:203`).
4. **The review write-back is `onEdit`-shaped end to end.** `applyReviewEdit_` needs
   a `Range`; `writeReviewRow_` needs a review-tab row number. Neither is callable
   from a web app; a new wrapper is required.
5. **Warning-only protections do not block script writes** (`04_setup.gs:1267`).
   Column ownership is a convention the code must honour, not a lock.
6. **A UI may write only T, AD, AB, AA, Y, Z** on `transactions`. Never A–O.
7. **Every report reads `amount_base`, never `amount`**, and respects `in_reports`.

## Phases

Tests ship in the same phase as the code, per project convention.

### Phase 1 — The door and the lock (`src/20_webapp.gs`)

- `webAppRoute_(params)` — **pure**, returns `'consent'` or `'app'`. `code` or
  `state` present → consent.
- `doGet` (`05_auth.gs:224`) gains a delegation at the top guarded by
  `functionExists_('webAppPage_')`. The consent path below is untouched.
- `webAppPage_(params)` — owner gate. `Session.getActiveUser().getEmail()` against a
  stored owner address; empty, mismatch or throw → refusal page via the existing
  `authPage_` (`05_auth.gs:328`). **Fails closed.**
- Owner address seeded into `_config` at `setup()` from
  `Session.getEffectiveUser().getEmail()`.
- `describeWebAppContext()` in `src/18_diagnostics.gs` — reports active user,
  effective user and `ScriptApp.getService().getUrl()`, to verify the gate from both
  doors empirically rather than trusting the docs.
- No manifest change: `Session.` is already declared (`12_monitor.gs:316`).

Tests: the routing table; the gate refusing `''`, `undefined`, a wrong address, a throw.

**Gate before Phase 2:** deploy Door 2, run the diagnostic from both URLs, confirm
Door 1 refuses the app branch.

### Phase 2 — The query engine (`src/21_query.gs`)

The core of pages 2 and 3, and pure enough to test hard.

- `resolveWindow_(spec, now)` — `{kind:'mtd'|'last_month'|'month'|'year'|'custom', …}`
  → `{from, to}`. Pure JS date arithmetic. `REPORT_PERIODS` (`17_analytics.gs:80`)
  holds Sheets expressions, not JS dates, so the labels are reusable and the
  arithmetic is not.
- `matchesFilters_(row, filters)` — account, label, window, and `in_reports`.
- `aggregate_(rows, window)` — one pass returning every block: totals (expenses,
  income, net), by category, by subcategory, cashflow per period bucket, and the
  balance-trend series (`balance_now − Σ amount_base` booked after each date, the
  method `trendValuesFormula` (`16_dashboard.gs:836`) already uses).
- `webAppAnalytics_(filters)` and `webAppRecords_(filters, offset)` — thin wrappers
  reading `transactions` once via `readRecords_` (`03_sheets.gs:152`).

Tests: window resolution across month and year boundaries; filters; every aggregate
against a hand-built ledger; empty results; the sign convention
(`credit_debit_indicator` applied to `Math.abs`, never a signed amount).

### Phase 3 — Shell (`src/page.html`, the project's first `.html`)

- Served with `addMetaTag('viewport', …)`. Mobile-first CSS: `system-ui` stack,
  custom properties, `prefers-color-scheme`, `env(safe-area-inset-bottom)`, 44px
  targets. Desktop breakpoint at ≥700px turns cards into a grid.
- One call on open returns the dashboard summary plus the default month-to-date
  analytics, so first paint is a single round trip.
- Rendering builds DOM nodes and sets `textContent`. Bank descriptions are
  untrusted; structural beats careful.

Tests: `tests/manifest.test.mjs` extended to cover `.html` under `src/` for the
control-character rule and to fail on `innerHTML`.

### Phase 4 — Dashboard

Accounts with balance and sync sentence, and the health banner, from one
`getValues()` over `dashboard!A1:S130` — `A92:H107` for accounts, `A3:C7` + `G3:G7`
for health, `A11:C16` for the month block — plus `runChecks_(new Date())`
(`12_monitor.gs:72`). Month-to-date by category as CSS bars. The recent list with
unconfirmed rows marked and confirmable in place.

Confirming needs `applyReviewDecisions_(decisions)` taking
`[{uid, confirmed?, subcategory_override?, category_override?}]`, built on
`uidIndex_` (`17_review.gs:430`) and `writeCell_` (`03_sheets.gs:46`), reproducing
the three rules embedded in `writeReviewRow_`: blank overrides skipped, `confirmed`
written only when supplied, and the `MAX_REVIEW_WRITE = 100` cap. Batched, optimistic.

Tests: each rule, the cap, an unknown uid.

### Phase 5 — Records

Paged ledger over `webAppRecords_`, newest first, infinite scroll. Tapping a row
opens the same confirm/categorise sheet the dashboard uses.

### Phase 6 — Analytics

A filter bar — date range (month-to-date, last month, a specific month, a year, or a
custom range), account, label — over a set of result blocks the response always
carries: expenses, income, net, cashflow, balance trend, by category.

Charts hand-drawn, no library and no CDN (a third-party script in the one page that
renders bank balances is not worth it):

- by category → CSS bars, the best form on a narrow screen
- cashflow and balance trend → inline SVG `<polyline>`

`categories.icon` supplies emoji, so icons cost nothing.

### Phase 7 — Add (cash)

Append a row to `cash_entry`, take `LockService.getScriptLock()` exactly as
`onCashEntryEdit_` does (`10_cash.gs:299`), call `drainCashEntries_` (`10_cash.gs:91`),
then `clearDrainedCashRows_`. Reuses uid generation, sign logic, dedup and override
placement whole. Account list limited to cash accounts via `cashAccountNames_`
(`10_cash.gs:205`).

Note: `drainCashEntries_` drains every unprocessed complete row, so `inserted` is not
necessarily "your" row — the UI must not claim otherwise.

### Phase 8 — Docs

- `docs/MOBILE.md` — the two deployments, which URL is which, home-screen setup,
  what the owner gate does.
- `CLAUDE.md` — the **After pushing code** section names one redeploy target; there
  are now two, with different access settings. Getting that wrong is the realistic
  security failure, so it belongs in the trap list.

## Verification

- `npm test` throughout; the suite is at 652 and every phase adds to it.
- After Phase 1: `describeWebAppContext()` from **both** URLs — Door 1 must report no
  active user and refuse the app branch; Door 2 must report the owner address.
- A deliberate negative test: open Door 1 with no parameters, confirm a refusal page.
- After Phase 2: the aggregates tied out against the `reports` tab for the same
  filters — two independent implementations agreeing is the strongest check available.
- After Phase 4: confirm a row on the phone; check `transactions` AB/AD changed and
  A–O did not.
- After Phase 7: add a cash entry; confirm one new row, correctly signed, with a uid.
- `Diagnostics → Run smoke tests` stays green throughout.

## Deliberately not in scope

Triggering a **sync** from the phone. A sync takes minutes and would exceed a web
request; it would have to be fired as a one-off trigger and polled. Worth doing
later, not worth blocking this on.
