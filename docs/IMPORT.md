# Importing history

> **Not written yet.** Lands in phase 6, and needs a real BudgetBakers export to finalise — their column headers vary by app version and locale and couldn't be verified from a primary source.

## The shape of it

There is **no import code**, deliberately. Importing your history is something you do once, ever, and the governing rule of this repo is that code exists only for what runs unattended and repeatedly.

1. **File → Import** the CSV into `_import_raw`. Native Sheets — no code, no 6-minute execution limit, no chunking, no resume cursor.
2. `_import_staged` is a formula tab that reads `_import_raw` and produces properly-shaped rows: `INDEX/MATCH` against `_import_map` for columns, `_category_map` for categories, and a flag marking anything at or after the account's cutoff date.
3. You eyeball it — **including seeing exactly which rows are excluded as overlapping**, rather than trusting a log — select the good rows, and paste-values into `transactions`.

Because the mapping lives in a tab rather than in code, a wrong guess about your export's headers is fixed by editing a cell. That's the safety net for the headers being unverifiable.

The same procedure covers Satispay, DeGiro, or any bank Enable Banking can't reach.

## What matters when it lands

The real test of an import is that **monthly spend-by-category for a past month ties out against what the source app reports for that same month.** If the numbers don't match, the column mapping or the sign convention is wrong, and every downstream number inherits the error.

Imported categories are the prize here — they're what trains the learned categorisation memory, which is the tier that does most of the work.
