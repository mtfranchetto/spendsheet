/**
 * copy.ts — the last book this device read, kept in IndexedDB.
 *
 * ## Why this works where the old cache did not
 *
 * The Apps Script viewer kept its copy in `localStorage` on a
 * `googleusercontent.com` origin inside `script.google.com` — third-party
 * storage, which WebKit partitions and keeps **in memory**, so a Home Screen
 * icon lost it every time iOS ended the process. This page is first party on
 * its own origin, where IndexedDB is written to disk, and a Home Screen web
 * app is exempt from the seven-day wipe. The claim is checked on the device —
 * force-quit, reopen, the copy is there — not reasoned from a desktop browser,
 * which is how the last one was wrong.
 *
 * ## What is stored, and for whom
 *
 * **The raw `batchGet`**, not the answers computed from it: every screen and
 * every filter is a function of the book, so one copy answers all of them
 * offline, and a new version of the page recomputes from the same data rather
 * than trusting shapes an older page saved.
 *
 * **Tagged with the account that read it**, and only handed back to the same
 * one. Two people sharing a laptop browser sign in as themselves, and the
 * second must never be drawn the first one's balances while their own read is
 * in flight. `forgetCopy` is for the moments that must leave nothing behind:
 * signing out, and any refusal (phase 4 wires both, with a test that can go
 * red).
 *
 * ## Every access can fail, and none of them may break the page
 *
 * A private window, a full disk, or a storage the browser has decided not to
 * give this origin all surface as a throw or a failed request. Each function
 * here answers `null` or `false` instead: a missing copy is a slower open, and
 * a page that will not draw because its cache is unwell is a worse one.
 */

import type { BatchGet } from '../domain/book';

const DATABASE = 'spendsheet';
const STORE = 'copy';
const KEY = 'book';

export type StoredCopy = {
  /** The Google account ID (`sub`) that read it. */
  owner: string;
  timeZone: string;
  batch: BatchGet;
  /** `Date.now()` when it was read, for "as of" on screen. */
  savedAt: number;
};

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function open(factory: IDBFactory | undefined): Promise<IDBDatabase | null> {
  if (!factory) return null;
  const opening = factory.open(DATABASE, 1);
  opening.onupgradeneeded = () => {
    if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE);
  };
  return request(opening);
}

/** One transaction against the store, closed afterwards so a later `deleteDatabase` is never blocked. */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
  factory: IDBFactory | undefined
): Promise<T> {
  const db = await open(factory);
  if (!db) throw new Error('no IndexedDB');
  try {
    const tx = db.transaction(STORE, mode);
    // Listening before the request is made, so a commit that lands first is
    // still heard; a write is only kept once the transaction completes.
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    // Awaited together, so both have a handler from the start: a failed
    // request fails its transaction too, and a `done` nobody was waiting on
    // yet would surface as an unhandled rejection beside the `false` we return.
    const [result] = await Promise.all([request(work(tx.objectStore(STORE))), done]);
    return result;
  } finally {
    db.close();
  }
}

function defaultFactory(): IDBFactory | undefined {
  try {
    return globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

/** The stored copy, if there is one and `owner` read it. */
export async function readCopy(owner: string, factory = defaultFactory()): Promise<StoredCopy | null> {
  try {
    const copy = (await withStore('readonly', (store) => store.get(KEY), factory)) as StoredCopy | undefined;
    if (!copy || !owner || copy.owner !== owner || !copy.batch) return null;
    return copy;
  } catch {
    return null;
  }
}

/** Replace the stored copy. `false` when it could not be kept, which costs only the next open. */
export async function writeCopy(copy: StoredCopy, factory = defaultFactory()): Promise<boolean> {
  try {
    await withStore('readwrite', (store) => store.put(copy, KEY), factory);
    return true;
  } catch {
    return false;
  }
}

/** Leave nothing behind. Forgetting a copy that was not there costs nothing, so callers never check first. */
export async function forgetCopy(factory = defaultFactory()): Promise<boolean> {
  try {
    await withStore('readwrite', (store) => store.clear(), factory);
    return true;
  } catch {
    return false;
  }
}
