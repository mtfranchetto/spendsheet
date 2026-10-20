/**
 * Turning a provider transaction into a row.
 *
 * The two cases that get the most attention here are the two that invert the
 * meaning of the sheet rather than merely losing a field: the sign, which
 * lives in `credit_debit_indicator` and not in the amount, and the
 * counterparty, which is on a different side of the transaction depending on
 * which way the money went.
 */

import { describe, it, expect } from 'vitest';
import { load } from './harness.mjs';

const ctx = load();
const ACCOUNT = { uid: 'acc-1', name: 'Fineco', currency: 'EUR' };
const NOW = new Date('2026-07-30T09:00:00Z');

/** A booked card payment, shaped as the aggregation API returns one. */
function booked(over) {
  return Object.assign({
    entry_reference: '2026-0001',
    transaction_amount: { currency: 'EUR', amount: '12.34' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-07-28',
    value_date: '2026-07-29',
    transaction_date: '2026-07-28',
    remittance_information: ['PAGAMENTO POS 28/07 CARTA *1234', 'ESSELUNGA SPA TORINO'],
    creditor: { name: 'ESSELUNGA SPA' },
    debtor: { name: 'ACCOUNT HOLDER' },
    merchant_category_code: '5411',
    bank_transaction_code: { code: 'PMNT', sub_code: 'POSD', description: 'Card payment' }
  }, over || {});
}

describe('signedAmount', () => {
  it('makes a debit negative and a credit positive', () => {
    expect(ctx.signedAmount(booked())).toBe(-12.34);
    expect(ctx.signedAmount(booked({ credit_debit_indicator: 'CRDT' }))).toBe(12.34);
  });

  it('does not double-negate an amount that already carries a minus sign', () => {
    // The bug this guards against turns every expense into income and every
    // total in the sheet upside down, while looking entirely plausible.
    const raw = booked({ transaction_amount: { currency: 'EUR', amount: '-12.34' } });
    expect(ctx.signedAmount(raw)).toBe(-12.34);
  });

  it('parses the string the API actually sends', () => {
    expect(ctx.signedAmount(booked({ transaction_amount: { amount: '1234.00' } }))).toBe(-1234);
    expect(ctx.signedAmount(booked({ transaction_amount: { amount: 0.5 } }))).toBe(-0.5);
  });

  it('trusts the sign it was given when there is no indicator at all', () => {
    // Nothing else is knowable at that point, and assuming CRDT would file
    // every expense as income.
    const raw = booked({ credit_debit_indicator: undefined });
    expect(ctx.signedAmount(Object.assign(raw, {
      transaction_amount: { amount: '-9.99' }
    }))).toBe(-9.99);
  });

  it('reports an unreadable amount rather than guessing at zero', () => {
    expect(ctx.signedAmount(booked({ transaction_amount: { amount: '' } }))).toBe(null);
    expect(ctx.signedAmount(booked({ transaction_amount: null }))).toBe(null);
    expect(ctx.signedAmount({})).toBe(null);
  });
});

describe('parseIsoDate', () => {
  it('builds a local date, so the day cannot shift under a timezone', () => {
    const date = ctx.parseIsoDate('2026-07-28');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(6);
    expect(date.getDate()).toBe(28);
  });

  it('leaves an absent or unparseable date blank', () => {
    expect(ctx.parseIsoDate('')).toBe('');
    expect(ctx.parseIsoDate(null)).toBe('');
    expect(ctx.parseIsoDate('28/07/2026')).toBe('');
  });
});

describe('whether a bank sends a time', () => {
  // `parseIsoDate` keeps only the day, so the provider probe is the one place
  // a time could be seen at all — and the question to answer before carrying one.
  it('counts each date field that carries one', () => {
    const summary = ctx.summariseCoverage_([
      booked({ booking_date: '2026-07-28', transaction_date: '2026-07-28T14:32:05Z' }),
      booked({ booking_date: '2026-07-28 09:15', transaction_date: '2026-07-28' })
    ]);

    expect(summary).toContain('With a time: booking_date 50%, value_date 0%, transaction_date 50%');
  });

  it('says there is nothing to measure rather than 0%', () => {
    expect(ctx.summariseCoverage_([])).toContain('booking_date n/a');
  });
});

describe('transactionDescription', () => {
  it('joins the remittance lines into one readable string', () => {
    expect(ctx.transactionDescription(booked()))
      .toBe('PAGAMENTO POS 28/07 CARTA *1234 ESSELUNGA SPA TORINO');
  });

  it('falls back through what a sparser bank supplies', () => {
    expect(ctx.transactionDescription(booked({ remittance_information: [] })))
      .toBe('Card payment');
    expect(ctx.transactionDescription(booked({
      remittance_information: null, bank_transaction_code: null, note: 'Bonifico'
    }))).toBe('Bonifico');
    expect(ctx.transactionDescription(booked({
      remittance_information: null, bank_transaction_code: null
    }))).toBe('ESSELUNGA SPA');
  });

  it('accepts a plain string where the spec says array', () => {
    expect(ctx.transactionDescription(booked({ remittance_information: 'ONE  LINE' })))
      .toBe('ONE LINE');
  });
});

describe('counterpartyName', () => {
  it('is the creditor on the way out and the debtor on the way in', () => {
    // Getting this backwards fills the column with your own name, which
    // reads as working right up until you categorise by it.
    expect(ctx.counterpartyName(booked())).toBe('ESSELUNGA SPA');
    expect(ctx.counterpartyName(booked({ credit_debit_indicator: 'CRDT' })))
      .toBe('ACCOUNT HOLDER');
  });

  it('falls back to an IBAN rather than to the other side', () => {
    const raw = booked({ creditor: null, creditor_account: { iban: 'IT60X0542811101000000123456' } });
    expect(ctx.counterpartyName(raw)).toBe('IT60X0542811101000000123456');
  });

  it('is blank when the bank names nobody', () => {
    expect(ctx.counterpartyName(booked({ creditor: null, creditor_account: null }))).toBe('');
  });
});

describe('bankTransactionCode', () => {
  it('flattens either shape a provider might use', () => {
    expect(ctx.bankTransactionCode(booked())).toBe('PMNT/POSD');
    expect(ctx.bankTransactionCode({
      bank_transaction_code: { domain: 'PMNT', family: 'CCRD', sub_family: 'POSD' }
    })).toBe('PMNT/CCRD/POSD');
    expect(ctx.bankTransactionCode({ bank_transaction_code: 'PMNT' })).toBe('PMNT');
    expect(ctx.bankTransactionCode({})).toBe('');
  });
});

describe('mapTransaction', () => {
  it('fills the columns code owns and nothing else', () => {
    const record = ctx.mapTransaction(booked(), ACCOUNT, NOW);

    expect(record.account_id).toBe('acc-1');
    expect(record.account_name).toBe('Fineco');
    expect(record.amount).toBe(-12.34);
    expect(record.currency).toBe('EUR');
    expect(record.entry_reference).toBe('2026-0001');
    expect(record.mcc).toBe('5411');
    expect(record.source).toBe('enablebanking');
    expect(record.imported_at).toBe(NOW);

    // P onward belong to formulas and to the user.
    ctx.TX_COLUMNS_DERIVED.forEach((column) => expect(record[column]).toBeUndefined());
  });

  it('keeps the booking date when the bank sends one', () => {
    const record = ctx.mapTransaction(booked(), ACCOUNT, NOW);
    expect(record.booking_date).toEqual(new Date(2026, 6, 28));
  });

  it('borrows the value date, then the transaction date, when there is no booking date', () => {
    // PayPal sends only transaction_date. A blank booking_date puts the row
    // in no period, gives the import cutoff nothing to compare against, and
    // keeps cross-source matching from ever finding it.
    const valued = ctx.mapTransaction(booked({ booking_date: undefined }), ACCOUNT, NOW);
    expect(valued.booking_date).toEqual(new Date(2026, 6, 29));

    const paypal = ctx.mapTransaction(
      booked({ booking_date: undefined, value_date: undefined, transaction_date: '2026-07-27' }),
      ACCOUNT, NOW);
    expect(paypal.booking_date).toEqual(new Date(2026, 6, 27));
    expect(paypal.value_date).toBe('');
    expect(paypal.transaction_date).toEqual(new Date(2026, 6, 27));
  });

  it('leaves the booking date blank when the bank sends no date at all', () => {
    const record = ctx.mapTransaction(
      booked({ booking_date: undefined, value_date: undefined, transaction_date: undefined }),
      ACCOUNT, NOW);
    expect(record.booking_date).toBe('');
  });

  it('falls back to the account currency when the amount omits one', () => {
    const record = ctx.mapTransaction(booked({ transaction_amount: { amount: '5' } }), ACCOUNT, NOW);
    expect(record.currency).toBe('EUR');
  });
});

describe('mapTransactions', () => {
  it('keeps the readable rows and sets the unreadable ones aside', () => {
    // A blank amount sums as zero and disappears into a total, so it must
    // not be written as if it were a transaction.
    const result = ctx.mapTransactions(
      [booked(), booked({ transaction_amount: { amount: 'n/a' } })], ACCOUNT, NOW);

    expect(result.records).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
  });

  it('counts the rows that arrived with no direction', () => {
    const result = ctx.mapTransactions(
      [booked({ credit_debit_indicator: undefined })], ACCOUNT, NOW);
    expect(result.missingIndicator).toBe(1);
  });

  it('survives a null in the list', () => {
    expect(ctx.mapTransactions([null], ACCOUNT, NOW).records).toHaveLength(0);
    expect(ctx.mapTransactions(null, ACCOUNT, NOW).records).toHaveLength(0);
  });
});

describe('isBooked', () => {
  it('is the gate on what may enter transactions', () => {
    expect(ctx.isBooked(ctx.mapTransaction(booked(), ACCOUNT, NOW))).toBe(true);
    expect(ctx.isBooked(ctx.mapTransaction(booked({ status: 'PDNG' }), ACCOUNT, NOW))).toBe(false);
    expect(ctx.isBooked(ctx.mapTransaction(booked({ status: undefined }), ACCOUNT, NOW))).toBe(false);
  });
});
