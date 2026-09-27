import { describe, expect, it } from 'vitest';
import { buildMemoryIndex, suggestCategory, suggestionIndex } from './merchant';

describe('suggesting a category for a merchant memory has never seen', () => {
  const entry = (merchant_key: string, category: string, subcategory: string, hits = 1) => ({ _row: 0, merchant_key, category, subcategory, hits });
  const suggest = (key: string, entries: ReturnType<typeof entry>[]) =>
    suggestCategory(key, suggestionIndex(buildMemoryIndex(entries)));

  it('offers the merchant it shares a name with, and says which', () => {
    expect(suggest('esselunga milano', [
      entry('esselunga torino', 'Food & Drink', 'Groceries'),
      entry('netflix', 'Life & Entertainment', 'Streaming')
    ])).toEqual({ category: 'Food & Drink', subcategory: 'Groceries', from: 'esselunga torino' });
  });

  it('does not file a merchant by the city it is in', () => {
    // Keys keep their city, so a city sits in many keys filed many ways.
    // Sharing one says nothing about what was bought.
    expect(suggest('farmacia milano', [
      entry('esselunga milano', 'Food & Drink', 'Groceries'),
      entry('trattoria milano', 'Food & Drink', 'Restaurants'),
      entry('zara milano', 'Shopping', 'Clothes')
    ])).toBeNull();
  });

  it('does not suggest from a city even when only one merchant has it', () => {
    // On a young book every word is rare, so rarity alone cannot tell a shared
    // city from a shared name.
    expect(suggest('farmacia firenze', [entry('trattoria firenze', 'Food & Drink', 'Restaurants')])).toBeNull();
  });

  it('prefers the branch that shares more than the name', () => {
    expect(suggest('esselunga milano', [
      entry('esselunga torino', 'Food & Drink', 'Groceries', 50),
      entry('esselunga milano centro', 'Food & Drink', 'Supermarket', 1)
    ])?.from).toBe('esselunga milano centro');
  });

  it('breaks a tie with the entry you have confirmed more', () => {
    expect(suggest('amazon marketplace', [
      entry('amazon prime', 'Life & Entertainment', 'Streaming', 2),
      entry('amazon eu', 'Shopping', 'Online', 40)
    ])?.from).toBe('amazon eu');
  });

  it('offers nothing when nothing is shared, or there is no key', () => {
    const entries = [entry('esselunga torino', 'Food & Drink', 'Groceries')];
    expect(suggest('netflix', entries)).toBeNull();
    expect(suggest('', entries)).toBeNull();
    expect(suggest('netflix', [])).toBeNull();
  });
});
