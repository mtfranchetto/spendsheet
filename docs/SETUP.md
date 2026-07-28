# Setup

Split in two on purpose: you get the whole thing working against a simulated bank before registering anything real or handing over any credentials.

> **Where this is up to:** phases 1–2 are built, so everything through *Part 1* below works. Connecting a real bank is phase 3 and isn't wired up yet.

---

## Part 1 — sandbox

No paperwork. Sandbox registration asks only for a name and a redirect URL.

### 1. Create the spreadsheet

A blank Google Sheet in a **personal** Google account.

Not a work account — and not for quota reasons, since the free consumer limits are roughly a thousand times what this needs. It's that years of personal financial data would otherwise live in a tenant your employer's admins can read, subject to their retention and DLP policies, and you'd lose all of it the day you leave.

**File → Settings → Locale**, and set it to match your bank's number format. For Italian banks that's Italy, which makes Sheets natively parse `1.234,56` and `dd/mm/yyyy` on CSV import — replacing parsing code that would otherwise have to be written and tested.

### 2. Add the code

**Extensions → Apps Script.** Create one file per `.gs` file in [`src/`](../src/) and paste the contents. Keep the names and their number prefixes: Apps Script has no module system and loads files in name order, so the numbers *are* the load order.

Also paste `src/appsscript.json`, which sets the timezone, the V8 runtime and the web-app config phase 3 needs. It's hidden until you tick **Project Settings → Show "appsscript.json" manifest file**.

There's no bulk import in the editor, and drag-and-drop does nothing. If you'd rather not paste by hand, [`clasp`](CONTRIBUTING.md#optional-clasp) pushes the whole folder in one command — it needs Node, which is why it isn't the default path.

### 3. Build the tabs

Reload the spreadsheet — `onOpen()` is a simple trigger, so the menu only appears on a fresh load, not when you save the script.

**Spendsheet → Setup sheet.** You'll be asked to authorize the scopes in the manifest the first time. It builds 19 tabs, seeded and formatted.

It's safe to re-run at any point — see [what a re-run does](SHEET-SCHEMA.md#customising-it-and-what-setup-does-on-a-re-run).

### 4. Deploy the web app

**Deploy → New deployment → Web app**, executing as *you*, with access set to **Anyone**.

Copy the `/exec` URL. This is what makes the whole thing serverless: your bank needs somewhere to send the browser after you log in, and this is that address. No localhost, no tunnel, no VPS.

"Anyone" is required — the bank's redirect arrives unauthenticated. The endpoint is protected instead by a `state` nonce that `startAuth()` generates and the callback verifies, so a stray request to the URL can't do anything.

### 5. Register a sandbox application

At [enablebanking.com](https://enablebanking.com), register an application with environment **Sandbox**. It asks for a name and redirect URLs — paste the `/exec` URL from step 4.

Let the browser generate the key pair. The private key is never transmitted and downloads as a `.pem`. (Generating one yourself with OpenSSL and uploading only the public half works too; it's just one more step.)

### 6. Install the credentials

Run `installCredentials()` from the Apps Script editor — pick it in the function dropdown and press **Run**. A dialog asks for the environment, the application ID and the private key.

Paste the **entire** `.pem`, including the `-----BEGIN` and `-----END` lines. It's stored in Script Properties, which is private to the script: never written to the spreadsheet, never in git.

A dialog rather than a simple prompt because a PEM is multi-line and a prompt box would silently mangle it.

### 7. Check it works

**Spendsheet → Run smoke tests**, then unhide the `_tests` tab. Four checks: credentials present, JWT signs and decodes, `GET /application` accepted, `GET /aspsps` returns banks.

If all four pass, your key and application ID are right and the API accepts your token. That's the whole of phase 2.

---

## Part 2 — production

> Phase 3. Not built yet.

The shape of it: register a **second** application with environment *Production*, connect a real bank, and let that connection move the app from *Inactive* to **Restricted**.

Two things worth knowing in advance:

**Restricted is the destination, not a waypoint.** The lifecycle is Inactive → Restricted → Active, but *Active* requires a signed commercial contract and company KYB. Restricted — reached by linking your own accounts — is the terminal state for personal use, and it's the free tier. Authorization works normally; data retrieval is limited to the accounts you linked. That's a feature here, not a limitation.

**Production registration asks for more than sandbox did:** a description, a data-protection contact email, and URLs for a privacy policy and terms of service. This repo ships [`PRIVACY.md`](../PRIVACY.md) and [`TERMS.md`](../TERMS.md) for exactly that — but their GitHub URLs only resolve once the repository is public.

**Why two applications at all?** The environment is fixed at registration and there's no environment parameter at call time — sandbox and production share `api.enablebanking.com`. The `kid` in the JWT is the application ID, so *which key signs the request* is what decides which world you reach. Hence two registrations, two key pairs, and an `EB_ENV` switch. Both can be installed at once; flipping between them is re-running `installCredentials()` and choosing the other environment.
