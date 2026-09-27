/*
  sw.js — the shell, from this device, before the network is asked anything.

  Plain JavaScript in `public/` rather than a module Vite builds, because a
  service worker's URL is its identity: a hashed name would register a new
  worker on every deploy and leave the old one serving the old page.

  What it caches is the **shell only** — `index.html` and the hashed files it
  names. Never `/api`, `/auth` or `/connect`: those are the Worker's, they carry
  balances or tokens, and a cached answer to "am I signed in" is the bug the
  last viewer shipped twice. The data has its own copy, in IndexedDB, keyed to
  the account that read it (`src/store/copy.ts`).

  Cache first, then revalidate in the background: an open draws from here with
  no network at all, and whatever the network says is kept for the *next*
  open. So a deploy takes effect one open late and never mid-session, with no
  prompt — the decided behaviour. When a new `index.html` arrives, the files it
  names are fetched in the same background step, so the next open does not
  find a shell pointing at scripts it never saw; only after they are all in is
  anything the new shell no longer names deleted.
*/

const CACHE = 'shell-v1';
const SHELL = '/';
const WORKER_PATHS = /^\/(api|auth|connect)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

/** A response fit to keep: ours, complete, and not a redirect, which Safari refuses to serve for a navigation. */
function keepable(response) {
  return response && response.ok && response.type === 'basic' && !response.redirected;
}

/** Same-origin `/assets/…` URLs an `index.html` names. */
function assetsIn(html) {
  const found = new Set();
  for (const match of html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) found.add(match[1]);
  return [...found];
}

/** A new shell has arrived: fetch what it names, then drop what it no longer does. */
async function adoptShell(cache, response) {
  const assets = assetsIn(await response.clone().text());
  await cache.addAll(assets);
  await cache.put(SHELL, response);
  const keep = new Set(assets.map((path) => new URL(path, self.location.origin).href));
  for (const request of await cache.keys()) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/assets/') && !keep.has(url.href)) await cache.delete(request);
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || WORKER_PATHS.test(url.pathname)) return;

  // Every navigation is the one shell; the page reads its own query string.
  const navigation = request.mode === 'navigate';
  const key = navigation ? SHELL : request;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(key);

    const fresh = fetch(request).then(async (response) => {
      // Keeping it is a favour to the next open, never a condition of this
      // one: a shell whose assets could not all be fetched is simply not
      // adopted, and the page in front of you still gets its response.
      if (keepable(response)) {
        try {
          if (navigation) await adoptShell(cache, response.clone());
          else await cache.put(request, response.clone());
        } catch {
          // The previous shell stays, whole.
        }
      }
      return response;
    });

    if (hit) {
      event.waitUntil(fresh.catch(() => undefined));
      return hit;
    }
    return fresh;
  })());
});
