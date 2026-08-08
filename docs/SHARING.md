# Sharing the book with someone else

A household ledger has two people in it. This is how to give the second one
access to the Sheet and to the app, and what each of those actually exposes.

Both are one-time human operations, so they are written down here rather than
automated — the governing rule in `CLAUDE.md`.

> **The one thing not to do:** give someone your Google password. It puts them
> inside the account holding your bank credentials, and it makes the sheet's
> own edit history say your name for both pairs of hands.

---

## 1. The Sheet

Nothing special. Open it, **Share**, add their address, choose a role:

| Role | Can they | Use it when |
|---|---|---|
| **Editor** | tick `confirmed`, set categories, type into `cash_entry`, edit `rules` and `categories` | they are keeping the ledger with you — the usual answer |
| **Viewer** | read everything, change nothing | they want to see the numbers and not maintain them |

**Editor is the honest default** if they will use the app at all, because
everything the app writes is a write to the Sheet.

Two things worth knowing before you click:

- **Sharing the Sheet shares the script.** The bound Apps Script project goes
  with it, and an Editor can open the editor and read the code. The code is
  fine — it is meant to be public. **Your credentials are not in it:** the
  private key and client id live in Script Properties, which is a separate
  permission (an Editor on the *sheet* cannot read Script Properties unless
  they are also an editor on the *script project*, which sharing the sheet does
  grant). Treat sharing the sheet as sharing the bank connection.
- **It does not give them the app.** The app has its own door — below.

---

## 2. The app

This is the part with a real decision in it, because Door 2 is currently
locked twice: Google's own access setting, and the owner gate in
`webAppAccessDecision_`. Sharing means loosening the first and widening the
second.

### Step 1 — add their address to `owner_email`

On `_config`, find `owner_email` and make it a comma-separated list:

```
you@gmail.com, her@gmail.com
```

Spacing and capitalisation do not matter. A trailing comma is harmless — an
empty entry is dropped rather than matched, deliberately, because an empty
entry would otherwise compare equal to the empty string Google returns when it
declines to say who is calling.

### Step 2 — change the Door 2 deployment

**Deploy → Manage deployments → the app deployment → pencil.**

| | Before | After |
|---|---|---|
| Execute as | Me | **User accessing the web app** |
| Who has access | Only myself | **Anyone with a Google Account** |

Then **Version: New version → Deploy**. Update it *in place*; a new deployment
mints a different URL and the home-screen icon points at the old one.

**Both settings have to change together, and neither is optional:**

- **"Anyone with a Google Account", never "Anyone".** Anonymous access serves
  bank balances to anyone with the URL. The owner gate is what stops that being
  fatal, and a lock behind a door you left open is not a thing to rely on.
- **"Execute as: User accessing"** is what makes the gate able to see them at
  all. Under "Execute as: Me", `Session.getActiveUser().getEmail()` returns an
  empty string for anyone outside your Google Workspace domain — and two
  consumer Gmail accounts are not a domain. The gate then refuses her with
  *"no active user"*, which is correct behaviour and not what you wanted.

### What "Execute as: User accessing" changes

The app now runs under *her* authorisation when she opens it, which has
consequences worth knowing rather than discovering:

- **She grants the OAuth scopes herself**, once, on first open. She will see a
  consent screen listing the same scopes in `appsscript.json`.
- **She needs access to the Sheet** — step 1 — or the app opens to an error,
  because it is her session reading the spreadsheet.
- **The nightly sync is unaffected.** It is a time-driven trigger owned by you
  and it keeps running as you, whatever the deployment says. No bank call ever
  happens from the app.
- **Script Properties stay shared**, so the ledger cache and its version
  counter keep working across both of you. It also means code running as her
  *could* read the bank credentials — she is trusted, but that is the actual
  boundary, and it is the same one sharing the sheet already crossed.

### Step 3 — send her the URL

Menu → **Spendsheet → Open the app**, or copy `viewer_url` out of `_config`.
Tell her to open it and use **Add to Home Screen** — the app is built for a
phone and this is how it stops looking like a browser tab.

---

## If she gets "This page is not available"

That message is deliberately vague on screen and precise in the logs. **The
reason distinguishes exactly the two mistakes above**, so read it before
changing anything:

Apps Script editor → **Executions** → the failed `doGet` → the log line reads
`api refused: <reason>`.

| Reason | What it means | Fix |
|---|---|---|
| `no active user` | Google would not say who is calling | Execute as is still **Me** — step 2 |
| `not the owner` | Google said who it was, and the list does not have them | `owner_email` — step 1. Check for a typo |
| `no owner address configured` | `owner_email` is empty or holds nothing address-shaped | step 1 |

`not the owner` is the good failure: it means the deployment is right and only
the list is wrong.

---

## Taking access away

Reverse both, and **do both**:

1. Remove the address from `owner_email`. This is the one that matters and it
   takes effect immediately — no redeploy, because the gate reads the cell.
2. Remove them from the Sheet's share list.

If they should lose the app but keep the sheet, step 1 alone is enough. If you
are removing them entirely and they were an Editor, also consider that they
have seen the script project — rotating the Enable Banking credentials is the
thorough version, and `docs/SETUP.md` has that procedure.
