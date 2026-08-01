# spendsheet

Sync your bank transactions into a Google Sheet, automatically, for free.

No server. No subscription. No Docker. No account with anyone except your bank and Google. The Sheet **is** the database — so if this project dies tomorrow, your data doesn't go with it.

Built on [Enable Banking](https://enablebanking.com)'s free tier (PSD2 open banking, EU/EEA/UK) and Google Apps Script, which runs on Google's servers at no cost.

> **Status: in development.** Phase 1 of 10. `setup()` builds the spreadsheet; bank sync is not wired up yet. See [`docs/PLAN.md`](docs/PLAN.md) for the full build plan.

---

## Why this exists

Most personal-finance tools are one of: a subscription, a server you have to keep patched, or a company that will eventually shut down and take your history with it. [Nordigen](https://nordigen.com) offered a free open-banking API, got bought by GoCardless, and closed to new signups. That's the failure mode this design assumes.

So the rules here are:

- **Your data lives in a Google Sheet you own.** Not in this project's database — this project has no database.
- **The bank connector is disposable.** If Enable Banking goes the way of Nordigen, you swap one file and keep every transaction, rule and report.
- **Nothing runs on a machine you maintain.** Apps Script is Google-hosted. There is nothing to patch, restart or pay for.
- **Code only for what runs unattended and repeatedly.** One-time jobs are documented procedures, not buttons. That's why there's no CSV importer and no "add account" wizard — you use File → Import and you type a row.

## What you get

- **Automatic daily sync** from your banks — transactions, balances, pending
- **Automatic categorisation** that learns from your own corrections, no ML and no API key
- **Transfer detection** so moving €500 between your own accounts doesn't count as both income and expense
- **Net worth** including things PSD2 can't see — cash, brokerage, property
- **Recurring payment detection** and a 90-day cashflow forecast
- **Monitoring that actually tells you when it breaks**, including the silent failure where a sync runs fine and returns nothing

## Requirements

**A free personal Gmail account is enough.** No Workspace subscription, no Google Cloud project, no billing, no card.

| | Free Gmail | What this uses |
|---|---|---|
| Runtime per execution | 6 min | a few seconds |
| Trigger runtime / day | 90 min | < 1 min |
| UrlFetch calls / day | 20,000 | ~20 |

Use a **personal** account, not a work one. Years of personal financial data shouldn't sit in a tenant your employer's admins can read, subject to their retention policies — and that you lose the day you leave.

## Setup

Deliberately split in two, so you can watch the whole thing work end-to-end against a simulated bank before registering anything real or handing over any credentials.

### Part 1 — sandbox (~5 minutes, no paperwork)

1. Create a blank Google Sheet. **File → Settings → set the locale to Italy** (or your own — this is what makes dates and decimal commas parse correctly).
2. **Extensions → Apps Script**. Create one file per `.gs` file in [`src/`](src/) and paste the contents. Keep the names and the number prefixes — Apps Script has no modules and loads files in name order. Also paste [`src/appsscript.json`](src/appsscript.json), which you'll first need to reveal via **Project Settings → Show "appsscript.json" manifest file**.

   *(There's no bulk import in the Apps Script editor. If you'd rather not paste by hand, [`clasp`](docs/CONTRIBUTING.md#optional-clasp) pushes the whole folder in one command — but it needs Node, which is why it isn't the default path.)*
3. **Deploy → New deployment → Web app**, execute as *me*, access *Anyone*. Copy the `/exec` URL. This is what your bank redirects back to after login, and it's how this works without a server.
4. Register a **sandbox** app at [enablebanking.com](https://enablebanking.com) — it asks only for a name and that redirect URL. Download the `.pem` private key.
5. Run `installCredentials()` from the Apps Script editor and paste what it asks for.
6. In the Sheet: **Spendsheet → Setup sheet**. The first run asks for authorization and Google warns you twice — *"Google hasn't verified this app"* (open **Advanced → Go to Spendsheet (unsafe)**), then the permission list. Both are expected: *unverified* only means nobody paid for Google's OAuth review of a script you pasted into your own Drive. [Why it can't be removed, and what the scopes actually grant.](docs/SETUP.md#3-build-the-tabs)
7. **Spendsheet → Connect a bank** → pick **Mock ASPSP** → complete the fake login → transactions land. ✅

### Part 2 — production (once you're convinced)

8. Register a **production** app. Same redirect URL, plus a description, a data-protection email, and privacy/terms URLs — use this repo's [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md).
9. Download its `.pem`, re-run `installCredentials()`, set the environment to production.
10. **Spendsheet → Connect a bank** → your real bank → approve on your phone. This moves your app from *Inactive* to **Restricted**, which is the free tier and the last state you need. (*Active* requires a signed commercial contract — you will never need it.)
11. Repeat for each bank.
12. **Spendsheet → Install triggers** — daily sync, daily self-check.

Full detail in [`docs/SETUP.md`](docs/SETUP.md).

## Menu

Setup sheet · Connect a bank · Sync now · Re-categorise all · Learn from corrections · Detect recurring · Rebuild cashflow · Health check · Run smoke tests · Install triggers

There is deliberately no "Add manual account" (type a row in `accounts`) and no "Import CSV" (File → Import, then paste-values). Both are documented in [`docs/IMPORT.md`](docs/IMPORT.md).

## ⚠️ Never commit your data

If you fork this, remember that `.gitignore` excludes `*.pem`, `*.csv` and every export for a reason. Committing a private key or a transaction history to a public repo is one command and it's irreversible — assume anything pushed is public forever.

## Docs

| | |
|---|---|
| [`docs/SETUP.md`](docs/SETUP.md) | Long-form setup, both Enable Banking registrations |
| [`docs/IMPORT.md`](docs/IMPORT.md) | Importing history from BudgetBakers or any CSV |
| [`docs/SHEET-SCHEMA.md`](docs/SHEET-SCHEMA.md) | Every tab and column, and whether you or the code owns it |
| [`docs/MONITORING.md`](docs/MONITORING.md) | What breaks, how you find out, how you fix it |
| [`docs/PROVIDERS.md`](docs/PROVIDERS.md) | Per-bank findings — which fields each bank actually populates |
| [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) | Running the tests |
| [`docs/PLAN.md`](docs/PLAN.md) | The full design document and its reasoning |

## Contributing

Users never need Node. Contributors do:

```bash
npm install && npm test
```

Tests run the **exact `.gs` files that ship** — `tests/harness.mjs` loads them into a `node:vm` context with the Google globals stubbed. No build step, no transpilation, no duplicated source.

## Licence

[MIT](LICENSE). This is not financial software, it's a spreadsheet that fills itself in. See [TERMS.md](TERMS.md).
