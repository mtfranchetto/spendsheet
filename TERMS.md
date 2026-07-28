# Terms of Service

**Last updated:** 28 July 2026

## What this is

spendsheet is free, open-source software licensed under the [MIT Licence](LICENSE). It is **not a service.** There is no company, no server, no account to register and no subscription. You download the code, run it in your own Google account, and connect it to your own bank accounts.

These terms govern your use of the software. There is no relationship between you and the authors beyond the MIT Licence.

## What you're responsible for

By running spendsheet you agree that:

- You will connect it only to **bank accounts you own or are authorized to access**.
- You will register your own application with Enable Banking and comply with [their terms](https://enablebanking.com/terms-of-service/). The authors' registration is not shared with you and cannot be.
- You will keep your private key (`.pem`) and your Google account secure. Anyone with both can read your financial data.
- You will not commit keys or financial data to a public repository. `.gitignore` is configured to prevent this, but it cannot protect you from `git add -f`.

## Not financial advice

spendsheet displays and categorises your own transaction data. It does not provide financial, investment, tax or legal advice, and nothing it calculates should be relied on for any of those purposes.

**Do not use it as your record of truth for anything that matters legally or financially.** Your bank's own statements are authoritative. This is a convenience layer over them, and it can be wrong — through a bug here, an error in an upstream API, a bank that reports a field differently than expected, or an accidental edit to a spreadsheet cell.

Specifically, be aware that:

- Categorisation is automated and will misclassify things.
- Transactions that are still pending are deliberately excluded from the transaction history.
- Balances and forecasts are estimates derived from whatever the bank last returned.
- A failed sync can leave the data incomplete without that being obvious.

Verify anything important against your bank directly.

## No warranty

The software is provided **"as is", without warranty of any kind**, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose and non-infringement. See the [MIT Licence](LICENSE) for the full text.

The authors do not warrant that it will be accurate, complete, uninterrupted or error-free.

## Limitation of liability

To the maximum extent permitted by law, the authors are not liable for any claim, damages or other liability arising from your use of the software — including without limitation financial loss, loss of data, missed payments, incorrect tax filings, or decisions made on the basis of what it displayed.

You accept that you use this software at your own risk.

## Dependencies you're subject to

Running spendsheet means also being bound by:

- [Enable Banking's terms](https://enablebanking.com/terms-of-service/) — for API access
- [Google's terms](https://policies.google.com/terms) and the [Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)
- Your bank's own terms for open banking access

Any of these can change or be withdrawn independently of this project. Enable Banking's free tier in particular is offered at their discretion and could end — the design deliberately keeps your data in a format that survives that.

## Changes

These terms may be updated. Changes are visible in this file's [git history](https://github.com/mtfranchetto/spendsheet/commits/main/TERMS.md). Continued use of the software constitutes acceptance.

## Contact

[github.com/mtfranchetto/spendsheet/issues](https://github.com/mtfranchetto/spendsheet/issues)
