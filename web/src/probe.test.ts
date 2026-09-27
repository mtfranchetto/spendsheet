import { describe, it, expect } from 'vitest';
import { tabOf, rowCounts, googleMs, spread } from './probe';

describe('tabOf', () => {
  it('reads the tab out of a quoted or bare range', () => {
    expect(tabOf("'_config'!A1:Z")).toBe('_config');
    expect(tabOf('transactions!A1:AD1000')).toBe('transactions');
    expect(tabOf("'it''s'!A1")).toBe("it's");
  });
});

describe('rowCounts', () => {
  it('counts records by the key column, not by the array', () => {
    // A tab with an ARRAYFORMULA hands back trailing rows with no key; those are
    // not records, and counting them is how a ledger looked a thousand rows long.
    const counts = rowCounts({
      valueRanges: [
        { range: "'transactions'!A1:AD", values: [['uid', 'x'], ['u1', 1], ['u2', 2], ['', 'spill'], ['', 'spill']] },
        { range: "'_config'!A1:Z", values: [['key', 'value']] },
        { range: "'_runs'!A1:Z" }
      ]
    });
    expect(counts).toEqual({ transactions: 2, _config: 0, _runs: 0 });
  });
});

describe('googleMs', () => {
  it('reads the Worker\'s Server-Timing entry', () => {
    expect(googleMs('google;dur=842')).toBe(842);
    expect(googleMs('cfExtPri, google;dur=12.5')).toBe(12.5);
    expect(googleMs(null)).toBeNull();
    expect(googleMs('other;dur=5')).toBeNull();
  });
});

describe('spread', () => {
  it('gives min, median and max', () => {
    expect(spread([300, 100, 200])).toEqual({ min: 100, median: 200, max: 300 });
    expect(spread([4, 1, 3, 2])).toEqual({ min: 1, median: 2.5, max: 4 });
    expect(spread([])).toBeNull();
  });
});
