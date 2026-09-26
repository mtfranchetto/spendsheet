# Monitoring

Everything here is built. `12_monitor.gs` holds the detectors; **Spendsheet → Health check** runs them all and reports without emailing, which is the way to see what the alarm would say without waiting for it to say it.

## Running it automatically

**Spendsheet → Set up and maintain → Install triggers.** That's it: a daily time-driven trigger that runs the sync whether or not the spreadsheet is open, whether or not you're logged in, on Google's infrastructure, for free. It's what makes "no server" true rather than aspirational.

Change the hour with `sync_hour` in `_config` (default 4am, in the spreadsheet's timezone) and re-run **Spendsheet → Set up and maintain → Install triggers**. Apps Script picks a random minute within the hour, which is deliberate on their side and harmless here.

It installs three daily triggers and a weekly one:

| Setting | Default | Runs |
|---|---|---|
| `learn_hour` | 3am | rebuilds `_memory` from your corrections ([how memory decides](CATEGORIES.md#how-memory-decides)) |
| `sync_hour` | 4am | the sync |
| `selfcheck_hour` | 9am | the self-check below |
| `snapshot_hour` | 5am, Sundays | the Drive snapshot |

Learning runs **before** the sync so that each night's new rows are categorised with the corrections you made that day; keep `learn_hour` below `sync_hour` if you move either. It has its own trigger rather than being a step inside the sync, for the self-check's reason: a failure in one must not take the other down. Clear any of these cells and that trigger falls back to its own default, not to a shared one. A failed rebuild is recorded in `_anomalies` as `learn_failed` and then **throws**, so the failure email described below covers it. None of the detectors below looks for it.

### Running more than once a day

Comma-separate the hours: `sync_hour` = `4,16` installs two triggers.

This is worth doing, but it is **not twice the data**, and Install triggers tells you so at the moment you choose it. PSD2 caps unattended access at around four calls per account per day and a full sync is three of them — balances, booked, pending. So the first run of the day fetches everything and every later run makes do with what's left: **transactions only, no balance refresh, no pending**.

That's still the right trade. Transactions are the thing that can't be recovered once they fall out of the rolling window; a balance is only ever a few hours stale. But past two runs a day the extra ones are skipped and logged rather than silently doing nothing:

| `sync_hour` | What happens |
|---|---|
| `4` | one full sync |
| `4,16` | full sync, then transactions only |
| `2,8,14,20` | two useful runs; the other two are skipped and logged |

To buy a third useful run, set `fetch_pending` to `no` in `_config` — that frees one call per sync at the cost of the `pending` tab.

**Spendsheet → Set up and maintain → Show schedule** reports what's currently installed, because the Apps Script triggers page is three clicks away inside a different app and "is this actually running?" is a question you ask from the spreadsheet.

Install triggers is **idempotent** — it removes the ones it owns before creating them, and leaves any trigger you added yourself alone. That matters more than it sounds: adding a second nightly sync by hand is two clicks, warns you about nothing, and doubles your API calls every night straight into the rate limit below. You'd see it as "the sync stopped working", days later, with nothing to connect it to.

### Turn on the failure email

Apps Script emails you when a triggered run **throws**, but the default is a daily digest. Make it immediate — it's a per-account setting and can't be set from code:

> [script.google.com](https://script.google.com) → your project → **Triggers** → the pencil on the sync trigger → *Failure notification settings* → **Notify me immediately**

This covers failure 1 only — a run that *threw*. A run where one bank fails and the others succeed is caught and recorded rather than thrown, so Google sees a success and sends nothing; that case is what the five detectors below exist for.

## The six failure modes

Each needs its own detector, because none of them catches the others.

| # | Failure | Detector | Tuned by |
|---|---|---|---|
| 1 | The script threw | Apps Script's built-in trigger-failure email, set to notify immediately | — |
| 2 | One bank broke, the others were fine | per-account try/catch → `_status.last_error`, run marked `PARTIAL` | — |
| 3 | A consent is expiring or expired | `valid_until` against today | `consent_warning_days` |
| 4 | It ran "fine" and returned nothing | zero rows fetched across N consecutive days | `empty_run_threshold_days` |
| 5 | It never ran at all | `selfCheck()` on a **separate trigger**, reading only `_runs` | `stale_threshold_days` |
| 6 | Rows disappeared | row count went *down* — never legitimate in an append-only tab. Alert **and abort** | — |

Two of these are deliberately reluctant to fire, because an alarm you learn to ignore is worse than none:

- **Failure 4** tolerates a single quiet day, and several. Most people have days with no transactions.
- **Failure 5** measures from the last *successful* run, not the last attempt — a sync that has failed every night for a week is not "current".

### When rows disappear, syncing stops

Failure 6 doesn't warn, it **aborts**. Appending to a tab that has silently lost rows writes new history on top of a hole, and every run afterwards makes the restore harder.

The way out: File → Version history to restore what was lost. If the smaller sheet is actually what you meant — you deleted test rows on purpose — **Spendsheet → Set up and maintain → Accept row count** unblocks it. That step is manual by design; a detector that resets itself can't detect anything.

### Alert volume

One email per `kind + connection` per day, and the recipient is `alert_email` in `_config`, or the account owner if that's blank.

A free Google account allows 100 mail recipients a day. A persistent failure checked hourly would burn that in an afternoon and then go silent — and an alarm system that exhausts its own quota is worse than no alarm at all, because by then you believe you have one.

**Failure 4 is the one that quietly ruins these systems.** A green run that silently fetched nothing looks exactly like a healthy one from the outside, and you find out months later when a report looks thin.

**Failure 5 is why `selfCheck()` is its own trigger** rather than part of `syncAll_()`. If it lived inside the sync, a crash would take the alarm down with it — precisely the failure where you most need to hear something.

## A formula that stopped spilling

The six detectors above watch the *sync*. The thing they cannot see is a formula that has quietly stopped producing anything, and **Spendsheet → Diagnostics → Run smoke tests** is what checks for that — every `ARRAYFORMULA` anchor in the book, by reading what its cell actually evaluates to. Two failures look similar and have opposite fixes:

| | What it means | Where the fix is |
|---|---|---|
| `#ERROR!` | the formula itself is wrong — most often a comma in a decimal-comma locale | the code |
| `#REF!` in row 2 | the formula is fine and **something is sitting in the column underneath it** | the sheet |

An `ARRAYFORMULA` anchored in row 2 expands down through the cells below it, and it will not overwrite anything. One non-empty cell in that column and the whole thing collapses to `#REF!` — the column goes blank, and so does everything that reads it.

The report names the blocking cell, so the repair is a selection and a Delete rather than a search:

```
categories!E2 #REF! — The array cannot expand: E3 holds the text "Housing",
and 11 of the 998 cells below E2 are not empty (0 of them formulas).
```

**Read "0 of them formulas" as the go-ahead.** It means nothing down there is a formula of yours, so what is in the way is stored values — usually a derived column's own output, written back as data by something that read it and wrote it again. Select from row 3 to the bottom of that column, delete, and re-run **Setup sheet** to put the formula back. Then re-run the smoke tests.

If the column is *yours* — a note column you added — the answer is the opposite: move it to the right of the schema. The two never share a column, and appending on the right is always safe.

**`categories` E–H are the expensive ones and they fail together**, because whatever wrote one column's spill back as values wrote all four. `parent_list` (E) is the range every category dropdown points at; `child_list` (F) is every subcategory dropdown; `child_key` and `child_parent` (G, H) are the pair the `category` formula crosses to turn a subcategory override into its parent. Clear **E3:H** in one selection rather than one column at a time.

The phone app keeps working throughout, because it reads the stored columns A–D rather than the derived list — which is a good way to be sure this is what you are looking at rather than something worse.

## The honest limit

`selfCheck()` catches `syncAll_()` being broken, hung or crashing. It **cannot** catch both triggers being deleted, or the whole project being disabled: nothing inside the script can report that the script isn't running.

An external dead-man's switch — [healthchecks.io](https://healthchecks.io) has a free tier — is the only real fix. It's deliberately out of scope to keep third-party setup at zero, and will be documented here as a ten-line opt-in for anyone who wants it.

## Rate limits are tighter than they look

Most banks cap unattended fetching at **~4 calls per day per account**, answering `ASPSP_RATE_LIMIT_EXCEEDED` with roughly a 6-hour penalty. A full sync of one account is **3 calls** — balances, booked, pending.

That leaves exactly one spare, so a single impatient "Sync now" after the nightly run can trip it. Mitigations: `_status` tracks calls per account per day, "Sync now" warns before exceeding, the pending fetch is skippable per account, and a 429 is logged `PARTIAL` and left for tomorrow — **never retried in a loop**, which would burn the penalty window and achieve nothing.

## Backups

**A weekly CSV of `transactions` into Drive**, installed by Install triggers alongside the sync. Folder name is `snapshot_folder` in `_config`; run it on demand with Spendsheet → Set up and maintain → Snapshot to Drive.

The folder is best-effort: if Google declines it the CSV is written to My Drive instead and the toast says which. The file is the backup; the folder is tidiness.

**The snapshot goes through the Drive advanced service, not `DriveApp`.** There are two independent gates in front of a Drive write, they fail with messages that read alike, and the snapshot was blocked by both in turn — failing on every run for months while mailing each failure to the same address as every other alert.

*Gate one, the scope.* `DriveApp` is documented against the full `drive` scope — read and write access to your whole Drive — which this project refuses for the reasons in [SETUP.md](SETUP.md). `drive.file`, the scope it does ask for, is per-file access to files this script itself created, and that is an API idea rather than a `DriveApp` one: every `DriveApp` call fails under it with *"Specified permissions are not sufficient"*, whichever method you happened to call first.

*Gate two, the API.* A scope is permission to use an API; it does not switch that API on. The Drive API is off by default in the Cloud project behind a script, and the refusal — *"Google Drive API has not been used in project … before or it is disabled"* — reads like a permissions error and sends you to the scope list, which is the one place with nothing wrong. Google's message links to the Cloud console, and that is a dead end here: this script uses a **default** Cloud project, which the console will not open. What opens the gate is declaring the dependency in [`src/appsscript.json`](../src/appsscript.json), because Apps Script enables the API in a default project for a script that depends on it. If it ever reports as disabled again, the manual equivalent is the Apps Script editor: **Services (+) → Drive API → v3 → Add**.

**Smoke tests include a check that Drive accepts a file from this script** — it writes a small probe file into the backup folder and deletes it again. Whether Google permits the write is a fact about this book's consent and its Cloud project, so nothing that runs in CI can stand in for it, and a backup is the one feature whose failure has no other symptom. Run them before assuming a weekly snapshot worked.

Version history is not a backup here. A free account keeps **30 days or 100 revisions, whichever comes first** — and a daily sync burns 100 revisions in roughly three months, so discovering in June that something broke in March means it's genuinely gone.

CSV rather than a copy of the spreadsheet, because the point of this project is that the data outlives the tooling: a CSV opens in anything, forever. Every field is quoted and every date written ISO, so no locale and no stray comma can shift a column on the way back in.

**Drive is still Google.** If the account is lost, the snapshots go with it. An occasional File → Download → .xlsx kept somewhere else is the off-Google backup, and it stays a manual step.

**Test the restore.** An untested backup isn't a backup: import a snapshot CSV into a blank sheet and confirm it reads correctly. It takes two minutes and it's the only way to know.
