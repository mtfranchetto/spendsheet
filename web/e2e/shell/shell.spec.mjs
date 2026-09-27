/**
 * The shell opens with the server gone, from the service worker's cache.
 *
 * Against the **built** page, because the worker registers only there. And
 * against a `vite preview` this test starts and stops itself, because the
 * obvious ways of faking offline do not reach a WebKit service worker:
 * `setOffline` fails the request before the worker is asked, and a routed
 * abort intercepts a navigation in front of it ("Blocked by Web Inspector").
 * A server that is really not there is the only offline that means anything.
 *
 * What it can prove: after one visit the shell draws with no server, and
 * nothing the Worker answers was put in the cache. What it cannot: that iOS
 * keeps that cache for a Home Screen icon, which is a check on the device.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const PORT = 4325;
const ORIGIN = `http://localhost:${PORT}`;
const WEB = fileURLToPath(new URL('../../', import.meta.url));

/** `vite preview` over the `dist/` the project's own server built, answering before this returns. */
async function startPreview() {
  const server = spawn('npx', ['vite', 'preview', `--port=${PORT}`, '--strictPort'], { cwd: WEB, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    const up = await fetch(ORIGIN).then((r) => r.ok, () => false);
    if (up) return server;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  server.kill();
  throw new Error('vite preview did not start');
}

async function stopPreview(server) {
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  await exited;
  for (let i = 0; i < 50; i++) {
    const down = await fetch(ORIGIN).then(() => false, () => true);
    if (down) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('vite preview did not stop');
}

test('after one visit, the shell draws with the server gone, and no Worker answer was cached', async ({ browser }) => {
  const server = await startPreview();
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();

  try {
    await page.goto(ORIGIN + '/');
    // One visit and nothing else. That page's own scripts were fetched before
    // the worker existed, so only its install can have put them in the cache
    // — an online reload here would fill it by the back door and hide an
    // install that kept the page and not what the page loads.
    await page.evaluate(() => navigator.serviceWorker.ready);
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

    const cached = await page.evaluate(async () => {
      const out = [];
      for (const name of await caches.keys()) {
        for (const request of await (await caches.open(name)).keys()) out.push(new URL(request.url).pathname);
      }
      return out;
    });
    expect(cached).toContain('/');
    expect(cached.some((path) => path.startsWith('/assets/'))).toBe(true);
    expect(cached.filter((path) => /^\/(api|auth|connect)/.test(path))).toEqual([]);
  } finally {
    await stopPreview(server);
  }

  // A query string still gets the one shell: the page reads it for itself.
  await page.goto(ORIGIN + '/?signin=refused');
  await expect(page.locator('h1')).toHaveText('Spendsheet');
  await context.close();
});
