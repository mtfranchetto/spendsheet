import { describe, expect, it } from 'vitest';
import { bookFromBatch, configNumber, tabOf } from './book';

describe('a batchGet, as a book', () => {
  it('matches each range to its tab by name, not by position', () => {
    const book = bookFromBatch({
      valueRanges: [
        { range: "'_runs'!A1:K3", values: [['run_id'], ['r1']] },
        { range: "'_status'!A1:I9", values: [['connection_id'], ['c1'], ['c2']] }
      ]
    }, 'Europe/Rome');
    expect(book.runs.map((row) => row.run_id)).toEqual(['r1']);
    expect(book.status.map((row) => row.connection_id)).toEqual(['c1', 'c2']);
  });

  it('pads a row the API cut short, so its tail reads as empty rather than absent', () => {
    const book = bookFromBatch({
      valueRanges: [{ range: "'transactions'!A1:AD9", values: [['uid'], ['u1', 'acc', 'Revolut']] }]
    }, 'Europe/Rome');
    expect(book.transactions[0].in_reports).toBe('');
    expect(book.transactions[0]._row).toBe(2);
  });

  it('counts records by the uid, not by the rows a spilled formula returns', () => {
    const book = bookFromBatch({
      valueRanges: [{ range: "'transactions'!A1:AD9", values: [['uid'], ['u1'], ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 0]] }]
    }, 'Europe/Rome');
    expect(book.transactions).toHaveLength(1);
  });

  it('is empty, not broken, for a tab the response did not carry', () => {
    const book = bookFromBatch({ valueRanges: [{ range: "'_monitor'!A1:B" }] }, 'Europe/Rome');
    expect(book.transactions).toEqual([]);
    expect(book.monitor).toBeNull();
    expect(book.removedUids).toEqual([]);
  });

  it('resolves _config over the defaults, and a blank value falls back', () => {
    const book = bookFromBatch({
      valueRanges: [{ range: "'_config'!A1:B", values: [['key', 'value'], ['review_queue_size', 20], ['stale_balance_days', '']] }]
    }, 'Europe/Rome');
    expect(configNumber(book.config, 'review_queue_size')).toBe(20);
    expect(configNumber(book.config, 'stale_balance_days')).toBe(3);
    expect(book.config.base_currency).toBe('EUR');
  });

  it('keeps only memory rows that have a key', () => {
    const book = bookFromBatch({
      valueRanges: [{ range: "'_memory'!A1:E", values: [['merchant_key'], ['coop', 'Food'], ['  ', 'Food'], ['esselunga', 'Food']] }]
    }, 'Europe/Rome');
    expect(book.memory.map((row) => row.merchant_key)).toEqual(['coop', 'esselunga']);
  });
});

describe('tabOf', () => {
  it('unquotes a name and undoubles its quotes', () => {
    expect(tabOf("'_config'!A1:B")).toBe('_config');
    expect(tabOf('transactions!A1:AD1000')).toBe('transactions');
    expect(tabOf("'Mattia''s'!A1")).toBe("Mattia's");
  });
});
