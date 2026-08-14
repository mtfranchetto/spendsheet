# Setup

Split in two on purpose: you get the whole thing working against a simulated bank before registering anything real or handing over any credentials.

> **Part 1 is a full dry run.** It connects a simulated bank, so you can watch the whole thing work end to end before registering anything real or handing over a private key. Part 2 is the same steps against your actual banks.

---

## Part 1 — sandbox

No paperwork. Sandbox registration asks only for a name and a redirect URL.

### 1. Create the spreadsheet

A blank Google Sheet in a **personal** Google account.

Not a work account — and not for quota reasons, since the free consumer limits are roughly a thousand times what this needs. It's that years of personal financial data would otherwise live in a tenant your employer's admins can read, subject to their retention and DLP policies, and you'd lose all of it the day you leave.

**File → Settings → Locale**, and set it to match your bank's number format. For Italian banks that's Italy, which makes Sheets natively parse `1.234,56` and `dd/mm/yyyy` on CSV import — replacing parsing code that would otherwise have to be written and tested.

### 2. Add the code

**Extensions → Apps Script.** Create one file per `.gs` file in [`src/`](../src/) and paste the contents. Keep the names and their number prefixes: Apps Script has no module system and loads files in name order, so the numbers *are* the load order.

Also paste `src/appsscript.json`, which sets the timezone, the V8 runtime and the web-app config Part 2 needs. It's hidden until you tick **Project Settings → Show "appsscript.json" manifest file**.

There's no bulk import in the editor, and drag-and-drop does nothing. If you'd rather not paste by hand, [`clasp`](CONTRIBUTING.md#optional-clasp) pushes the whole folder in one command — it needs Node, which is why it isn't the default path.

### 3. Build the tabs

Reload the spreadsheet — `onOpen()` is a simple trigger, so the menu only appears on a fresh load, not when you save the script.

**Spendsheet → Set up and maintain → Setup sheet.** It builds 20 tabs, seeded and formatted.

The first run asks you to authorize it, and **Google shows you two warning screens on the way**. Both are expected. They are documented here rather than left as a surprise, because the second one is designed to look like the interstitial you get on a site with a broken certificate, and hitting it in the first five minutes of a finance tool reads as "something is wrong".

**Screen 1 — "Google hasn't verified this app".** The *Advanced* link is collapsed by default; open it and choose **Go to Spendsheet (unsafe)**.

Nothing is wrong. *Unverified* means nobody submitted this script to Google's OAuth review — not that Google found a problem. The script is a file in your own Drive, running as you, and you pasted every line of it yourself.

It cannot be switched off for a personal account. Verification requires a Google Cloud project, **a domain you own and have verified**, the privacy policy hosted on that domain (a GitHub URL is not accepted), a demo video, per-scope justification, and a review that runs for weeks. For a spreadsheet only you will ever open, that is the wrong trade. The one real exception: on a Google Workspace domain you control, publishing the app as *Internal* removes the warning with no review — irrelevant on a consumer account.

**Screen 2 — the permission list.** Read it; it should match [`src/appsscript.json`](../src/appsscript.json) exactly, and two of those scopes are narrower than they look:

| Asked for | Not asked for |
|---|---|
| `drive.file` — only files this script itself creates | `drive` — everything in your Drive |
| `spreadsheets.currentonly` — this sheet | `spreadsheets` — every sheet you own |

That distinction is why you get an *Advanced* link at all. Both are *sensitive* scopes; neither is **restricted** — the tier holding full Drive and Gmail — and unverified apps asking for restricted scopes are hard-blocked on some account types with no way through, quite apart from the CASA security assessment that verifying one costs.

You see this once. It won't return unless the scope list changes, and `tests/manifest.test.mjs` fails CI on a scope that nothing in `src/` calls, so it can't grow quietly.

> **If you ever attach a standard Google Cloud project** — not needed for any of this, but people do it for Cloud Logging — go to its OAuth consent screen and set **Publishing status → In production**, unverified though it is.
>
> Left on **Testing**, Google issues refresh tokens that **expire after 7 days**. Your daily sync would stop about a week later. `selfCheck()` would email you that it hadn't run, which is the monitoring working correctly on an outage that didn't need to happen. *In production* keeps the same one-time warning and issues tokens that don't expire.

It's safe to re-run `setup()` at any point — see [what a re-run does](SHEET-SCHEMA.md#customising-it-and-what-setup-does-on-a-re-run).

### 4. Deploy the web app

**Deploy → New deployment → Web app**, executing as *you*, with access set to **Anyone**.

Copy the `/exec` URL. This is what makes the whole thing serverless: your bank needs somewhere to send the browser after you log in, and this is that address. No localhost, no tunnel, no VPS.

"Anyone" is required — the bank's redirect arrives unauthenticated. The endpoint is protected instead by a `state` nonce that `startAuth()` generates and the callback verifies, so a stray request to the URL can't do anything.

> **Two things about deployments, and they pull in opposite directions.**
>
> **A deployment serves a frozen version, not your current code.** Editing files or running `clasp push` updates the project, but the `/exec` URL keeps serving the version the deployment was cut from. If `doGet` didn't exist when you deployed, the callback lands on Google Drive's *"Sorry, unable to open the file at present"* — the URL resolves, but the code behind it has no `doGet` to answer with.
>
> **But each *New deployment* mints a different URL**, which stops matching the one Enable Banking has registered, and authorisation then fails with `Redirect URI not allowed`.
>
> So the move that satisfies both is **Manage deployments → edit (pencil) → Version: New version → Deploy**. Same URL, current code. Reach for *New deployment* only the first time.
>
> If you took the `clasp` path, `npm run deploy` is that move for both deployments at once, and checks afterwards that neither changed hands: [`docs/DEPLOY.md`](DEPLOY.md).
>
> If you're ever unsure which URL is live, open **Spendsheet → Set up and maintain → Install credentials**. It shows a **Redirect URL** field, pre-filled with what the runtime reports — and that is a starting guess rather than an answer. `ScriptApp.getService().getUrl()` answers for the context it is *called from*, so run from a menu it returns the HEAD deployment, which is neither of the two real doors. Check it against **Deploy → Manage deployments** before you paste it into Enable Banking; what you save in that field is what `startAuth()` sends, so it is also the fix if the two ever disagree.

### 5. Register a sandbox application

At [enablebanking.com](https://enablebanking.com), register an application with environment **Sandbox**. It asks for a name and redirect URLs — paste the `/exec` URL from step 4, **exactly** as it appears, with no trailing slash added or removed.

This is the most common setup failure, and it fails late: everything works until you pick a bank, then `/auth` returns `400 — Redirect URI not allowed`. You can register more than one URL, so adding a second is harmless if you're unsure which is live.

Let the browser generate the key pair. The private key is never transmitted and downloads as a `.pem`. (Generating one yourself with OpenSSL and uploading only the public half works too; it's just one more step.)

### 6. Install the credentials

**Spendsheet → Set up and maintain → Install credentials**, or run `installCredentials()` from the Apps Script editor — pick it in the function dropdown and press **Run**. Either opens the same dialog, which asks for four things: the environment, the redirect URL, the application ID and the private key.

Paste the **entire** `.pem`, including the `-----BEGIN` and `-----END` lines. It's stored in Script Properties, which is private to the script: never written to the spreadsheet, never in git.

A dialog rather than a simple prompt because a PEM is multi-line and a prompt box would silently mangle it.

### 7. Check it works

**Spendsheet → Diagnostics → Run smoke tests**, then unhide the `_tests` tab. Nine checks, in two groups.

**The four that matter at this point** are the connection: credentials installed, the JWT signs and decodes, `GET /application` accepted, `GET /aspsps` returns banks. If those pass, your key and application ID are right and the API accepts your token.

**The other five are about the book** and check things no unit test can, because the harness has no spreadsheet behind it and hands a formula to nothing: that every `ARRAYFORMULA` anchor evaluates rather than sitting there as `#ERROR!`, that `in_reports` is a real boolean column and not text, that no subcategory name appears under two parents, that `owner_email` names the account running it, and that every chart is pointed at a range with data in it. **Re-run this after pulling new code and running Setup**, not only during first setup — a formula that a decimal-comma locale rejects passes every test in `tests/` and fails here.

---

## Part 2 — production

Register a **second** application with environment *Production*, activate it, and connect your banks.

**Activate it from Enable Banking's console, not from here.** A newly registered production application is *Inactive*, and an Inactive application cannot call the API at all — including `GET /aspsps`, which is the first thing **Connect a bank** does to populate its list. So the Sheet cannot bootstrap this itself; you get:

```
EnableBankingError: The application is still Inactive. (HTTP 403 on /aspsps)
  — Application is not active
```

In the console, choose **Activate by linking accounts** — *not* "Request activation", which starts the path to *Active* and wants a signed contract. Link the accounts you intend to sync; that moves the application to **Restricted** permanently.

**Then still connect each bank from the Sheet.** The console's linking whitelists accounts; it does not create a session this spreadsheet owns. Only `doGet` → `ebCreateSession` writes a session id into `_status`, and that id is the handle every later sync reads. The two steps do different jobs and you need both.

Three more things worth knowing in advance:

**Restricted is the destination, not a waypoint.** The lifecycle is Inactive → Restricted → Active, but *Active* requires a signed commercial contract and company KYB. Restricted — reached by linking your own accounts — is the terminal state for personal use, and it's the free tier. Authorization works normally; data retrieval is limited to the accounts you linked. That's a feature here, not a limitation.

**Production registration asks for a little more than sandbox did:** a description and a data-protection contact email. It does *not* ask for a privacy policy or terms of service. This repo carried a `PRIVACY.md` and a `TERMS.md` written on the assumption that it would; the real registration form never asked, so both were removed rather than left as documents nobody had a use for.

**Why two applications at all?** The environment is fixed at registration and there's no environment parameter at call time — sandbox and production share `api.enablebanking.com`. The `kid` in the JWT is the application ID, so *which key signs the request* is what decides which world you reach. Hence two registrations, two key pairs, and an `EB_ENV` switch. Both can be installed at once; flipping between them is re-running `installCredentials()` and choosing the other environment.

---

## Part 3 — the rest of it

Everything above gets transactions arriving. These are the three things worth doing next, each owned by its own document rather than repeated here.

**Bring your history.** **File → Import** your old export into `_import_raw`, check the mapping in `_import_staged`, then **Spendsheet → Import → Import staged rows**. Do this *before* letting the cascade loose: imported rows arrive confirmed, so **Learn from corrections** turns five years of your own categorisations into the lookup table everything else uses. PSD2 only gives you a rolling ~90 days, so this is the difference between categorisation working on day one and working in six months. ([`docs/IMPORT.md`](IMPORT.md))

**Put it on your phone.** A *second* deployment, with access **Only myself** — a different URL from the one in step 4, and the one place in this whole setup where getting a dropdown wrong exposes your balances to anyone with the link. ([`docs/MOBILE.md`](MOBILE.md), which is also where the owner gate and `owner_email` are explained. To share it with someone, [`docs/SHARING.md`](SHARING.md).)

**Turn on the schedule.** **Spendsheet → Set up and maintain → Install triggers** — a daily sync and a daily self-check, running on Google's infrastructure whether or not the Sheet is open. It is idempotent, so re-running it is always safe. ([`docs/MONITORING.md`](MONITORING.md))

---

## Keeping it up to date

`setup()` is idempotent and is the thing to re-run after pulling new code: it adds tabs and columns that did not exist before, rewrites the formulas, and leaves your data and your customisations alone. It only ever *adds* seed rows, so a category or a config key added upstream after your book was built arrives this way and no other.

The one thing it does not do is change an answer you have already given. If a default moved, **Spendsheet → Set up and maintain → Update mappings to defaults** lists every row where your book and the seed disagree and asks before touching any of them. A row you deliberately filled in — `alert_email`, `owner_email` — is not a disagreement and is never listed.

After both, **Run smoke tests**. The unit tests cover logic and the harness has no spreadsheet behind it; a formula this locale rejects is green in CI and `#ERROR!` in the book.
