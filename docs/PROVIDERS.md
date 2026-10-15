# Provider findings

Per-bank observations. None of this is knowable from documentation — every line of it was probed against a live production connection, because the questions it answers are load-bearing for the code and the alternative is undocumented assumptions.

## What gets recorded, per bank

| Question | Why it matters |
|---|---|
| Does it appear in the ASPSP list, and under what name? | Fineco is likely reachable via CBI Globe; neither it nor illimity is confirmed by name in published material |
| Which balance types does it return? | The enum is `CLBD`/`FWAV`/`ITAV`/`ITBD`/`OTHR`/`VALU`/`XPCD` and each bank supports only some. `pickBalance()`'s preference order has to actually hit something |
| Does it populate `entry_reference`? | Determines whether dedup uses the strong key or the composite fallback |
| Does it populate `merchant_category_code`? | MCC is a clean, language-independent categorisation signal — but banks populate it inconsistently, which is why learned memory sits above it in the cascade rather than depending on it |
| What's the real maximum consent duration? | The spec allows up to 180 days; banks grant less. Drives the re-auth reminder cadence |
| Any non-EUR balances? | A foreign-currency *spend* from a EUR account arrives already converted. This only bites if you hold an actual GBP or USD balance as a separate currency account |

## Text that does not arrive as UTF-8

JSON is UTF-8 by definition and not every bank sends it that way: one sent `MÜNCHEN` as Latin-1, and a UTF-8 decode turned each `Ü` into a replacement diamond. `responseText_` in `02_api.gs` now decides on the **bytes** — a body that is not well-formed UTF-8 is read as Windows-1252, and one that is, is left alone. The sync logs `text_redecoded` to `_anomalies` the first time an account needs this, once, so a bank sending the wrong encoding is a recorded finding rather than something corrected invisibly for ever.

`text_lost` is the other case: a body that *is* valid UTF-8 but already carries the diamond, because the bank lost the letter before sending it. Nothing on this side can recover that. It is logged when such a row is first written, not on each later sync that fetches it again.

Rows stored before the fix keep their diamonds, because the sync never rewrites a row it already holds. The fix changes no uid: `normalizeDescription` maps both `Ü` and the diamond to the same space, so the first sync afterwards recognises every row it already has.

## Why sandbox can't answer these

Enable Banking's sandbox exposes the Mock ASPSP plus a limited set of real bank sandboxes. It's genuinely useful — it's a configurable simulator, so it can produce failure modes that are otherwise impossible to trigger on demand (expired sessions, 429s, absent `entry_reference`, missing balance types).

But it cannot tell you what **your** banks do. Sandbox proves the code paths; production restricted proves the data. That's a real sequencing constraint, and it's why the provider probe is its own step rather than something folded into building the client.

## Banks in scope

| Bank | Status | Notes |
|---|---|---|
| Mock ASPSP (sandbox) | probed 2026-07-30 | see below |
| Revolut | not yet probed | has an Enable Banking connector |
| Fineco | probed 2026-08-01 | reachable as **FinecoBank**; four currency sub-accounts, see below |
| illimity | not yet probed | see below |
| PayPal (IT) | probed 2026-10-15 | no `booking_date`, see below |

## Mock ASPSP — sandbox, probed 2026-07-30

Not a real bank, but it establishes the response shapes the client has to
handle, and two of them were not what we had assumed.

**The session carries identifiers only.** `POST /sessions` returns `accounts`
as a list of UID *strings*, with a parallel `accounts_data` holding one object
per account — and for this provider those objects contain nothing but `uid`,
`identification_hash` and `identification_hashes`. No name, no currency, no
IBAN. Anything descriptive requires a second call.

```json
{"status":"AUTHORIZED",
 "accounts":["a8160088-…"],
 "accounts_data":[{"uid":"a8160088-…","identification_hash":"…"}],
 "aspsp":{"name":"Mock ASPSP","country":"IT"},
 "access":{"balances":true,"transactions":true,"valid_until":"2027-01-26T19:55:29.069000Z"}}
```

**`GET /accounts/{uid}/details` fills some of it in**, but `name` is the
**account holder**, not a label for the account:

| Field | Value | Note |
|---|---|---|
| `name` | the account holder's own name | the holder — not the account name |
| `product` | `null` | where a bank would normally put a label |
| `details` | `null` | |
| `currency` | `EUR` | usable |
| `account_id` | `null` | so no IBAN, and `iban_masked` stays blank |
| `usage` | `PRIV` | |
| `cash_account_type` | `CACC` | current account |
| `psu_status` | `Co-account Holder` | |

**The account nickname configured in the control panel is not exposed.** It's a
convenience label in Enable Banking's own UI; nothing in the API carries it. So
for this provider the `name` column is yours to set — which reconnecting
preserves.

Whether real banks put an account label in `name` or `product` is the open
question, and one a simulator can't answer. `usage` and `cash_account_type`
look like a reasonable basis for a better default label if they turn out to be
consistently populated.

**Consent validity** was accepted at the full 180 days requested.

**illimity is on a clock.** Banca Ifis took it to 92.5% and delisted it in September 2025, with full integration completing in autumn 2026. Its connector will move or disappear. Provider identity is one field in `accounts` and `_status`, so migrating is a config edit — and the transaction history is unaffected either way. This is the concrete case for the connector being treated as disposable.


## Fineco — production restricted, probed 2026-08-01

Appears as **FinecoBank**. Reachable directly; no CBI Globe intermediary was involved in picking it from the list.

### One IBAN, four accounts

The headline finding, and it settles the open non-EUR question — for Fineco rather than Revolut, which is not where it was expected:

Identifiers below are redacted — they are one book's account resources, and what
matters here is their shape rather than their value.

| `account_id` | currency | IBAN |
|---|---|---|
| a UUID | EUR | one IBAN, `IT…` |
| a different UUID | CHF | the same IBAN |
| a different UUID | GBP | the same IBAN |
| a different UUID | USD | the same IBAN |

Fineco exposes each currency pocket as its own account resource. **All four share one IBAN and all four carry the account holder's own name** — the holder, not the account — so neither `name` nor `iban_masked` distinguishes them. `currency` is the only field that does.

Two consequences worth knowing before you connect it:

**Rename them, or the import can't find them.** `_import_staged` joins `_import_raw` to `accounts` on the account *name*, and four identically named rows resolve to whichever comes first. Give them distinct names — `Fineco EUR`, `Fineco CHF` and so on — matching what your export calls them. A name you type is never overwritten; `upsertAccounts_` only replaces its own `"<provider> account"` placeholder.

**Set `include_in_net_worth` FALSE on the non-EUR three.** `balance` is `balance_api` unconverted, so a CHF balance would be summed as though it were euros. Transactions are already safe — `amount_base` is deliberately blank for any row whose currency isn't the base one, so reports skip them rather than adding them up wrongly — but the balance column has no such guard.

If the foreign-currency pockets are empty or unused, setting `active` FALSE as well stops syncing them entirely. That is three fewer accounts against a rate limit budgeted at roughly four unattended calls per account per day, where one full sync of one account is three.

## PayPal (IT) — production restricted, probed 2026-10-15

**No `booking_date`.** PayPal sends the date only as `transaction_date`. `value_date` is blank too. The first sync wrote every PayPal row with column D empty, and that column is the one everything selects on. Reports and the phone app put the rows in no period. The import cutoff found no oldest date for the account, so it would have staged the whole export. Cross-source matching keys on the date, so it could not match a single row.

`bookingDate()` in `07_transactions.gs` now fills `booking_date` from `value_date`, then `transaction_date`. The two source columns still hold what the bank sent.

**`entry_reference` is filled**, so dedup uses the strong key and the date is not part of a PayPal uid. The fix moved no uid.

**Rows written before the fix keep the blank.** The sync never rewrites a row it holds. Copy `transaction_date` into `booking_date` for that account's rows, by hand, once the fix is deployed. Until then, each sync logs a `dup_entry_ref` anomaly per re-fetched row: same reference, different date. Nothing is written, and the anomalies stop once the column is filled.
