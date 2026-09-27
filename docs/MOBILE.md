# The phone app

The Google Sheets mobile app is where this book actually gets used, and it is bad at it — not because of the layout, which has already been reworked for a phone once, but because it is a general-purpose grid renderer that has to open 4,600 rows and fifty array formulas before it can show you anything.

So the Sheet stays the datastore and gains a second front door: a small web app on Cloudflare that signs you in with Google and reads the book with your own grant, limited by `drive.file` to that one file. Same data, same tabs — it is a different way in, not a different system. Setting it up, signing in and sharing it are in [`web/README.md`](../web/README.md).

It gives you three screens and two forms:

| | |
|---|---|
| **Home** | net worth and the last thirty days of it, the account tiles, holds the bank has not settled, this month against the same point last month, spending by category, and the review backlog |
| **Records** | the whole ledger, filtered, searched and paged |
| **Charts** | a date range plus account and label filters, over cashflow, net worth and category breakdowns |
| **Add transaction** | a cash transaction, landing straight away. Reached from a cash tile |
| **Update balance** | an asset account's new total. Reached from an asset tile |

Everything it writes goes to `transactions` and `rules`, into the same columns the `review` tab and the cash form already write to and no others. The only thing it keeps is the last read of the book, on the phone, so the screen draws before the next read lands.

---

## Using it

### The account tiles

**A coloured dot on a tile means something needs you.** 🟠 is a consent about to expire or a balance going stale, 🔴 is a bank that has to be reconnected, and either one replaces the tile's usual mark and also draws a coloured edge and a line saying which. Otherwise the mark says what kind of account it is rather than how it is doing: 🏦 for a bank, 💵 for cash, 📈 for an asset. There is no green dot, so a dot is never something your eye learns to skip.

Tap a tile for its transactions. **+ Add** on a cash tile and **↕ Update** on an asset tile are the two forms below. The labels are kept to one line on purpose: tiles sit two rows deep and every tile in a row is as tall as the tallest, so one label wrapping would make the whole row taller.

### Typing an amount

Amount fields group digits as you type, the way your phone writes numbers, so `1500000` reads `1,500,000` (or `1.500.000` on an Italian phone) before you've finished. **Either `.` or `,` works as the decimal point**, whichever your keyboard has: the key you pressed is what counts, not the separators the field draws itself. Only two decimals are kept.

On **Update balance** the field arrives holding the current value and tapping it selects the whole number, so what you type replaces it.

**Add transaction** takes labels too, as the same chips the edit sheet draws — and they stay ticked after you add, like the account and the category, because three coffees on one trip are three entries under one label. Pick a Transfer category and the chips go away: a transfer is counted in neither direction, so a label on one filters nothing. The server refuses that write as well.

**Add transaction** won't take a future date. It's for money you've already spent. The picker stops at today, and the server refuses anything later even if a picker lets it through. It does accept tomorrow, because a phone in a timezone east of your book can already be on the next day.

### Tapping a transaction

The sheet that opens asks **what the row is** before it asks what to file it under, because those are different questions and only the first changes the second.

**Expense · Income · Transfer** across the top is `type` — the column every total in this book turns on. The body follows it: two of the three want a category, the third wants a destination.

- **Category** is one searchable list: tap it, type a few letters, tap the answer — or press Return for the first match. Parents are headings with their subcategories under them, and a subcategory that matches still shows under its parent's heading, so `rent` reads as Housing › Rent. Case and accents don't matter. Picking a subcategory is enough; its parent comes with it. Typing a parent's name shows its whole group, including *"Anything in Shopping"* for when you know the parent and not the child. It's a search rather than the phone's own picker on purpose: eighty-odd categories on an iPhone scroll wheel is a list with no way to jump. The same control is on Add transaction and on the rule sheet.
- **A merchant nothing has filed yet comes with a suggestion.** On a review-queue row the cascade left unclassified, the list opens on the category of the most similar merchant you have already filed, and a line under it says which one: *Suggested from “mercato centrale roma”*. Confirm accepts it; picking anything else overrides it. Nothing is written until you tap. See [CATEGORIES.md](CATEGORIES.md#a-suggestion-for-a-merchant-memory-has-never-seen).
- **A time shows beside cash you typed on the day**, on the Records row and under the sheet's title. Rows from a bank show only the day.
- **The list is filtered to the tab you are on.** A salary should not be offered sixty expense categories. Switching tab is how you reach the other half — which is also the answer for a refund, which arrives positive and belongs under the expense it reverses.
- **Labels** are chips, pre-ticked to what the row already has. They are chips and not a text box on purpose: filtering matches whole labels, so a typed `business-travel` would silently never match `travel`. They show on the row in the list too, so you can see which transactions carry one without opening anything.
- **Not on a transfer.** The Transfer tab offers no labels, and the server refuses them there. A label is the axis a category cannot express — `travel` spanning a flight, a hotel and forty euros of coffee — and a transfer is the same money in two places, counted in neither direction. Labelling one builds a filter that can never match what you set it to find. Labels already on such a row are left alone.
- **The amount** is editable on **cash you typed**, and nothing else. A bank's figure is the bank's; an imported row's amount is half of what pairs it with its synced twin; and a row already paired in a transfer has a partner holding the same number, so changing one side alone leaves a move that no longer nets to zero. The field holds the **size**: how much, not which way. The direction was decided when you made the entry — a bare number is spending, an Income or Transfer category flips it — and correcting a digit does not revisit that, or `-50` of cash paid into a bank would turn itself into a deposit. A row going the wrong way is deleted and added again. Typing a minus is refused rather than obeyed or quietly dropped.
- **The description** is editable on rows you own — cash you typed, a leg this project wrote, anything imported — and read-only on rows a bank sent. The field simply is not there on the second kind, which is worth knowing so its absence reads as a rule rather than a bug. A bank's description is part of what *identifies* the transaction: when the bank sends no immutable reference, the row's id is a hash that includes it, so rewriting one could stop a later sync recognising something already in the book and quietly append a duplicate.
- **Long-press** a row instead, and you get a rule built from it — pattern, match type, category, priority, all editable before saving. The pattern comes from the same merchant normaliser the categoriser uses; the app's copy is held to the sheet's by a test.
- **Delete** is at the bottom of the sheet, and only on **cash you typed**. It takes two taps — the first arms it and nothing reverts it but closing the sheet — and the row is copied to the `_removed` tab before it goes, so "gone" is recoverable by hand.
- **Swipe right** to confirm without opening anything. Left does nothing, deliberately: almost every row is one the bank sent and cannot be deleted, and a gesture that does nothing on almost every row teaches you it is broken.
- **Tap outside** the sheet to close it, or the ✕ in its corner.

### Deleting, and why only cash

`transactions` is append-only everywhere else in this project. Deleting a row a bank sent would achieve nothing — `sync_window_days` is 90, so the next run fetches it again under the same id and it reappears overnight, with nothing anywhere reporting that it had gone. A leg this project wrote to balance a transfer has a partner row that would be left pointing at a group of one; the thing to undo there is the move, on the other leg. An imported row has its own route, *Remove synced duplicates*, which knows how to pair it against the synced copy and which of the two regenerates.

That leaves cash you typed: nothing fetches it, nothing pairs with it, and it is the only kind you can create by accident in two taps. So it is the only kind the delete is offered on, and the server refuses the rest a second time even if a page asks.

One row it will refuse regardless: the very first data row of `transactions`, which anchors every formula on the tab. Deleting it destroys the derived columns rather than shifting them, so that one is a deliberate edit in the sheet.

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

**What kind of move** is a second dropdown, and it is the one place `Transfer › Cash withdrawal` was previously unreachable by hand. It defaults to what the destination implies — cash out of a bank into a wallet is a withdrawal, everything else is between accounts — which is right whenever you have a wallet account to withdraw into, and wrong for an ATM withdrawal by someone who tracks no cash at all. It offers every subcategory of `Transfer`, so one you add to `categories` appears there without a code change.

Net worth falls on an *outside* transfer, correctly: it is the sum of what you track, and the money has left.

**A row already paired says so.** The list shows `Revolut → Fineco` rather than the one account the ⇄ is not about, and the sheet opens the destination on the account it is already paired with instead of on *"Somewhere outside Spendsheet"*. On the receiving leg the arrow and the question both turn round: money that arrived asks where it came from.

### Asset accounts, without a balance-history tab

An asset — a brokerage account, a car, a property — is a wallet you top up by stating the total rather than the change. You read 14,500 off a broker's app; you did not compute the €1,500 it moved by.

**Update balance** on an asset tile asks for the new total, pre-filled with the current one, and records the **difference** as one `Transfer › Valuation change` transaction dated today. That is what gives an asset a history: net worth over time is reconstructed by walking transactions backwards, so a value that only ever changed by being overwritten was invisible to it — the curve was flat, and then on the day you retyped the number the whole line moved.

`kind: transfer` on that category is what keeps a €1,500 market gain out of *income this month* while still moving net worth. A gain is not income.

### The thirty days under the total

Home draws net worth for the last thirty days, directly under the figure it ends at. Thirty *days* and not this month: a month-to-date window is one day long on the 1st, so the card would empty itself every time the month turned and fill back up over four weeks, and two openings a fortnight apart would not be comparable.

**It is a reconstruction, not a record** — the same walk backwards from today's balance the Charts curve uses, and it carries the same three caveats. It is anchored to *today*, so a transaction the bank has not sent yet shifts the whole line rather than showing a step at the end. An account in another currency contributes nothing to the movement while its balance sits inside today's total, so it flat-lines. And an asset account only steps on the day you retype its value — which is what *Update balance* above is for.

The scale down the right-hand side is not decoration. The line is drawn between its own high and low rather than from zero, so without it a balance that drifted two per cent would draw exactly the same climb as one that doubled.

### Filters

**Period** — this week, this month, last month, **a month**, year to date, last 12 months, one entry per year that has data, or a custom range. The year list is built from your ledger, so it holds no year you have nothing in.

Records opens on **year to date** and Charts on **this month**. Both come from `appDefaultFilters` in `web/src/domain/payloads.ts`, so there is one place they are decided. Records is the screen you go to *to find something*, and "this year" is a period you already have an opinion about, where a trailing twelve months is a window that moves under you.

Picking *A month* puts a row of month chips under the dropdown, and that split is deliberate: a month is a year *and* a month, so spelling out the pairs would mean scrolling a wheel past a hundred entries to reach March. Only months that have started are offered, for the same reason the year list skips a year with nothing in it — a window that is empty by construction looks exactly like a filter that is broken.

**Account** — chips, and more than one at a time. **Label** and **search** on Records.

### Drilling from a number to the rows behind it

On Charts, the **Spending** and **Income** cards open the transactions that make them up. `Balance` and `Cash flow` do not: a balance is a position rather than a set of rows, and cashflow is the *net* of the two directions, so a list from either would sum to neither.

`Cash flow` and the **Cashflow** section below cover the same window on purpose. The card is how much the period moved, as one figure beside the two directions it came from; the section is when it moved. The card is the part you get without scrolling.

A **category bar** expands on tap, into its subcategories and a full-width **All &lt;category&gt; transactions** button at the end of them. Every row expands, including one with no subcategories — otherwise the same tap means two different things depending on a fact about the data you cannot see before tapping. A subcategory is a leaf and drills straight through.

The list you land on is the rows the number was computed from, not merely the same period. Spending counts money **out** and only rows marked `in_reports`, so the drill carries that restriction with it — a transfer, a refund and a salary are all absent, and the list adds up to the figure you tapped. That is the point of it: a list that came from a total and disagreed with it would leave you with two plausible answers and no way to tell which was wrong.

Records shows what was carried across as chips above the list — **Money out** or **Money in**, the category, the subcategory — and each one clears on tap. Clearing the category clears the subcategory with it, because a subcategory on its own does not name one group: `(uncategorised)` is a bucket every category has.

The period, accounts and label come across from Charts as they were set. Search and *needs review* are cleared, since either would narrow the list below the number that opened it.

### The URL remembers what you were looking at

The address bar is rewritten every time you change screen or change a filter, so a **refresh brings back exactly what was on screen** — the tab, the period, the accounts, the label, the search text and the review toggle.

That makes it a bookmark rather than only a recovery. `/?v=records&p=year:2024&a=Revolut&u=1` is "everything from Revolut in 2024 that still needs a review", and it is short enough to edit by hand:

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

A **drill** is not in the URL either, for a different reason: it is three more filters, and carrying them means a category name validated against a list on the way back in. So a refresh after tapping a number comes back to Records without the drill — the chips go with it, so nothing on screen claims a narrowing that is no longer applied.

### Pending

Holds the bank has authorised and not settled appear at the top of Records and on Home, dashed and not tappable. They carry no category, no `amount_base` and no confirmed state, because a pending authorisation has no stable identity — the amount, the date and the description all move on the way to being booked.

They are **in no total anywhere**, which is why they say so on screen. Whether the balances above them already account for them is your bank's choice: the preferred balance type is closing-booked, which excludes holds, but not every bank reports one.

They ignore the date filter as long as it **reaches the present** — a hold's date is not final, so windowing it out of "this month" on a date the bank has not settled would hide the rows this exists to show. A period that ended in the past is different: a look back at March 2024 is not a question this morning's holds answer, so they are left out of it.

### Pull to refresh

Drag down on Home to read the book again now. Every open reads it anyway — the copy the phone kept is drawn first, under *Last updated …*, and replaced when the read lands — so pulling is for an edit made elsewhere a moment ago: typing straight into the `transactions` tab from a laptop, say.

The indicator inverts and its arrow turns over once you have pulled far enough, so "release to refresh" is a state you can see without reading it — which matters, because your thumb is over the words.

## What it deliberately does not do

**It cannot trigger a sync.** A sync takes minutes and belongs to the Apps Script project, which runs it nightly. The app reads what the sync has written.

**It cannot refill the `review` tab or rebuild charts.** Both need a run. The app does not need the `review` tab — it reads the backlog live off `transactions`, so confirming a row on the phone removes it from the list immediately rather than at the next sync.

**It has no settings.** `_config` is the settings, and it is a tab.

**A new rule does not recategorise what is already there.** The cascade runs on sync, and a confirmed row keeps whatever it was confirmed with. The toast says so, because otherwise the feature reads as broken: you make a rule for a merchant you have seen ten times, go back, and all ten are exactly as they were.

## Where the numbers come from

Every number is computed on the phone, in `web/src/domain/`, from one read of the book. Two things keep that honest. **`tests/parity.test.mjs`** holds every screen's answer to the recorded answers of the Apps Script viewer this app replaced, over one book at four awkward instants — a clock change, a new year, a Saturday night, the 31st. And the **`reports` tab** computes the same aggregates independently, in formulas: two implementations that agree is the only evidence the numbers are right.

Every write goes through the Worker as one of five named actions (`web/worker/actions.ts`), each re-asking its rules of the row as Google holds it rather than as the page last saw it — because a page can send anything.
