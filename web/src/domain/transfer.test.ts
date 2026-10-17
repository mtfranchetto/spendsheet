import { describe, expect, it } from 'vitest';
import { arrives, movedIn } from './transfer';

describe('movedIn', () => {
  const row = { amount: 1000 as number | null, rawAmount: 1000 as number | null, type: 'income', peerDirection: '' as '' | 'from' | 'to' };

  it('asks where an unpaired credit came from, and an unpaired debit where it went', () => {
    expect(movedIn(row)).toBe(true);
    expect(movedIn({ ...row, amount: -1000, rawAmount: -1000, type: 'expense' })).toBe(false);
  });

  it('takes the stored sign when no rate has priced the row', () => {
    expect(movedIn({ ...row, amount: null })).toBe(true);
  });

  it('defers to the pairing once there is one', () => {
    expect(movedIn({ ...row, peerDirection: 'to' })).toBe(false);
    expect(movedIn({ ...row, amount: -5, rawAmount: -5, peerDirection: 'from' })).toBe(true);
  });
});

describe('arrives', () => {
  it('goes by the sign, by the stored type at zero, and claims nothing for no figure', () => {
    expect(arrives(5, 'expense')).toBe(true);
    expect(arrives(-5, 'income')).toBe(false);
    expect(arrives(0, 'income')).toBe(true);
    expect(arrives(0, 'expense')).toBe(false);
    expect(arrives(null, 'income')).toBe(false);
  });
});
