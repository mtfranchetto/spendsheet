# Privacy Policy

**Last updated:** 28 July 2026

## Summary

spendsheet is self-hosted software with no operator. Each person who uses it runs their own private copy inside their own Google account, connected to their own bank accounts. **The authors of spendsheet receive no data of any kind** — no transactions, no balances, no credentials, no analytics, no telemetry, no error reports. There is no server, no database and no company behind this to send data to.

If you are running spendsheet, you are both the only data controller and the only data subject.

## What data is processed

When you connect a bank, spendsheet retrieves via the Enable Banking API:

- Your account identifiers, IBAN, currency and account name
- Account balances
- Transactions: date, amount, currency, description, counterparty name and account, merchant category code, bank transaction code, and the bank's own reference identifiers

## Where it goes

Into **one Google Sheet in your own Google Drive**, and nowhere else.

The code that fetches it runs as a Google Apps Script bound to that spreadsheet, executing inside your own Google account. Data travels from your bank, through Enable Banking (the regulated account information service provider that holds the PSD2 licence), directly into your spreadsheet.

There is no intermediate storage, no copy retained anywhere by this project, and no third-party analytics or logging service in the path.

## Credentials

**spendsheet never sees your bank username or password.** Authentication happens on your bank's own website or app, under Strong Customer Authentication (SCA). Your bank returns an authorization code, which is exchanged for a session token.

Your Enable Banking application ID and private key are stored in Google Apps Script **Script Properties**, which are private to your script and your Google account. They are never written into the spreadsheet and never committed to source control — `.gitignore` excludes `*.pem` specifically to prevent this.

## Third parties

| Who | Role | Their policy |
|---|---|---|
| **Your bank** | Holds your account and performs SCA | Their own |
| **Enable Banking Oy** | Licensed PSD2 account information service provider; retrieves data from your bank on your authorization | [enablebanking.com/privacy-policy](https://enablebanking.com/privacy-policy/) |
| **Google** | Hosts your spreadsheet and runs the script | [policies.google.com/privacy](https://policies.google.com/privacy) |

The authors of spendsheet are **not** in this table, because they are not in the data path.

## Retention

Your data stays in your spreadsheet until you delete it. Nobody else can expire, retain or archive it, because nobody else has it.

Bank consent under PSD2 lasts up to 180 days, after which you must re-authorize. Revoking consent stops future syncing; it does not remove data already in your spreadsheet — deleting that is up to you, and it's as simple as deleting the file.

## Your rights

Because the only copy of your data is a file in your own Google Drive, exercising data rights requires no request to anybody:

- **Access and portability** — File → Download → CSV or Excel
- **Rectification** — edit the cell
- **Erasure** — delete the rows, or delete the spreadsheet

To stop data being retrieved, revoke access at your bank and delete the Apps Script triggers.

## Contact

Questions about the software: [github.com/mtfranchetto/spendsheet/issues](https://github.com/mtfranchetto/spendsheet/issues).

Note that the authors cannot help with a request to access or delete your data, because they do not have it. It is in your Google Drive.
