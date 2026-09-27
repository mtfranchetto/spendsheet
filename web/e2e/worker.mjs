/**
 * worker.mjs — the Worker, answered by `page.route`, with a real book behind it.
 *
 * The book is `tests/book.mjs` — the one the Apps Script preview draws — read
 * back through `tests/batch.mjs` exactly as the parity test reads it, so the
 * numbers on screen here are numbers that test has held to the `.gs`.
 *
 * Every path not answered is a 500, like a Worker that is down. A path can be
 * held: `hold('/api/read')` returns a function that releases it, which is how
 * a test puts a read in the air and does something before it lands.
 */

import { previewBook } from '../../tests/book.mjs';
import { asBatchGet } from '../../tests/batch.mjs';

export const OWNER = '104729384756102938475';
export const ME = { email: 'owner@example.com', sub: OWNER };

let cached;
/** The preview's book as a batchGet. Built once per worker process: the harness is not free. */
export function batch() {
  if (!cached) cached = asBatchGet(previewBook());
  return cached;
}

export function signedIn() {
  return {
    '/api/me': [200, ME],
    '/api/book': [200, { title: 'Spendsheet', timeZone: 'Europe/Rome' }],
    '/api/read': [200, batch()],
    '/api/health': [200, { ok: true, build: 'test', configured: {} }],
    '/auth/signout': [200, { ok: true }]
  };
}

/**
 * Route every Worker path through `answers`, which may be changed between
 * requests. Returns the per-path request counts and a `hold`.
 */
export async function worker(page, answers = {}) {
  const counts = {};
  const held = {};
  await page.route((url) => /^\/(api|auth)\//.test(url.pathname), async (route) => {
    const path = new URL(route.request().url()).pathname;
    counts[path] = (counts[path] || 0) + 1;
    if (held[path]) await held[path];
    const [status, body] = answers[path] ?? [500, { error: 'down' }];
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return {
    answers,
    counts,
    hold(path) {
      let release;
      held[path] = new Promise((resolve) => (release = resolve));
      return () => {
        delete held[path];
        release();
      };
    }
  };
}

/** The stored copy's owner, or null — read with the raw IndexedDB API, as nothing of the page's own. */
export function storedOwner(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('spendsheet', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('copy');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          const get = db.transaction('copy', 'readonly').objectStore('copy').get('book');
          get.onsuccess = () => {
            db.close();
            resolve(get.result ? get.result.owner : null);
          };
          get.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      })
  );
}
