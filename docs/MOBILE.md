# The phone app

The Google Sheets mobile app is where this book actually gets used, and it is bad at it — not because of the layout, which has already been reworked for a phone once, but because it is a general-purpose grid renderer that has to open 4,600 rows and fifty array formulas before it can show you anything.

So the Sheet stays the datastore and gains a second front door: a web app served from the same Apps Script project. Same data, same tabs, same everything — it is a different way in, not a different system. Nothing is duplicated and nothing new is stored.

It gives you three screens and two forms:

| | |
|---|---|
| **Home** | net worth, the account tiles, holds the bank has not settled, this month against the same point last month, spending by category, and the review backlog |
| **Records** | the whole ledger, filtered, searched and paged |
| **Charts** | a date range plus account and label filters, over cashflow, net worth and category breakdowns |
| **Add cash** | a cash transaction, landing straight away. Reached from a cash tile |
| **Update balance** | an asset account's new total. Reached from an asset tile |

Everything it writes goes to `transactions` and `cash_entry`, into the same columns the `review` tab and the cash form already write to and no others. There is no storage of its own anywhere in it.

---

## Using it

### Tapping a transaction

The sheet that opens asks **what the row is** before it asks what to file it under, because those are different questions and only the first changes the second.

**Expense · Income · Transfer** across the top is `type` — the column every total in this book turns on. The body follows it: two of the three want a category, the third wants a destination.

- **Category** is one dropdown, parents as group headings and subcategories under them. Picking a subcategory is enough; its parent comes with it. Each group also offers *"Anything in Shopping"* for when you know the parent and not the child.
- **The list is filtered to the tab you are on.** A salary should not be offered sixty expense categories. Switching tab is how you reach the other half — which is also the answer for a refund, which arrives positive and belongs under the expense it reverses.
- **Labels** are chips, pre-ticked to what the row already has. They are chips and not a text box on purpose: filtering matches whole labels, so a typed `business-travel` would silently never match `travel`.
- **The description** is editable on rows you own — cash you typed, a leg this project wrote, anything imported — and read-only on rows a bank sent. The field simply is not there on the second kind, which is worth knowing so its absence reads as a rule rather than a bug. A bank's description is part of what *identifies* the transaction: when the bank sends no immutable reference, the row's id is a hash that includes it, so rewriting one could stop a later sync recognising something already in the book and quietly append a duplicate.
- **Long-press** a row instead, and you get a rule built from it — pattern, match type, category, priority, all editable before saving. The pattern comes from the server's own merchant normaliser, not a second copy of it in the page.
- **Swipe right** to confirm without opening anything.
- **Tap outside** the sheet to close it, or the ✕ in its corner.

### Transfers, and the money that used to go missing

Marking a row a transfer asks **where the money went**, and that question is not a nicety.

A cash withdrawal is one row: the bank debits €100, and nothing credits your wallet, because a wallet has no API. Marking it a transfer correctly keeps it out of spending — and left net worth €100 short of the money in your pocket. Naming the destination writes the leg the bank never will.

**Every account is offered**, plus *"Somewhere outside Spendsheet"* — and the destination's kind decides what actually happens, which you do not have to think about because the toast says which it did:

| Destination | What it does |
|---|---|
| **Cash or asset** | **Writes** the other half. Nothing will ever report it — a wallet has no API |
| **A bank you sync** | **Finds** the other half and pairs the two, marking both. Writing one would be a second copy of money that moved once, and dedup could not catch it: ours would have no bank reference and an id unlike the bank's by construction |
| **Outside Spendsheet** | Marks this row only. Another bank you don't sync, or a person — there is nothing here to credit |

If the matching row hasn't arrived yet, which is the ordinary case on the day you move the money, it marks this side and says so. The pair is made on its own once the other bank syncs — transfer detection treats an already-marked transfer as still pairable, and the app writes the same group id that detection would derive, so the two agree rather than renaming each other.

Net worth falls on an *outside* transfer, correctly: it is the sum of what you track, and the money has left.

### Asset accounts, without a balance-history tab

An asset — a brokerage account, a car, a property — is a wallet you top up by stating the total rather than the change. You read 14,500 off a broker's app; you did not compute the €1,500 it moved by.

**Update balance** on an asset tile asks for the new total, pre-filled with the current one, and records the **difference** as one `Transfer › Valuation change` transaction dated today. That is what gives an asset a history: net worth over time is reconstructed by walking transactions backwards, so a value that only ever changed by being overwritten was invisible to it — the curve was flat, and then on the day you retyped the number the whole line moved.

`kind: transfer` on that category is what keeps a €1,500 market gain out of *income this month* while still moving net worth. A gain is not income.

### Filters

**Period** — this week, this month, last month, year to date, last 12 months, one entry per year that has data, or a custom range. The year list is built from your ledger, so it holds no year you have nothing in.

**Account** — chips, and more than one at a time. **Label** and **search** on Records.

### The URL remembers what you were looking at

The address bar is rewritten every time you change screen or change a filter, so a **refresh brings back exactly what was on screen** — the tab, the period, the accounts, the label, the search text and the review toggle.

That makes it a bookmark rather than only a recovery. `…/exec?v=records&p=year:2024&a=Revolut&u=1` is "everything from Revolut in 2024 that still needs a review", and it is short enough to edit by hand:

| | |
|---|---|
| `v` | `dashboard`, `records` or `analytics` |
| `p` | the period, as the dropdown names it — `mtd`, `last_12`, `year:2024`, `custom` |
| `from`, `to` | the two ends, and only with `p=custom` |
| `a` | an account. Repeat it for more than one: `a=Cash&a=Revolut` |
| `l` | a label |
| `q` | the search text (Records) |
| `u` | `1` for "needs review only" (Records) |

Only what differs from the default is written, so a fresh open stays at a bare `?v=dashboard`, and anything the URL leaves out opens on its default. A **period** the app does not recognise is ignored rather than guessed at, so a stale link opens on this month. An **account** it does not recognise is still applied and still gets its chip, pressed — a renamed account would otherwise filter everything away with nothing on screen saying it was doing so.

The two screens reached from an account tile — adding cash, updating a balance — are deliberately **not** in the URL. They carry the account you tapped, which a bookmark cannot, so a refresh from either lands back on the screen you opened it from.

### Pending

Holds the bank has authorised and not settled appear at the top of Records and on Home, dashed and not tappable. They carry no category, no `amount_base` and no confirmed state, because a pending authorisation has no stable identity — the amount, the date and the description all move on the way to being booked.

They are **in no total anywhere**, which is why they say so on screen. Whether the balances above them already account for them is your bank's choice: the preferred balance type is closing-booked, which excludes holds, but not every bank reports one.

### Pull to refresh

Drag down on Home. This is the one gesture that drops the ledger cache explicitly, which makes it the answer for an edit nothing else saw — typing straight into the `transactions` tab from a laptop, say.

## Two deployments, and getting them the wrong way round is the mistake that matters

A Sheet has exactly one bound script, so there is one project and one `doGet`. What Apps Script does allow is **many deployments of that project**, each with its own URL and its own access setting. There are two, and they are not interchangeable:

| | Door 1 — the consent redirect | Door 2 — the app |
|---|---|---|
| URL | the one already registered with Enable Banking | new, and private |
| Who has access | **Anyone** | **Only myself** |
| Execute as | Me | Me |
| What it is for | the bank's redirect after SCA | the four screens above |

**Door 1 has to stay anonymous.** PSD2 consent often completes inside the bank's own webview, which carries no Google session. A login wall there kills the callback and the authorisation code expires while you are looking at a sign-in page.

**Door 2 has to be locked.** It renders your balances.

Both doors run the same `doGet`, which is the only reason there is a lock in the code at all: without it, an anonymous visitor to Door 1 would be served the app. See "the owner gate" below.

### Creating Door 2

In the Apps Script editor:

> **Deploy → New deployment → Web app**
> Description: `app`
> Execute as: **Me**
> Who has access: **Only myself**
> **Deploy**

Copy the `/exec` URL it gives you. That is the app.

**Do not touch the existing deployment.** *New deployment* mints a fresh URL, which is what you want here and is exactly what you must not do to Door 1 — the redirect URL registered with Enable Banking is a specific URL, and replacing it means re-registering it there.

### Putting it on the home screen

It is a normal URL, so:

- **iOS, Safari** — Share → *Add to Home Screen*.
- **Android, Chrome** — ⋮ → *Add to Home screen*.

It then opens without browser chrome and looks like an app. There is no service worker and no offline mode: every screen is a server round trip, because every number on it comes out of the Sheet. Typing a cash entry underground will fail and say so — the Sheets `cash_entry` tab is still the thing that works offline.

### The icon

`_config` has a **`favicon_url`** row, and it ships pointing at this project's icon on GitHub. It should need nothing from you.

Three things about it are worth knowing, because all three fail silently:

- **Google fetches that URL from its own servers, anonymously.** So it has to be publicly reachable over HTTPS, with no sign-in. A private GitHub repo answers a raw URL with a 404; a Drive file left un-shared answers with an HTML sign-in page. Neither is an image, neither reports an error anywhere, and both look exactly like the setting having no effect.
- **It is the browser tab, not necessarily the home screen.** iOS reads `apple-touch-icon` from the *top-level* document, and for an `/exec` URL that document is Google's wrapper, not ours.
- **A `<link rel="icon">` in `page.html` would do nothing.** The page renders inside Apps Script's sandboxed iframe, so it would be setting the icon of a document nobody sees. `HtmlOutput.setFaviconUrl` is the only lever, and `20_webapp.gs` pulls it.

To use your own: put it anywhere public over HTTPS and paste the URL into the cell. Anything that is not `https://` is refused rather than passed through — a `data:` URI is rejected by Google anyway, and a cell that ends up in a served document is checked by whitelist here rather than by escaping. **Clearing the cell turns the icon off**; it does not fall back to the default.

A book set up before this shipped has the row but blank, because `setup()` only ever *adds* seed rows and never rewrites one you already have. **Spendsheet → Set up and maintain → Update mappings to defaults** is what fills it — it will list the row and ask before changing anything.

## The owner gate

Because both doors run the same code, the app branch checks who is asking:

- `_config` has an **`owner_email`** row. **Spendsheet → Set up and maintain → Setup sheet** fills it in with whoever ran it, once, and never overwrites it afterwards.
- Every request compares that against `Session.getActiveUser().getEmail()`.
- **It fails closed.** No owner configured, no active user, a mismatch, or the runtime throwing while being asked — all four are a refusal.

The refusal page says only *"This page is not available."* That is deliberate: Door 1 is public, and a message that distinguished "wrong account" from "no owner configured" would be a probing oracle for anyone who found the URL. It tells you nothing you cannot work out from being signed in as the wrong account.

The same check runs again on every function the page calls. Google has already refused everyone else at Door 2, and the gate has already refused them at the door — the third check costs one cell read and means "you can only get here if you were served the page" is a property of one line rather than of the whole system.

**To move the app to a different Google account**, edit `owner_email` in `_config` and re-share the Sheet. Nothing else knows about it.

## Checking it works

Two checks, and the second one is the one people skip.

**Door 2 should let you in.** Open the URL. You should get the four screens. If you get *"This page is not available"*, you are signed in as a different Google account — switch and reload. If you get it while signed in as the right account, run **Spendsheet → Diagnostics → Check web app access** from the Sheet: it reports the owner address, who Google says you are, and whether that combination would be let in.

**Door 1 should refuse.** Open the *consent redirect* URL in a private window, with no parameters on it. You should get the refusal page. If you get the app, Door 1 is not anonymous or the owner gate is not doing its job — and an anonymous URL serving your balances is the one failure in this whole document that matters.

## What it costs to run

Nothing, and it stays nothing. Apps Script meters *runtime*, not rows, and there is no per-read quota on `SpreadsheetApp`. Every screen is one call that reads `transactions` once and aggregates in memory, so the response is the size of the answer rather than the size of the book — a few kilobytes whether you have four thousand rows or forty.

### Why it is as fast as it is

Two caches, and neither was written on a guess — both exist because a measurement said so, and the measurement is a menu item you can re-run.

**The ledger cache.** `transactions` is read once, serialised, and kept in `CacheService` for six hours; every screen after the first is a fetch of a few hundred milliseconds rather than a four-second read. It is keyed on a counter that every write bumps — the sync, the app, and typing into the tab yourself — so a change invalidates it immediately rather than waiting out the clock. Pull-to-refresh on the dashboard drops it explicitly, which is the answer for the rare edit no trigger sees.

**Reads shared within one request.** Drawing the first screen used to make **35 spreadsheet round trips** over about **seven distinct tabs**: `_config` eight times, `accounts` four, `_status` and `_runs` twice each — every function fetching for itself what the one before it had already read. They are now shared for the length of a request. It is deliberately off outside the app, because `setup()` and the sync write a cell and read it back, and a cache that survives that is a wrong answer rather than a fast one.

Between them, and with the health check no longer scanning 4,615 rows to count them, the first screen went from ~6.2 seconds to ~2.8 with the cache warm.

**Spendsheet → Diagnostics → Time the app dashboard** breaks the whole screen down part by part, and **Time a web app query** does the same for one ledger read. Both report every part *inside a single run* — a spreadsheet read on the same book has been seen to take anywhere from 2.0 to 9.4 seconds within one hour, so a number from today compared against one from yesterday proves nothing at all. Divide any part by `configMs` to get its cost in round trips, which is the unit that actually stays still.

## What it deliberately does not do

**It cannot trigger a sync.** A sync takes minutes and would exceed a web request; doing it properly means firing a one-off trigger and polling for it. Worth doing later, and not worth blocking this on. The nightly sync is what keeps the app current.

**It cannot refill the `review` tab or rebuild charts.** Both need a run. The app does not need the `review` tab — it reads the backlog live off `transactions`, so confirming a row on the phone removes it from the list immediately rather than at the next sync.

**It has no settings.** `_config` is the settings, and it is a tab.

**A new rule does not recategorise what is already there.** The cascade runs on sync, and a confirmed row keeps whatever it was confirmed with. The toast says so, because otherwise the feature reads as broken: you make a rule for a merchant you have seen ten times, go back, and all ten are exactly as they were.

**It cannot remove the Google banner** — *"This application was created by another user, not by Google"*. That bar is drawn by Google's own wrapper document at `script.google.com`; the page runs in a sandboxed iframe on a different origin, so no code in this project can reach it and `HtmlService` exposes no option to suppress it. Two dead ends worth naming so nobody rediscovers them: a proxy that strips it also breaks `google.script.run`, which talks to its parent by `postMessage` and needs the Google origin, and *Add to Home Screen* removes Safari's chrome, not Google's.

## Why the page holds so little

`src/page.html` is the one file the test harness cannot load: the tests run the `.gs` files through `node:vm`, and nothing inside an HTML file reaches that.

That is not a gap being worked around — it is the reason the aggregation lives on the server at all. Every number the app shows is computed in `21_query.gs`, which is covered; what is left in the page is drawing. The two things a *file* test can still prove about it are that no string is ever assigned as markup, and that every server function the page calls by name exists.

The seam is enforced rather than remembered. Everything in `21_query.gs` (reads) and `22_actions.gs` (writes) ends in `_`, which Apps Script treats as private to `google.script.run`; `23_api.gs` is the entire surface a browser can reach, and every entry point in it checks the owner. A test reads that file and derives the list, so an entry point added later without the guard fails CI rather than shipping.
