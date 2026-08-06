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

**Spendsheet → Setup sheet.** It builds 19 tabs, seeded and formatted.

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
> If you're ever unsure which URL is live, open **Spendsheet → Install credentials** — it shows the current one, ready to copy.

### 5. Register a sandbox application

At [enablebanking.com](https://enablebanking.com), register an application with environment **Sandbox**. It asks for a name and redirect URLs — paste the `/exec` URL from step 4, **exactly** as it appears, with no trailing slash added or removed.

This is the most common setup failure, and it fails late: everything works until you pick a bank, then `/auth` returns `400 — Redirect URI not allowed`. You can register more than one URL, so adding a second is harmless if you're unsure which is live.

Let the browser generate the key pair. The private key is never transmitted and downloads as a `.pem`. (Generating one yourself with OpenSSL and uploading only the public half works too; it's just one more step.)

### 6. Install the credentials

Run `installCredentials()` from the Apps Script editor — pick it in the function dropdown and press **Run**. A dialog asks for the environment, the application ID and the private key.

Paste the **entire** `.pem`, including the `-----BEGIN` and `-----END` lines. It's stored in Script Properties, which is private to the script: never written to the spreadsheet, never in git.

A dialog rather than a simple prompt because a PEM is multi-line and a prompt box would silently mangle it.

### 7. Check it works

**Spendsheet → Run smoke tests**, then unhide the `_tests` tab. Four checks: credentials present, JWT signs and decodes, `GET /application` accepted, `GET /aspsps` returns banks.

If all four pass, your key and application ID are right and the API accepts your token.

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
