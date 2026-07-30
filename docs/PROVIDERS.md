# Provider findings

Per-bank observations. **Empty until phase 3**, because none of it is knowable from documentation — it has to be probed against a live production connection.

This file exists now because the questions it answers are already load-bearing for the code, and it's better to name them than to let them become undocumented assumptions.

## What gets recorded, per bank

| Question | Why it matters |
|---|---|
| Does it appear in the ASPSP list, and under what name? | Fineco is likely reachable via CBI Globe; neither it nor illimity is confirmed by name in published material |
| Which balance types does it return? | The enum is `CLBD`/`FWAV`/`ITAV`/`ITBD`/`OTHR`/`VALU`/`XPCD` and each bank supports only some. `pickBalance()`'s preference order has to actually hit something |
| Does it populate `entry_reference`? | Determines whether dedup uses the strong key or the composite fallback |
| Does it populate `merchant_category_code`? | MCC is a clean, language-independent categorisation signal — but banks populate it inconsistently, which is why learned memory sits above it in the cascade rather than depending on it |
| What's the real maximum consent duration? | The spec allows up to 180 days; banks grant less. Drives the re-auth reminder cadence |
| Any non-EUR balances? | A foreign-currency *spend* from a EUR account arrives already converted. This only bites if you hold an actual GBP or USD balance as a separate currency account |

## Why sandbox can't answer these

Enable Banking's sandbox exposes the Mock ASPSP plus a limited set of real bank sandboxes. It's genuinely useful — it's a configurable simulator, so it can produce failure modes that are otherwise impossible to trigger on demand (expired sessions, 429s, absent `entry_reference`, missing balance types).

But it cannot tell you what **your** banks do. Sandbox proves the code paths; production restricted proves the data. That's a real sequencing constraint, and it's why the provider probe is its own step rather than something folded into building the client.

## Banks in scope

| Bank | Status | Notes |
|---|---|---|
| Mock ASPSP (sandbox) | probed 2026-07-30 | see below |
| Revolut | not yet probed | has an Enable Banking connector |
| Fineco | not yet probed | behind CBI Globe |
| illimity | not yet probed | see below |

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
| `name` | `Mattia Franchetto` | the holder — not the account name |
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
