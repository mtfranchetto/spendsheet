# Setup

> **Not written yet.** Bank connection lands in phases 2–3; this document is written alongside it, because a setup guide for a flow that doesn't exist would be fiction.
>
> The [README](../README.md#setup) has the intended shape of it: sandbox first with no paperwork, production once you're convinced.

What's usable today is step 1–2 and 6 of that list — create a Sheet, set the locale, paste `src/`, run `setup()` from the **Spendsheet** menu. That builds all 19 tabs. Nothing syncs yet.

Two things worth knowing before you start, because they're decided once and awkward to change later:

**Use a personal Google account, not a work one.** Not for quota reasons — the free consumer quotas are ~1000× what this needs. It's that years of personal financial data would otherwise sit in a tenant your employer's admins can access, subject to their retention and DLP policies, and you'd lose all of it the day you leave.

**Set the spreadsheet locale to match your bank's number format** (File → Settings). For Italian banks that's Italy, which makes Sheets natively parse `1.234,56` and `dd/mm/yyyy` on CSV import. This replaces parsing code that would otherwise have to be written and tested — it is genuinely just a locale setting.
