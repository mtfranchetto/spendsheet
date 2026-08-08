# Categorising

Every row gets a category without you doing anything, and the ones it can't work out go to a queue rather than into a bucket called "Other". Correcting one teaches it that merchant forever.

No machine learning, no API key, no per-row cost. The whole thing is a lookup table you built by using the app.

---

## The cascade

Six tiers, first hit wins. Every row records **which tier decided it** in `category_source`, so "why is this Groceries?" always has an answer.

| # | Tier | `category_source` | How it decides |
|---|---|---|---|
| 1 | Override | `override` | you typed a `category_override`. Always wins |
| 2 | Transfer | `transfer` | the row is one leg of a matched pair — see below |
| 3 | **Memory** | `memory` | merchant key → the category you have most often given it |
| 4 | MCC | `mcc` | `merchant_category_code` → category, via `rules` |
| 5 | Text | `rule` | contains/regex over description or counterparty, via `rules` |
| 6 | — | `unclassified` | nothing matched. Goes to a queue, **never** to "Other" |

Tier 4 is a bonus rather than a foundation — PSD2 banks populate MCC inconsistently — which is exactly why memory sits above it instead of depending on it.

### Tier 3 is the workhorse

`PAGAMENTO POS 12/03 CARTA *1234 ESSELUNGA SPA TORINO` becomes the key `esselunga torino`, and `_memory` says what you file that as. Dates, times, card numbers, till numbers, authorisation codes, legal suffixes and about sixty words of Italian banking ceremony are stripped out.

Two decisions in there are worth knowing about, because both look like bugs until you see the reason:

**The city stays in.** `esselunga torino` and `esselunga milano` are two keys. Stripping city names would merge them — right up until the day it merges two genuinely different merchants, which is permanent, silent, and teaches the cascade something false about every future row. Keeping the city costs one extra confirmation per city per merchant, once. The asymmetry isn't close.

**`COOP` survives.** It's a legal form (`soc. coop.`) and it's also one of the largest supermarket chains in Italy. `SPA`, `SRL`, `GMBH` and friends are stripped; this one isn't.

The gap that leaves — your BudgetBakers history says `Esselunga`, your bank says `ESSELUNGA SPA TORINO` — is closed at **lookup** time instead. A shorter learned key matches a longer transaction key by containment, on whole words only, longest match first. So the imported history categorises bank rows it has never seen the descriptor for.

---

## The loop you actually use

**1. Import your history first.** It arrives `confirmed`, because you categorised it once already in the tool it came from.

**2. Spendsheet → Learn from corrections.** Builds `_memory` from every confirmed row. On a five-year export this is most of your merchants in one go.

**3. Spendsheet → Re-categorise all.** Fills `category_auto` for everything.

**4. Filter `category_source = unclassified`.** That's the queue. Type a `category_override` on the rows that matter.

**5. Learn from corrections again.** Those merchants are now automatic.

From then on the nightly sync categorises new rows as they land, and the queue is a handful of genuinely-new merchants a month.

### Confirming

A guessed category and a category you agreed with are not the same fact.

**Spendsheet → Confirm visible rows.** Filter to a merchant, glance down the column, confirm forty rows at once. It takes a selection of two or more rows, or the current filter view — and it **refuses** when you have neither, because ticking four thousand rows by accident is exactly the mistake that makes the flag meaningless.

Confirming does two things: it freezes that row's `category_auto` against future rule changes, and it makes the row eligible for learning. Typing a `category_override` counts as confirming without the tick.

**On a phone, use the `review` tab instead.** It holds the unconfirmed backlog, oldest first, with a checkbox and a category dropdown next to each row — and a tick there writes straight back to `transactions`. That is the whole reason it exists: custom menus do not exist in the Sheets mobile app, so *Confirm visible rows* is a desktop tool and the checkbox is the one that works everywhere. See [`REPORTS.md`](REPORTS.md#review).

Never automatic. A row confirmed by elapsed time is a row nobody looked at, wearing a badge that says somebody did.

---

## Transfers

Money moving between your own accounts is neither spending nor income, and counting it as either inflates both sides by the same amount — invisible in the net figure, wrong in every category total.

Tier 2 pairs the legs by amount and proximity: equal to the cent, opposite in sign, **different accounts**, within `transfer_window_days` (default 4). Both legs get a shared `transfer_group` and category `Transfer`, whose `kind` is `transfer`, which is what takes them out of the reports.

Four days rather than same-day because in a real export the two legs of one move were booked **three days apart**.

A row you have already categorised as something that isn't a transfer is skipped entirely.

> **When you pivot, filter `type ≠ transfer`.** Otherwise the transfer net appears in your grand total and looks like a discrepancy against whatever you're reconciling with.

---

## Labels

Categories answer *what did I buy*. Labels answer *what was this for* — `kids`, `travel`, `home-renovation` — and the two are genuinely independent: a holiday is flights **and** restaurants **and** a pharmacy, each of which means something else the rest of the year.

Type them comma-separated into `transactions.labels`. Many per row is normal and is the reason this isn't a second category field. The `labels` tab holds the set and reports transactions and total per label.

Labels never affect a category, a `type` or any total. And the cascade never guesses one: merchant → category is a stable relationship worth learning, merchant → label is not. The same supermarket is `kids` one week and nothing the next.

---

## Editing the rules

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

Rules sit *below* memory, so the way to override a merchant memory has learned is to correct a row and re-learn, not to add a rule.

---

## When the taxonomy changes

`setup()` adds seed rows and never removes them — it can't tell a row you deleted from one you never had. So a category that gets retired stays in `categories` forever, offered by every dropdown.

Removing it isn't enough on its own, either. A `_category_map` row, a `rules` row or a `category_override` still naming a retired category doesn't break — it goes **invisible**. The row is categorised as something no report groups by, so its money quietly leaves every total while the sheet looks fine.

**Spendsheet → Set up and maintain → Tidy retired categories** does both, in that order: repoints everything that pointed at a retired category, then removes it. It names every change before making any of them.

The known retirements are the taxonomy shrink from fifteen parents to twelve:

| Retired | Became |
|---|---|
| `Bills & Utilities / *` | `Housing / *` |
| `Travel / Flights`, `Accommodation`, `Holiday` | `Entertainment / …` |
| `Family / Kids` | `Shopping / Kids` |
| `Family / Life events` | `Entertainment / Life events` |
| `Insurance / Home` | `Insurance / Home insurance` |
| `Education / Books` | `Education / Textbooks` |

A `category_override` holds a parent with no subcategory, so a parent is only rewritten when all of its children agree where they went. `Travel` always became `Entertainment`; **`Family` split between `Shopping` and `Entertainment`**, so rows naming just `Family` are reported and left for you to retype.

The last two are renames rather than moves — `Home` named both a Shopping and an Insurance subcategory, and `Books` both a Shopping and an Education one, which made the dropdown entry for each ambiguous. The parent is unchanged, so nothing about `Insurance` or `Education` is retired.

A rename is also the one case the tidy can't finish for you. `subcategory_override` holds a bare child name, and `Home` is still a Shopping subcategory, so a row saying `Home` keeps resolving to Shopping — which is what it already did, since the lookup has always taken the first match. Those rows are counted and named in the dialog and left untouched. **If one of them was your home insurance, it is yours to retype**; the review queue's subcategory picker now offers `Home insurance` as a distinct entry.

---

## Deliberately not included

**LLM categorisation.** Calling a model for unknown merchants would work and would cost pennies — but it adds an API key, an external dependency and a per-row cost to something whose whole premise is free and maintenance-free, and tier 3 makes it largely unnecessary. If you want it, it's a hook above tier 6; it stays off by default.
