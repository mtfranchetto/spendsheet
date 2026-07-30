# Monitoring

> **Not written yet.** Lands in phase 8, alongside `12_monitor.gs`.

## The six failure modes

Each needs its own detector, because none of them catches the others.

| # | Failure | Detector |
|---|---|---|
| 1 | The script threw | Apps Script's built-in trigger-failure email, set to notify immediately |
| 2 | One bank broke, the others were fine | per-account try/catch → `_status.last_error`, run marked `PARTIAL` |
| 3 | A consent is expiring or expired | `valid_until` → `days_left`, alert at ≤7 days |
| 4 | It ran "fine" and returned nothing | `rows_fetched` = 0 across all accounts for 3 consecutive days |
| 5 | It never ran at all | `selfCheck()` on a **separate trigger**, reading only `_runs` |
| 6 | Rows disappeared | row count went *down* — never legitimate in an append-only tab. Alert **and abort** |

**Failure 4 is the one that quietly ruins these systems.** A green run that silently fetched nothing looks exactly like a healthy one from the outside, and you find out months later when a report looks thin.

**Failure 5 is why `selfCheck()` is its own trigger** rather than part of `syncAll()`. If it lived inside the sync, a crash would take the alarm down with it — precisely the failure where you most need to hear something.

## The honest limit

`selfCheck()` catches `syncAll()` being broken, hung or crashing. It **cannot** catch both triggers being deleted, or the whole project being disabled: nothing inside the script can report that the script isn't running.

An external dead-man's switch — [healthchecks.io](https://healthchecks.io) has a free tier — is the only real fix. It's deliberately out of scope to keep third-party setup at zero, and will be documented here as a ten-line opt-in for anyone who wants it.

## Rate limits are tighter than they look

Most banks cap unattended fetching at **~4 calls per day per account**, answering `ASPSP_RATE_LIMIT_EXCEEDED` with roughly a 6-hour penalty. A full sync of one account is **3 calls** — balances, booked, pending.

That leaves exactly one spare, so a single impatient "Sync now" after the nightly run can trip it. Mitigations: `_status` tracks calls per account per day, "Sync now" warns before exceeding, the pending fetch is skippable per account, and a 429 is logged `PARTIAL` and left for tomorrow — **never retried in a loop**, which would burn the penalty window and achieve nothing.

## Alert volume is capped

A free Google account allows 100 mail recipients per day. Alerts are deduplicated by `kind + account` per 24 hours, so a persistent failure sends one email a day rather than one per detector per run.

An alarm system that burns its own quota and then goes silent is worse than no alarm at all.
