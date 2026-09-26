# Categorising

Every row gets a category without you doing anything, and the ones it can't work out go to a queue rather than into a bucket called "Other". Correcting one teaches it that merchant forever.

No machine learning, no API key, no per-row cost. The whole thing is a lookup table you built by using the app.

---

## The cascade

Four tiers, first hit wins. Every row records **what decided it** in `category_source`, so "why is this Groceries?" always has an answer.

| # | Tier | `category_source` | How it decides |
|---|---|---|---|
| 1 | Override | `override` | you typed a `category_override`. Always wins |
| 2 | Transfer | `transfer` | the row is one leg of a matched pair — see below |
| 3 | **Match** | `memory` / `mcc` / `rule` | the first entry in one ordered list that fits |
| 4 | — | `unclassified` | nothing matched. Goes to a queue, **never** to "Other" |

### Tier 3 is one list, and you decide its order

`rules` and `_memory` are matched together, as a single list ordered by `priority`, first hit wins:

| Priority | What sits there |
|---|---|
| `memory_priority` (default **5**) | every entry in `_memory`, matched on the merchant key |
| 10–99 | the seeded MCC rules — a numeric code, so language-independent and safe from a bank rewording itself |
| 100+ | the seeded text rules — `contains`/`regex`, the fallback for banks that populate MCC sparsely, which is most of them |
| highest + 10 | whatever **Always categorise this** added from your phone |

`category_source` still names the *kind* of thing that decided rather than where it sat, because that is the question you are actually asking of a row.

**Where memory sits is one cell.** `memory_priority` in `_config` at 5 puts your own confirmed history ahead of every pattern — the default, because a merchant you have filed forty times is better evidence than a substring somebody shipped. Set it above the highest priority on the `rules` tab and every rule wins instead, which is worth knowing before you do it: the seeded patterns are deliberately loose (`COOP`, `Q8`, `AMAZON`, `SATISPAY`) precisely because memory was above them. A tie goes to the rule.

Two things follow that are easy to miss. A rule you add **cannot** correct a merchant memory has learned unless `memory_priority` is above it — the way to change memory's mind is to correct **one** row, and by the next morning it has. And `learnFromCorrections` will not learn from a row a rule answered, so those two facts are the same fact seen from either end.

### How memory decides

`_memory` is rebuilt from scratch every night at `learn_hour` (default 3, an hour before the sync), and whenever you pick **Spendsheet → Learn from corrections**. For each merchant:

- **A correction you typed wins outright.** A category or subcategory override is you saying the guess was wrong, and that outranks any number of ticks agreeing with it. Forty confirmed Groceries rows and one correction to Shopping file the merchant as Shopping. The latest correction supplies both halves: correct the parent without naming a child, and the entry has no subcategory.
- **Unless your corrections disagree with each other.** The bank's text says where you bought, never what, so a merchant that sells everything cannot have one right answer. Correct Amazon to Gifts one week and Home the next and it becomes a *mixed* merchant: every row votes, corrections included, and the most common category wins. That guess stays put instead of flipping each time you correct a row. Mixed is worked out afresh each night from what the rows say *now*, so fixing a correction you made by mistake takes the merchant straight back.
- **With no corrections, the most common category wins**, ties going to the most recent.
- **Imported categories vote; they are never corrections.** The import keeps each row's category in `category_override`, but that is your old tool's filing, not a correction you made here. Counted as corrections, the latest imported row would decide every merchant in the history. The same holds after **Remove synced duplicates**: the category it copies onto the synced row it keeps still votes as the imported row did. It is recognised by pairing that row again with the imported copy kept in `_removed`.

Nothing marks a merchant as mixed, and nothing needs to: it is mixed while its corrections name two or more categories (or two or more subcategories). Either way, a guessed row still arrives unconfirmed in the review queue — a guess only saves a tap when it is right.

### What a merchant key is

`PAGAMENTO POS 12/03 CARTA *1234 ESSELUNGA SPA TORINO` becomes the key `esselunga torino`, and `_memory` says what you file that as. Dates, times, card numbers, till numbers, authorisation codes, legal suffixes and about sixty words of Italian banking ceremony are stripped out.

Accents fold to their base letter, and so do the letters that are not an accent on anything — `ø`, `æ`, `ß`, `ł` — so `REMA 1000 KØBENHAVN` keys as `rema kobenhavn` rather than losing the `Kø` to a separator. The card-terminal words other countries print (`KARTENZAHLUNG`, `BETAALAUTOMAAT`, `PAIEMENT`, `COMPRA TARJETA`, …) are stripped with the Italian ones.

**Changing how a key is built changes every key**, so entries learned under the old form stop matching. Nothing needs doing about it: `_memory` is rebuilt from your confirmed rows every night, and the rebuild keys them the new way.

Two decisions in there are worth knowing about, because both look like bugs until you see the reason:

**The city stays in.** `esselunga torino` and `esselunga milano` are two keys. Stripping city names would merge them — right up until the day it merges two genuinely different merchants, which is permanent, silent, and teaches the cascade something false about every future row. Keeping the city costs one extra confirmation per city per merchant, once. The asymmetry isn't close.

**`COOP` survives.** It's a legal form (`soc. coop.`) and it's also one of the largest supermarket chains in Italy. `SPA`, `SRL`, `GMBH` and friends are stripped; this one isn't.

**A key matches whole.** `esselunga` and `esselunga torino` are two entries in `_memory`, and each earns its own confirmation — so your BudgetBakers history (`Esselunga`) and your bank (`ESSELUNGA SPA TORINO`) are two merchants until you have confirmed one of each. That is one extra swipe, once, in exchange for a lookup that either hits or does not. A merchant whose descriptor varies more than that is what `rules` is for: a `contains` pattern says "however this one renders, file it here", which is the statement a key deliberately cannot make.

---

## The loop you actually use

**1. Import your history first.** It arrives `confirmed`, because you categorised it once already in the tool it came from.

**2. Spendsheet → Learn from corrections.** Builds `_memory` from every confirmed row. On a five-year export this is most of your merchants in one go.

**3. Spendsheet → Re-categorise all.** Fills `category_auto` for everything.

**4. Filter `category_source = unclassified`.** That's the queue. Type a `category_override` on the rows that matter.

**5. Learn from corrections again**, or leave it for tonight. Those merchants are now automatic.

From then on it runs itself: memory is rebuilt from your corrections at 3am, the sync categorises new rows as they land an hour later, and the queue is a handful of genuinely-new merchants a month. The menu item is for when you would rather not wait until morning.

### Confirming

A guessed category and a category you agreed with are not the same fact.

**Spendsheet → Confirm visible rows.** Filter to a merchant, glance down the column, confirm forty rows at once. It takes a selection of two or more rows, or the current filter view — and it **refuses** when you have neither, because ticking four thousand rows by accident is exactly the mistake that makes the flag meaningless.

Confirming does two things: it freezes that row's `category_auto` against future rule changes, and it makes the row eligible for learning. Picking a `category_override` or a `subcategory_override` counts as confirming without the tick.

**Confirming a row a rule answered does not teach memory.** At the default `memory_priority` memory is offered first, so a rule that taught memory its own answer would go on being obeyed *through* memory after you had corrected the rule — with the `rules` tab looking ignored and the reason on a tab you never edit. Nothing is lost by it: the rule already says that, on a tab you can change. Overriding a rule's answer still teaches, which is the case memory exists for.

**On a phone, use the `review` tab instead.** It holds the unconfirmed backlog, oldest first, with a checkbox and a category dropdown next to each row — and a tick there writes straight back to `transactions`. That is the whole reason it exists: custom menus do not exist in the Sheets mobile app, so *Confirm visible rows* is a desktop tool and the checkbox is the one that works everywhere. See [`REPORTS.md`](REPORTS.md#review).

Never automatic. Every row waits for you, whichever tier answered it — a row confirmed by elapsed time, or by the guess agreeing with itself, is a row nobody looked at wearing a badge that says somebody did.

---

## Transfers

Money moving between your own accounts is neither spending nor income, and counting it as either inflates both sides by the same amount — invisible in the net figure, wrong in every category total.

Tier 2 pairs the legs by amount and proximity: equal to the cent, opposite in sign, **different accounts**, within `transfer_window_days` (default 4). Both legs get a shared `transfer_group` and category `Transfer`, whose `kind` is `transfer`, which is what takes them out of the reports.

Four days rather than same-day because in a real export the two legs of one move were booked **three days apart**.

A row you have already categorised as something that isn't a transfer is skipped entirely.

> **When you pivot, filter `type ≠ transfer`.** Otherwise the transfer net appears in your grand total and looks like a discrepancy against whatever you're reconciling with.

### The leg that has no bank to report it

Pairing needs two rows, and one common move only ever produces one. A cash withdrawal is a single debit: the bank takes €100 and nothing credits your wallet, because a wallet has no API. The row is correctly a transfer and correctly out of your spending — and net worth is €100 short of the money in your pocket.

Marking a transfer **from the phone** asks where it went, and what it does with the answer depends on the account's kind — which is the same distinction tier 2 makes, arrived at from the other side.

**A `cash` or `asset` destination gets the leg written.** Nothing will ever report it, so there is nothing for tier 2 to pair.

**A `bank` destination gets the leg *found*.** The credit is already in the book, or arrives with the next sync, so the two rows are paired and both marked — tier 2's own three tests, asked about one row rather than about all of them: equal to the cent, opposite in sign, a different account, inside `transfer_window_days`, nearest date winning. Writing a leg here would be a second copy of money that moved once, with no provider id for dedup to match it on.

If nothing matches yet — the ordinary case on the day you move the money — it marks this side and says so. `transferEligible_` treats a row whose override resolves to `kind: transfer` as still pairable, so tier 2 finishes the job on the next sync, and the group id the app writes is the one tier 2 would derive (`tr:` plus the **debit's** uid, whichever side that is). The two agree by construction rather than by luck.

*"Somewhere outside Spendsheet"* is the honest answer for a bank you do not sync, or a person — still not spending, so still a transfer, and net worth does fall because it has left.

One row is never taken from an existing pair: a counter-leg that already carries a `transfer_group` is skipped, because that column is the only record the earlier pairing happened.

The leg carries `source = transfer-leg` and its uid is derived from the row it came from, so recording the same move twice writes nothing the second time.

### Three subcategories under Transfer, and one of them is not a transfer at all

`Between accounts` and `Cash withdrawal` are what they say. **`Valuation change`** is the odd one: it is how an asset account's value moves, written by the phone's **Update balance** screen as the difference between what the account said and what you tell it it says now.

Which of the three a marked transfer gets used to be inferred from the destination alone — cash out of a bank meant `Cash withdrawal`, everything else meant `Between accounts`. That is right when you have a wallet account to withdraw into and wrong when you do not, so the phone now asks, defaulting to the same guess. A fourth subcategory added to the `Transfer` rows of `categories` appears in that dropdown on its own.

It sits under `Transfer` because of `kind`. A €1,500 market gain must not appear in *income this month* — it is not money you received — while still moving net worth, and `kind: transfer` is exactly the switch that does both. See [`docs/MOBILE.md`](MOBILE.md#asset-accounts-without-a-balance-history-tab).

---

## Adding a category

Type it on the next empty row of the `categories` tab. Four columns are yours; the four beside them are not.

| Column | |
|---|---|
| `category` | the parent. A new one lands at the **bottom** of every dropdown — `parent_list` is a `UNIQUE` in tab order, not sorted, because the seed order is Income first and `Other` last, which is how you think about them |
| `subcategory` | the child. These *are* sorted, so a new one lands alphabetically among the eighty |
| `kind` | `expense` · `income` · `transfer`. Describes the parent — see below |
| `icon` | one emoji, shown beside the category on the phone. Decoration; blank is fine |

**Never type into E–H.** Those are four `ARRAYFORMULA` anchors sitting in row 2, and a value typed underneath one is a value that stops it expanding.

**Nothing needs re-running.** Every category dropdown in this book points at the *range* `categories!E2:E` and every subcategory dropdown at `F2:F`, rather than at a list built in code — which is the entire reason those two columns exist. A row you type is offered by `transactions`, `cash_entry`, `rules` and `review` the moment you finish typing it, and by the phone the next time it opens, since the app builds its pickers from the tab on each open. No `setup()`, no redeploy.

**Adding a *child* to an existing parent: pick the parent from the dropdown, don't type it.** Column A carries a list of the parents that already exist, and it allows an invalid entry because creating a new parent is the other reason to type there. Typing is how you end up with `Food and Drink` beside `Food & Drink` — two categories, two dropdown entries, and every total split between them. `kind` has a dropdown of the three values for the same reason.

Row order is the parent dropdown's order and nothing here reads a row number, so rearranging is safe. A blank row is harmless too — both list formulas filter empties out.

### Three ways it goes quietly wrong

**A parent needs at least one subcategory row.** A row with column B empty contributes nothing to `child_list`, and the phone's picker drops it outright — that one takes only rows carrying both halves. So a parent with no real divisions still needs a child row to be pickable at all.

**`kind` describes the parent, not the row.** A transaction's `type` is a `VLOOKUP` of its category into `categories!A:C` taking the first match, and the phone reads the first row's kind for the same reason. A parent whose rows disagree resolves to whichever one happens to sit highest — silently, and consistently enough to look deliberate. Give every row of a parent the same kind.

That column is load-bearing rather than descriptive: **`transfer` is what takes a row out of every report.** Give a spending category `transfer` by accident and its money leaves your totals while the transactions sit there looking correctly filed.

**A subcategory name must identify exactly one parent.** `child_list` is a sorted `UNIQUE`, so two parents sharing a child name collapse into one indistinguishable dropdown entry — and the lookup that resolves a chosen child back to its parent takes the first match and says nothing about the second. The seed shipped with `Home` under both Shopping and Insurance and `Books` under both Shopping and Education; both were renamed rather than disambiguated, because *which Home did you mean* is not a question a dropdown can ask. A unit test holds the seed to this and `runSmokeTests()` holds your live tab to it, precisely because the tab is yours to extend and `Other` under everything is the natural way to extend it.

### A new category categorises nothing

The cascade only ever writes a category some tier *names*, so a new one is an empty bucket until a rule points at it, `_memory` learns it, or you type it as an override. **Re-categorise all** will not find it either.

The way to fill one is the loop above: type it as a `category_override` on a few rows — which counts as confirming them — then **Learn from corrections**, and the merchant is automatic from then on.

---

## Labels

Categories answer *what did I buy*. Labels answer *what was this for* — `kids`, `travel`, `home-renovation` — and the two are genuinely independent: a holiday is flights **and** restaurants **and** a pharmacy, each of which means something else the rest of the year.

Type them comma-separated into `transactions.labels`. Many per row is normal and is the reason this isn't a second category field. The `labels` tab holds the set and reports transactions and total per label.

Labels never affect a category, a `type` or any total. And the cascade never guesses one: merchant → category is a stable relationship worth learning, merchant → label is not. The same supermarket is `kids` one week and nothing the next.

**Not on a transfer.** The phone will not set one there and the server refuses the write, because a label is an axis over *spending* and a transfer is the same money in two places, excluded from every total through `in_reports` — so a label on one is a filter that can never match what it was set to find. The tab itself is not policed: a label typed straight into `transactions.labels` on a transfer row stays where you put it.

### Adding a label

Type the name in `labels!A` and, if you want one, a description beside it. The last two columns are formulas covering the whole column, so the new row starts reporting itself at once — zero transactions and €0.00 until you tag something.

Then tag rows by typing into `transactions.labels`. There is deliberately **no dropdown** there: a list rule would flag every multi-label row with a warning triangle, which trains you to ignore warnings. The `labels` tab catches a typo instead — the misspelling appears there with zero transactions against it, next to the real one with all of them. `cash_entry.labels` does get a dropdown, reading this tab, and still accepts a typed pair.

**On the phone the label chips *are* this tab**, which is the practical reason to add the row before you need it: a label that isn't here cannot be ticked there.

**Keep the names distinct, and specifically don't make one a prefix of another.** The two report columns match by wildcard substring, so a `kids` row counts `kids-school` too. The phone's label *filter* splits on commas and matches whole names, so it doesn't — meaning the same two labels disagree between the tab and the app, with the tab over-counting. Matching whole items inside a comma-separated cell needs the range transformed before `SUMIFS` sees it, which `SUMIFS` does not allow; distinct names cost nothing and remove the question.

`total_eur` reads `amount_base` and carries the `in_reports` condition, like every total in this book. It is signed, so a label covering both a purchase and its refund nets out — the honest figure for "what did this cost".

The three seeded labels are examples; replace them. `labels` is **never re-seeded**, so one you delete stays deleted. Empty the tab completely and re-run `setup()` if you want the examples back.

---

## Rules

`rules` is yours. It is seeded once and **never re-seeded**, so a rule you delete stays deleted.

| Column | |
|---|---|
| `priority` | lower fires first. MCC rules are 10–99, text rules 100+ |
| `field` | `mcc` · `description` · `counterparty` · `bank_transaction_code` |
| `match_type` | `contains` (default) · `equals` · `starts_with` · `regex` |
| `pattern` | matched case-insensitively |
| `account_filter` | blank for all, or an `account_id`/account name |
| `enabled` | untick to park a rule without losing it |

A typo in `field` matches **nothing**, deliberately — the alternative is `contains ""` matching every row and recategorising the whole sheet. A half-typed `regex` matches nothing too, rather than breaking the run that reads it.

At the default `memory_priority` a rule sits *below* memory, so the way to change a merchant memory has learned is to correct a row, not to add a rule — memory picks the correction up overnight, or at once from **Learn from corrections**. Raising `memory_priority` above the highest rule priority reverses that — see [the cascade](#the-cascade) for what else it changes.

### Adding a rule

**From the phone: long-press a transaction.** The pattern is prefilled from the server's own merchant normaliser rather than a second copy of it in the page, the category picker is the one every other sheet uses, and every field is still editable before saving. Priority is assigned for you — one step past the highest on the tab, in tens, so there is room to slot one in by hand between two of them later. It refuses a pattern under two characters, a field or match type it doesn't recognise, a regex that will not compile, and a category that isn't in `categories`. See [`MOBILE.md`](MOBILE.md#tapping-a-transaction).

**On the tab: type a row**, on the first empty one. `field`, `match_type`, `category`, `subcategory` and `type` all have dropdowns; `enabled` is a checkbox and an unticked rule is ignored rather than deleted.

Two things the tab does not check, both silent:

**Give it a priority.** A blank one reads as zero, which is lower than every seeded rule, so the rule you added last fires *first* — and if that blank row happens to be the **last** on the tab it is not read at all, because a rule row is found by scanning down the `priority` column for the last non-empty cell. Fired first or invisible, and neither says anything.

**Name a category that exists.** A rule naming one that doesn't still matches and still writes it; then `type`'s `VLOOKUP` finds nothing, `in_reports` comes back FALSE, and the row leaves every report with no error anywhere. This is the quietest failure available here, which is why the phone refuses such a rule outright.

`type` on a rule is not read by the cascade at all — a row's type comes from its category's `kind` — but the column is there and a blank in it reads as an unfinished row. Fill it to match the category.

### A new rule changes nothing already in the book

The cascade runs on sync, so a rule takes effect on rows that arrive after it. **Spendsheet → Re-categorise all** applies it to what is already there — with one exception that matters more than it sounds: **a confirmed row keeps whatever it was confirmed with.** An imported history arrives confirmed, so no rule you add afterwards will touch it.

To make a rule reach a row you have already confirmed, untick `confirmed` on that row and re-categorise. The phone's toast says the same thing in a line, because otherwise the feature reads as broken: you make a rule for a merchant you have seen ten times, go back, and all ten are exactly as they were.

---

## When the taxonomy changes

`setup()` adds seed rows and never removes them — it can't tell a row you deleted from one you never had. So a category that gets retired stays in `categories` forever, offered by every dropdown.

Removing it isn't enough on its own, either. A `_category_map` row, a `rules` row or a `category_override` still naming a retired category doesn't break — it goes **invisible**. The row is categorised as something no report groups by, so its money quietly leaves every total while the sheet looks fine.

**Spendsheet → Set up and maintain → Tidy retired categories** does both, in that order: repoints everything that pointed at a retired category, then removes it. It names every change before making any of them.

The known retirements are the taxonomy shrink from fifteen parents to twelve, and one parent renamed:

| Retired | Became |
|---|---|
| `Bills & Utilities / *` | `Housing / *` |
| `Travel / Flights`, `Accommodation`, `Holiday` | `Life & Entertainment / …` |
| `Family / Kids` | `Shopping / Kids` |
| `Family / Life events` | `Life & Entertainment / Life events` |
| `Entertainment / *` | `Life & Entertainment / *` |
| `Insurance / Home` | `Insurance / Home insurance` |
| `Education / Books` | `Education / Textbooks` |

A `category_override` holds a parent with no subcategory, so a parent is only rewritten when all of its children agree where they went. `Travel` always became `Life & Entertainment`; **`Family` split between `Shopping` and `Life & Entertainment`**, so rows naming just `Family` are reported and left for you to retype.

Three of these are renames rather than moves, and they split into two kinds. `Entertainment / *` renames the **parent** and keeps every child name, so all seven children agree and a `category_override` saying `Entertainment` is rewritten without being asked about — the children need nothing, because a cell saying `Streaming` finds its parent through a lookup.

The other two rename a **child**: `Home` named both a Shopping and an Insurance subcategory, and `Books` both a Shopping and an Education one, which made the dropdown entry for each ambiguous. The parent is unchanged, so nothing about `Insurance` or `Education` is retired.

A child rename is also the one case the tidy can't finish for you. `subcategory_override` holds a bare child name, and `Home` is still a Shopping subcategory, so a row saying `Home` keeps resolving to Shopping — which is what it already did, since the lookup has always taken the first match. Those rows are counted and named in the dialog and left untouched. **If one of them was your home insurance, it is yours to retype**; the review queue's subcategory picker now offers `Home insurance` as a distinct entry.

---

## Deliberately not included

**LLM categorisation.** Calling a model for unknown merchants would work and would cost pennies — but it adds an API key, an external dependency and a per-row cost to something whose whole premise is free and maintenance-free, and the match list makes it largely unnecessary. If you want it, it's a hook between tier 3 and `unclassified`; it stays off by default.
