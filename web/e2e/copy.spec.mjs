/**
 * The stored copy, in WebKit's real IndexedDB.
 *
 * Imported straight from Vite's dev server, so this exercises `copy.ts`
 * itself rather than a page built around it. What it cannot show is the thing
 * that decided the design — that a Home Screen icon keeps the copy after iOS
 * ends the process — which is a check on the device, not here.
 */

import { test, expect } from '@playwright/test';

const BATCH = { valueRanges: [{ range: "'transactions'!A1:AD", values: [['uid'], ['u1']] }] };

async function copyModule(page) {
  await page.route((url) => /^\/(api|auth)\//.test(url.pathname), (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.goto('/');
}

test('a copy survives a reload, for the account that read it and nobody else', async ({ page }) => {
  await copyModule(page);
  const written = await page.evaluate(async (batch) => {
    const copy = await import('/src/store/copy.ts');
    return copy.writeCopy({ owner: 'owner-1', timeZone: 'Europe/Rome', batch, savedAt: 1 });
  }, BATCH);
  expect(written).toBe(true);

  await page.reload();
  const read = await page.evaluate(async () => {
    const copy = await import('/src/store/copy.ts');
    return { mine: await copy.readCopy('owner-1'), theirs: await copy.readCopy('owner-2'), nobody: await copy.readCopy('') };
  });
  expect(read.mine).toEqual({ owner: 'owner-1', timeZone: 'Europe/Rome', batch: BATCH, savedAt: 1 });
  expect(read.theirs).toBeNull();
  expect(read.nobody).toBeNull();
});

test('forgetting leaves nothing, and forgetting nothing is fine', async ({ page }) => {
  await copyModule(page);
  const after = await page.evaluate(async (batch) => {
    const copy = await import('/src/store/copy.ts');
    const empty = await copy.forgetCopy();
    await copy.writeCopy({ owner: 'owner-1', timeZone: 'Europe/Rome', batch, savedAt: 1 });
    const forgotten = await copy.forgetCopy();
    return { empty, forgotten, left: await copy.readCopy('owner-1') };
  }, BATCH);
  expect(after).toEqual({ empty: true, forgotten: true, left: null });
});
