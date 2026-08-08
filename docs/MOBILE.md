# The phone app

The Google Sheets mobile app is where this book actually gets used, and it is bad at it — not because of the layout, which has already been reworked for a phone once, but because it is a general-purpose grid renderer that has to open 4,600 rows and fifty array formulas before it can show you anything.

So the Sheet stays the datastore and gains a second front door: a web app served from the same Apps Script project. Same data, same tabs, same everything — it is a different way in, not a different system. Nothing is duplicated and nothing new is stored.

It gives you four screens:

| | |
|---|---|
| **Home** | net worth, this month against the same point last month, spending by category, every account with the one sentence that says whether it is working, and the review backlog |
| **Records** | the whole ledger, filtered, searched and paged |
| **Charts** | a date range plus account and label filters, over cashflow, net worth and category breakdowns |
| **Add** | a cash transaction, landing straight away |

Confirming a guess and correcting a category both write straight back to `transactions`, into the same three columns the `review` tab writes to and no others.

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
