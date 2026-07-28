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
| Revolut | not yet probed | has an Enable Banking connector |
| Fineco | not yet probed | behind CBI Globe |
| illimity | not yet probed | see below |

**illimity is on a clock.** Banca Ifis took it to 92.5% and delisted it in September 2025, with full integration completing in autumn 2026. Its connector will move or disappear. Provider identity is one field in `accounts` and `_status`, so migrating is a config edit — and the transaction history is unaffected either way. This is the concrete case for the connector being treated as disposable.
