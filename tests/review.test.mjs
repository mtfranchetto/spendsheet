/**
 * The review queue and its write-back.
 *
 * This is the one part of the project that writes to `transactions` from
 * outside the sync, and it does it from a trigger with no UI — so the tests
 * are about the two ways that can go wrong: writing to the wrong row, and
 * writing when nobody asked.
 *
 * The `uid` indirection is what the first group is really about. A queue built
 * by a QUERY would move its rows under you as they were confirmed, which is
 * why this one is a snapshot with a pointer in it.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

/** A booked transaction, with only the columns the queue reads. */
function txRow(uid, date, over = {}) {
  return Object.assign({
    uid,
    account_id: 'acc-1',
    account_name: 'Revolut',
    booking_date: date,
    value_date: '',
    transaction_date: '',
    amount: -12.5,
    currency: 'EUR',
    description: 'COOP SUPERMERCATO',
    counterparty: '',
    entry_reference: '',
    bank_transaction_code: '',
    mcc: '',
    source: 'enablebanking',
    imported_at: new Date()
  }, over);
}

function bookWith(rows, options = {}) {
  const c = load(options);
  c.setup();
  const tx = c.__spreadsheet.getSheetByName('transactions');
  c.appendRows_(tx, 1, rows.map((r) => c.toRow_(c.TX_COLUMNS_CODE, r)));
  return c;
}

const at = (c, sheet, row, name) =>
  sheet.getRange(row, c.colIndex_(c.REVIEW_COLUMNS, name)).getValue();

describe('filling the queue', () => {
  it('lists the unconfirmed rows oldest first', () => {
    // A backlog is cleared from the far end: the rows you have not looked at
    // for three weeks are the ones a queue exists to surface.
    const c = bookWith([
      txRow('u-new', new Date(2026, 6, 1)),
      txRow('u-old', new Date(2026, 3, 1)),
      txRow('u-mid', new Date(2026, 4, 1))
    ]);
    c.refreshReviewQueue();

    const review = c.__spreadsheet.getSheetByName('review');
    const uids = c.readRecords_(review, c.REVIEW_COLUMNS, 1).map((r) => r.uid);
    expect(uids).toEqual(['u-old', 'u-mid', 'u-new']);
  });

  it('leaves out a row you have already confirmed', () => {
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1)), txRow('u-2', new Date(2026, 6, 2))]);
    const tx = c.__spreadsheet.getSheetByName('transactions');
    c.writeCell_(tx, 2, c.TX_COLUMNS, 'confirmed', true);
    c.refreshReviewQueue();

    const review = c.__spreadsheet.getSheetByName('review');
    expect(c.readRecords_(review, c.REVIEW_COLUMNS, 1).map((r) => r.uid)).toEqual(['u-2']);
  });

  it('counts a row carrying an override as confirmed, without the tick', () => {
    // Typing the category is a stronger statement than ticking a box next to
    // it — the argument 00_config.gs makes about the `confirmed` column.
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1))]);
    const tx = c.__spreadsheet.getSheetByName('transactions');
    c.writeCell_(tx, 2, c.TX_COLUMNS, 'category_override', 'Food & Drink');

    expect(c.fillReviewQueue_(c.__spreadsheet).shown).toBe(0);
  });

  it('caps the queue and says how many are behind it', () => {
    // The backlog is expected to be under thirty. The cap is for the first run
    // on an imported history, where the honest answer is four thousand rows.
    const rows = [];
    for (let i = 0; i < 12; i++) rows.push(txRow(`u-${i}`, new Date(2026, 6, i + 1)));

    const c = bookWith(rows);
    const config = c.__spreadsheet.getSheetByName('_config');
    c.writeCell_(config, c.findRowByValue_(config, 1, 'review_queue_size'),
      c.CONFIG_COLUMNS, 'value', 5);

    const result = c.refreshReviewQueue();
    expect(result).toMatchObject({ shown: 5, pending: 12, limit: 5 });
    expect(c.__spreadsheet.toasts.at(-1).message).toContain('12 are unconfirmed in total');
  });

  it('falls back rather than emptying the queue when the size is blank', () => {
    // Number('') is 0 and isFinite(0) is true, so the obvious guard passes and
    // a cleared cell would show a queue of nothing while looking healthy.
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1))]);
    const config = c.__spreadsheet.getSheetByName('_config');
    c.writeCell_(config, c.findRowByValue_(config, 1, 'review_queue_size'),
      c.CONFIG_COLUMNS, 'value', '');

    expect(c.fillReviewQueue_(c.__spreadsheet)).toMatchObject({ shown: 1, limit: 50 });
  });

  it('replaces the tab rather than appending to it', () => {
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1)), txRow('u-2', new Date(2026, 6, 2))]);
    c.refreshReviewQueue();
    c.refreshReviewQueue();
    c.refreshReviewQueue();

    const review = c.__spreadsheet.getSheetByName('review');
    expect(c.readRecords_(review, c.REVIEW_COLUMNS, 1)).toHaveLength(2);
  });

  it('says so plainly when there is nothing left to review', () => {
    const c = bookWith([]);
    c.refreshReviewQueue();
    expect(c.__spreadsheet.toasts.at(-1).message).toContain('every transaction is confirmed');
  });

  it('carries a uid on every row, since that is what the write-back needs', () => {
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1))]);
    c.refreshReviewQueue();

    const review = c.__spreadsheet.getSheetByName('review');
    expect(at(c, review, 2, 'uid')).toBe('u-1');
    expect(at(c, review, 2, 'description')).toBe('COOP SUPERMERCATO');
  });
});

describe('the write-back', () => {
  function queued(rows) {
    const c = bookWith(rows);
    c.refreshReviewQueue();
    return { c, review: c.__spreadsheet.getSheetByName('review'),
      tx: c.__spreadsheet.getSheetByName('transactions') };
  }

  /** Type into a review cell and fire the trigger, the way an edit really lands. */
  function edit(c, review, row, name, value) {
    const range = review.getRange(row, c.colIndex_(c.REVIEW_COLUMNS, name));
    range.setValue(value);
    c.onEdit({ range });
    return range;
  }

  it('finds the transaction by uid rather than by position', () => {
    const { c, review, tx } = queued([
      txRow('u-old', new Date(2026, 3, 1)),
      txRow('u-new', new Date(2026, 6, 1))
    ]);

    // Review row 2 is the *oldest*, which is transactions row 2 only by
    // accident — the queue is sorted and `transactions` never is.
    edit(c, review, 3, 'confirmed', true);

    const records = c.readRecords_(tx, c.TX_COLUMNS, 1);
    expect(records.find((r) => r.uid === 'u-new').confirmed).toBe(true);
    expect(records.find((r) => r.uid === 'u-old').confirmed).toBe('');
  });

  it('writes an override back, and treats it as confirmation on its own', () => {
    const { c, review, tx } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    edit(c, review, 2, 'category_override', 'Food & Drink');

    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].category_override).toBe('Food & Drink');
    expect(c.fillReviewQueue_(c.__spreadsheet).shown).toBe(0);
  });

  it('does not un-confirm a row when you later type a category into it', () => {
    // Writing `confirmed` on every edit would send FALSE back the moment you
    // touched the override column of a row you had already ticked.
    const { c, review, tx } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    edit(c, review, 2, 'confirmed', true);
    edit(c, review, 2, 'category_override', 'Food & Drink');

    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].confirmed).toBe(true);
  });

  it('un-ticks when you un-tick, since that is the whole point of a checkbox', () => {
    const { c, review, tx } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    edit(c, review, 2, 'confirmed', true);
    edit(c, review, 2, 'confirmed', false);

    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].confirmed).toBe(false);
  });

  it('writes what happened into the row, because a phone has nowhere else to look', () => {
    // A simple trigger fails silently — no toast survives, no alert fires.
    const { c, review } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    edit(c, review, 2, 'confirmed', true);

    expect(String(at(c, review, 2, 'status'))).toContain('saved');
  });

  it('says so rather than guessing when the uid is not in transactions', () => {
    const { c, review, tx } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    review.getRange(2, c.colIndex_(c.REVIEW_COLUMNS, 'uid')).setValue('gone');
    edit(c, review, 2, 'confirmed', true);

    expect(String(at(c, review, 2, 'status'))).toContain('refresh the queue');
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].confirmed).toBe('');
  });

  it('returns immediately for an edit on any other tab', () => {
    // It runs on *every* edit to the spreadsheet, so the guard is the first
    // thing and the cheapest thing.
    const { c, tx } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    const range = tx.getRange(2, c.colIndex_(c.TX_COLUMNS, 'notes'));
    range.setValue('a note');

    expect(() => c.onEdit({ range })).not.toThrow();
    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].confirmed).toBe('');
  });

  it('ignores an edit to a column that is not yours', () => {
    const { c, review, tx } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    edit(c, review, 2, 'description', 'typed over it');

    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].confirmed).toBe('');
    expect(at(c, review, 2, 'status')).toBe('');
  });

  it('ignores an edit to the header row', () => {
    const { c, review, tx } = queued([txRow('u-1', new Date(2026, 6, 1))]);
    const range = review.getRange(1, c.colIndex_(c.REVIEW_COLUMNS, 'confirmed'));
    c.onEdit({ range });

    expect(c.readRecords_(tx, c.TX_COLUMNS, 1)[0].confirmed).toBe('');
  });

  it('handles a tick pasted down several rows at once', () => {
    const { c, review, tx } = queued([
      txRow('u-1', new Date(2026, 6, 1)),
      txRow('u-2', new Date(2026, 6, 2)),
      txRow('u-3', new Date(2026, 6, 3))
    ]);

    const column = c.colIndex_(c.REVIEW_COLUMNS, 'confirmed');
    review.getRange(2, column, 3, 1).setValues([[true], [true], [true]]);
    c.onEdit({ range: review.getRange(2, column, 3, 1) });

    expect(c.readRecords_(tx, c.TX_COLUMNS, 1).map((r) => r.confirmed))
      .toEqual([true, true, true]);
  });

  it('refuses to confirm more rows than an accident could plausibly be', () => {
    // The only way to edit hundreds of review rows at once is a paste that
    // went somewhere unintended, and confirming four thousand transactions is
    // the one thing this flag is supposed to make impossible.
    expect(ctxValue('MAX_REVIEW_WRITE')).toBe(100);
  });

  it('never throws out of the trigger, whatever it is handed', () => {
    // An exception here has nowhere to go: no UI, and on a phone no log
    // anybody would ever look at.
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1))]);
    [undefined, {}, { range: null }].forEach((event) => {
      expect(() => c.onEdit(event)).not.toThrow();
    });
  });

  it('invalidates the app cache when someone types into transactions', () => {
    // The one write the version counter cannot see for itself: a category
    // typed straight into the tab goes through neither `appendRows_` nor
    // `writeCell_`. Closing this is what lets the ledger cache live six hours
    // instead of five minutes — see `LEDGER_CACHE_SECONDS`.
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1))]);
    const before = c.dataVersion_();

    c.onEdit({ range: c.__spreadsheet.getSheetByName('transactions').getRange(2, 20) });

    expect(c.dataVersion_()).not.toBe(before);
  });

  it('leaves the version alone for an edit on any other tab', () => {
    // This runs on every keystroke-sized change anyone makes to any tab, so
    // bumping indiscriminately would throw away the ledger cache whenever you
    // touched `_config` or typed a label.
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1))]);
    const before = c.dataVersion_();

    c.onEdit({ range: c.__spreadsheet.getSheetByName('_config').getRange(2, 2) });

    expect(c.dataVersion_()).toBe(before);
  });

  it('records a failure where a silent one is still findable', () => {
    const c = bookWith([txRow('u-1', new Date(2026, 6, 1))]);
    const broken = { range: { getSheet: () => { throw new Error('boom'); } } };

    expect(() => c.onEdit(broken)).not.toThrow();
    const anomalies = c.readRecords_(c.__spreadsheet.getSheetByName('_anomalies'),
      c.ANOMALY_COLUMNS, 1);
    expect(anomalies.at(-1).detail).toContain('onEdit write-back failed');
  });
});

describe('the review tab', () => {
  const c = load();
  c.setup();
  const review = c.__spreadsheet.getSheetByName('review');

  it('gives you a checkbox and two dropdowns, which is all a phone has', () => {
    const validations = review.calls.filter((call) => call.kind === 'validation');
    expect(validations.map((v) => v.rule.type).sort()).toEqual(['checkbox', 'range', 'range']);
  });

  it('puts the subcategory picker on the tab, so a correction is one choice', () => {
    // A subcategory names its parent, so picking `Groceries` sets the category
    // too. Setting both was asking you to type what the sheet already knows.
    const at = (name) => c.colOf(c.REVIEW_COLUMNS, name);
    const note = review.getRange(at('subcategory_override') + '1').getNote();

    expect(note).toContain('the category follows');
    expect(c.REVIEW_COLUMNS.indexOf('subcategory_override'))
      .toBe(c.REVIEW_COLUMNS.indexOf('category_override') + 1);
  });

  it('hides the uid, since it is a pointer and not something to read', () => {
    expect(review.isColumnHiddenByUser(c.colIndex_(c.REVIEW_COLUMNS, 'uid'))).toBe(true);
  });

  it('explains the flow where a phone will show it', () => {
    // Tapping a header cell in mobile Sheets reveals its note.
    const note = review.getRange(c.colOf(c.REVIEW_COLUMNS, 'confirmed') + '1').getNote();
    expect(note).toContain('Tick to confirm');
    expect(note).toContain('refilled by a run');
  });

  it('is rebuilt identically on a second setup()', () => {
    const before = review.snapshot();
    c.setup();
    expect(c.__spreadsheet.getSheetByName('review').snapshot()).toEqual(before);
  });
});

/** Read a top-level constant out of a fresh sandbox. */
function ctxValue(name) {
  return load()[name];
}
