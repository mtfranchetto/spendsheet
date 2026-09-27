/**
 * merchant.ts — `normalizeMerchant` and the memory suggestions, from
 * `14_categorize.gs`.
 *
 * The key is what a rule built on the phone matches on, and what `_memory` is
 * keyed by, so it has to be **the same function** as the categoriser's, not a
 * similar one. The parity test runs both over the same descriptions; the
 * reasoning behind each step (why cities stay, why three digits end a name) is
 * in the `.gs`, where the categoriser that has to agree with it lives.
 */

import type { Cell } from '../sheets/records';
import type { Row } from './book';
import { MERCHANT_KEY_MAX_TOKENS, MERCHANT_LETTER_FOLDS, MERCHANT_NOISE_WORDS } from './schema';

function foldLetters(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[øæœßłđðþı]/g, (letter) => MERCHANT_LETTER_FOLDS[letter]);
}

function looksLikeAccountNumber(value: string): boolean {
  const compact = value.replace(/\s+/g, '');
  if (/^[A-Za-z]{2}\d{2}[A-Za-z0-9]{8,}$/.test(compact)) return true;
  return /^\d{6,}$/.test(compact);
}

function merchantSource(description: Cell | undefined, counterparty: Cell | undefined): string {
  const party = String(counterparty === null || counterparty === undefined ? '' : counterparty).trim();
  if (party && !looksLikeAccountNumber(party)) return party;
  return String(description === null || description === undefined ? '' : description).trim();
}

export function normalizeMerchant(description: Cell | undefined, counterparty: Cell | undefined): string {
  const source = merchantSource(description, counterparty);
  if (!source) return '';

  let cleaned = foldLetters(source.toLowerCase());
  cleaned = cleaned
    .replace(/\b\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ');
  cleaned = cleaned.replace(/carta\s*n?\.?\s*\*?\s*\d+/g, ' ').replace(/\*+\s*\d+/g, ' ');
  cleaned = cleaned.replace(/[^a-z0-9]+/g, ' ');

  const tokens = cleaned.split(' ').filter((token) => {
    if (!token) return false;
    if (token.length < 2) return false;
    if (/^\d+$/.test(token)) return false;
    if (token.replace(/\D/g, '').length >= 3) return false;
    return MERCHANT_NOISE_WORDS.indexOf(token) === -1;
  });

  return tokens.slice(0, MERCHANT_KEY_MAX_TOKENS).join(' ');
}

export type MemoryEntry = { key: string; category: string; subcategory: string; hits: number };
export type Suggestion = { category: string; subcategory: string; from: string };
export type SuggestionIndex = {
  entries: { entry: MemoryEntry; words: string[] }[];
  spread: { [word: string]: number };
};

/** `_memory` as key → entry; an entry with no category offers nothing and is dropped. */
export function buildMemoryIndex(rows: readonly Row[]): { [key: string]: MemoryEntry } {
  const byKey: { [key: string]: MemoryEntry } = {};
  for (const row of rows) {
    const key = String(row.merchant_key).trim().toLowerCase();
    if (!key) continue;
    const category = String(row.category || '');
    if (!category) continue;
    byKey[key] = {
      key,
      category,
      subcategory: String(row.subcategory || ''),
      hits: Number(row.hits) || 0
    };
  }
  return byKey;
}

export function suggestionIndex(memory: { [key: string]: MemoryEntry }): SuggestionIndex {
  const entries = Object.keys(memory || {}).map((key) => ({ entry: memory[key], words: key.split(' ') }));
  const spread: { [word: string]: number } = {};
  for (const item of entries) for (const word of item.words) spread[word] = (spread[word] || 0) + 1;
  return { entries, spread };
}

/** A guess for a merchant memory has never seen: same first word, rarest shared words, most hits. */
export function suggestCategory(merchantKey: string, index: SuggestionIndex | null): Suggestion | null {
  const key = String(merchantKey || '').trim();
  if (!key || !index) return null;

  const words: { [word: string]: boolean } = {};
  const lead = key.split(' ')[0];
  for (const word of key.split(' ')) words[word] = true;

  let best: MemoryEntry | null = null;
  let bestScore = 0;
  for (const item of index.entries) {
    if (item.entry.key === key || item.words[0] !== lead) continue;
    let score = 0;
    for (const word of item.words) if (words[word]) score += 1 / index.spread[word];
    if (!best || score > bestScore || (score === bestScore && item.entry.hits > best.hits)) {
      best = item.entry;
      bestScore = score;
    }
  }

  return best ? { category: best.category, subcategory: best.subcategory, from: best.key } : null;
}
