/**
 * The writes, in WebKit, against a Worker that keeps a book.
 *
 * `keeper()` holds a copy of the preview book and applies what each write
 * sends to it, answering with the rows read back the way the Worker does —
 * so a read after a write sees the write, and a read *held from before* it
 * does not. That second case is the one this file exists for: a read that
 * left before a write landed must not put the row back.
 */

import { test, expect } from '@playwright/test';
import { batch, signedIn, worker } from './worker.mjs';

function keeper() {
  const book = structuredClone(batch());
  const tx = book.valueRanges.find((range) => /transactions/.test(range.range));
  // The row count the health check remembers, so a delete that is not archived reads as rows lost.
  const monitor = book.valueRanges.find((range) => /_monitor/.test(range.range));
  monitor.values = [['transactions_rows', 'removed_rows'], [tx.values.length - 1, 0]];
  const header = tx.values[0];
  const rowOf = (uid) => tx.values.findIndex((cells) => cells[0] === uid) + 1;
  const read = (row) => header.map((_, i) => tx.values[row - 1][i] ?? '');
  const set = (row, name, value) => {
    const cells = tx.values[row - 1];
    while (cells.length < header.length) cells.push('');
    cells[header.indexOf(name)] = value;
  };
  return {
    rowOf,
    read: () => [200, structuredClone(book)],
    decide(body) {
      const rows = {};
      for (const decision of body.decisions) {
        if (decision.confirmed) set(decision.row, 'confirmed', true);
        if (decision.category_override) {
          set(decision.row, 'category_override', decision.category_override);
          set(decision.row, 'category', decision.category_override);
        }
        rows[decision.row] = read(decision.row);
      }
      const results = body.decisions.map((decision) => ({ uid: decision.uid, ok: true, wrote: ['confirmed'], refused: [] }));
      return [200, { written: results.length, skipped: 0, capped: false, results, rows }];
    },
    remove(body) {
      const removed = book.valueRanges.find((range) => /_removed/.test(range.range));
      removed.values = [...(removed.values ?? [['uid']]), [tx.values[body.row - 1][0]]];
      tx.values.splice(body.row - 1, 1);
      return [200, { message: 'Deleted.', rows: {}, removed: body.row }];
    }
  };
}

/**
 * A finger dragged right across `locator`, in the old touch API WebKit speaks.
 * `rise` is how far it travels down the page per pixel across — a thumb's arc.
 */
async function swipe(locator, distance = 160, rise = 0) {
  await locator.evaluate((target, [distance, rise]) => {
    const box = target.getBoundingClientRect();
    const top = box.top + box.height / 2;
    const point = (x, y) => document.createTouch(window, target, 1, x, y, x, y);
    const send = (type, dx) => {
      const some = document.createTouchList(point(box.left + 40 + dx, top + dx * rise));
      const none = document.createTouchList();
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === 'touchend' ? none : some,
          targetTouches: type === 'touchend' ? none : some,
          changedTouches: some
        })
      );
    };
    send('touchstart', 0);
    for (let dx = 10; dx <= distance; dx += 10) send('touchmove', dx);
    send('touchend', distance);
  }, [distance, rise]);
}

const review = (page) => page.locator('h2:has-text("Needs review") + .card');
const esselunga = (page) => review(page).locator('.tap').filter({ hasText: 'ESSELUNGA' });

/** The book as `keeper` holds it, with one account's balance as the sheet's formula would now say. */
function withBalance(book, name, balance) {
  const [, current] = book.read();
  const accounts = current.valueRanges.find((range) => /accounts/.test(range.range));
  const header = accounts.values[0];
  const row = accounts.values.find((cells) => cells[header.indexOf('name')] === name);
  row[header.indexOf('balance')] = balance;
  return [200, current];
}

async function open(page, extra = {}) {
  const book = keeper();
  const fake = await worker(page, {
    ...signedIn(),
    '/api/read': () => book.read(),
    '/api/act/decide': (body) => book.decide(body),
    '/api/act/delete': (body) => book.remove(body),
    ...extra
  });
  return { book, fake };
}

test('a swipe confirms the row at once, and sends its uid, its row and the contract', async ({ page }) => {
  const { book, fake } = await open(page);
  await page.goto('/');
  await expect(esselunga(page)).toHaveCount(1);

  const release = fake.hold('/api/act/decide');
  await swipe(esselunga(page));
  // Gone from the queue before the Worker has answered.
  await expect(esselunga(page)).toHaveCount(0);
  release();

  await expect.poll(() => fake.sent['/api/act/decide']?.length).toBe(1);
  const [sent] = fake.sent['/api/act/decide'];
  expect(sent.body).toEqual({ decisions: [{ confirmed: true, uid: 'r-6', row: book.rowOf('r-6') }] });
  expect(sent.headers['x-spendsheet-contract']).toBe('1');
  await expect(esselunga(page)).toHaveCount(0);
});

test('a drag that stops short of the threshold confirms nothing', async ({ page }) => {
  const { fake } = await open(page);
  await page.goto('/');
  await expect(esselunga(page)).toHaveCount(1);

  await swipe(esselunga(page), 100);
  await page.waitForTimeout(300);
  expect(fake.sent['/api/act/decide']).toBeUndefined();
  await expect(esselunga(page)).toHaveCount(1);
});

test('a diagonal drag is a scroll, however far across it goes', async ({ page }) => {
  const { fake } = await open(page);
  await page.goto('/');
  await expect(esselunga(page)).toHaveCount(1);

  // More across than down the whole way, which is what a thumb's arc looks like.
  await swipe(esselunga(page), 200, 0.8);
  await page.waitForTimeout(300);
  expect(fake.sent['/api/act/decide']).toBeUndefined();
  await expect(esselunga(page)).toHaveCount(1);
});

test('a row still opens on a tap after a swipe that fell short', async ({ page }) => {
  await open(page);
  await page.goto('/');
  await swipe(esselunga(page), 60);
  // Long enough that the tap is its own, not the click a touch leaves behind.
  await page.waitForTimeout(600);
  await esselunga(page).click();
  await expect(page.locator('dialog#sheet')).toBeVisible();
});

test('a read that left before a write landed does not put the row back', async ({ page }) => {
  const { fake } = await open(page);
  await page.goto('/');
  await expect(esselunga(page)).toHaveCount(1);
  await expect.poll(() => fake.counts['/api/read']).toBe(1);

  // A read goes out holding the book as it is now…
  const releaseRead = fake.hold('/api/read');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#screens h1').first().evaluate((target) => {
    const touch = (type, y) => {
      const some = document.createTouchList(document.createTouch(window, target, 1, 200, y, 200, y));
      const none = document.createTouchList();
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? none : some, targetTouches: type === 'touchend' ? none : some, changedTouches: some }));
    };
    touch('touchstart', 100);
    for (let y = 110; y <= 260; y += 10) touch('touchmove', y);
    touch('touchend', 260);
  });
  await expect.poll(() => fake.counts['/api/read']).toBe(2);

  // …then the row is confirmed, and the write lands first.
  await swipe(esselunga(page));
  await expect.poll(() => fake.sent['/api/act/decide']?.length).toBe(1);
  await page.waitForTimeout(200);

  releaseRead();
  // The stale read is dropped and the book read again, which has the write in it.
  await expect.poll(() => fake.counts['/api/read']).toBe(3);
  await page.waitForTimeout(200);
  await expect(esselunga(page)).toHaveCount(0);
});

test('a refusal puts the row back and says why', async ({ page }) => {
  await open(page, { '/api/act/decide': [422, { error: 'problem', message: 'That row has moved since this page read the book.' }] });
  await page.goto('/');
  await swipe(esselunga(page));
  await expect(page.locator('#toast')).toHaveText(/That row has moved/);
  await expect(esselunga(page)).toHaveCount(1);
});

test('a page older than the Worker reloads itself', async ({ page }) => {
  const { fake } = await open(page, { '/api/act/decide': [409, { error: 'contract', contract: 2 }] });
  await page.goto('/');
  await expect.poll(() => fake.counts['/api/me']).toBe(1);
  await swipe(esselunga(page));
  await expect.poll(() => fake.counts['/api/me']).toBe(2);
});

test('typing into the category search moves nothing on the sheet', async ({ page }) => {
  await open(page);
  await page.goto('/');
  await esselunga(page).click();
  const sheet = page.locator('dialog#sheet');
  await sheet.locator('.catpick-current').click();
  const list = sheet.locator('.catpick-list');
  const search = sheet.getByRole('searchbox', { name: 'Search categories' });
  await expect(search).toBeFocused();
  const before = { list: await list.boundingBox(), sheet: await sheet.boundingBox(), search: await search.boundingBox() };
  // The search is the top of the sheet, and the list is what is under it.
  expect(before.search.y - before.sheet.y).toBeLessThan(24);
  expect(before.list.y + before.list.height).toBeGreaterThan(before.sheet.y + before.sheet.height - 24);

  // A search that leaves a short list, then one that leaves nothing at all. No keyboard here:
  // this holds the list to one height, and the band above the keyboard is a check on the phone.
  for (const typed of ['groc', 'zzzz']) {
    await search.fill(typed);
    await expect(sheet.locator('.catpick-option').first().or(sheet.getByText('No category matches that.'))).toBeVisible();
    expect(await list.boundingBox()).toEqual(before.list);
    expect(await sheet.boundingBox()).toEqual(before.sheet);
    expect(await search.boundingBox()).toEqual(before.search);
  }

  // Cancel is back to the sheet, with nothing picked.
  await sheet.getByRole('button', { name: 'Cancel' }).click();
  await expect(search).toBeHidden();
  await expect(sheet.getByRole('button', { name: 'Confirm' })).toBeVisible();
  await expect(sheet.locator('.catpick-current')).toBeFocused();
});

test('the sheet recategorises and confirms in one write', async ({ page }) => {
  const { fake } = await open(page);
  await page.goto('/');
  await esselunga(page).click();
  const sheet = page.locator('dialog#sheet');
  await expect(sheet).toBeVisible();
  await sheet.locator('.catpick-current').click();
  await sheet.getByRole('searchbox', { name: 'Search categories' }).fill('groc');
  await sheet.locator('.catpick-option').first().click();
  await sheet.getByRole('button', { name: 'Confirm' }).click();
  await expect(sheet).toBeHidden();

  await expect.poll(() => fake.sent['/api/act/decide']?.length).toBe(1);
  const decision = fake.sent['/api/act/decide'][0].body.decisions[0];
  expect(decision).toMatchObject({ uid: 'r-6', confirmed: true, labels: [] });
  expect(decision.category_override).toBeTruthy();
});

test('cash you typed is deleted in two taps, and the row goes', async ({ page }) => {
  const { book, fake } = await open(page);
  await page.goto('/?v=records&p=last_12&q=cornetto');
  const row = page.locator('.tap').filter({ hasText: 'Caffè e cornetto' });
  await expect(row).toHaveCount(1);
  await row.click();

  const sheet = page.locator('dialog#sheet');
  await sheet.getByRole('button', { name: 'Delete' }).click();
  // Armed, and it stays armed: nothing is sent until the second tap.
  await page.waitForTimeout(300);
  expect(fake.sent['/api/act/delete']).toBeUndefined();
  const at = book.rowOf('c-1');
  await sheet.getByRole('button', { name: 'Tap again to delete' }).click();

  await expect(row).toHaveCount(0);
  await expect.poll(() => fake.sent['/api/act/delete']?.[0].body).toEqual({ uid: 'c-1', row: at });
  await expect(page.locator('#toast')).toHaveText('Deleted.');

  // The copy says where it went, so the health check does not call it lost.
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.locator('.big')).toBeVisible();
  await expect(page.getByText('Rows have disappeared')).toHaveCount(0);
});

test('a read that left while a write was out is not believed either', async ({ page }) => {
  const { fake } = await open(page);
  await page.goto('/');
  await expect(esselunga(page)).toHaveCount(1);
  await expect.poll(() => fake.counts['/api/read']).toBe(1);

  // The write goes out and is held; a read leaves after it, answered from before it.
  const releaseWrite = fake.hold('/api/act/decide');
  await swipe(esselunga(page));
  await expect.poll(() => fake.counts['/api/act/decide']).toBe(1);
  const releaseRead = fake.hold('/api/read');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('#screens h1').first().evaluate((target) => {
    const touch = (type, y) => {
      const some = document.createTouchList(document.createTouch(window, target, 1, 200, y, 200, y));
      const none = document.createTouchList();
      target.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? none : some, targetTouches: type === 'touchend' ? none : some, changedTouches: some }));
    };
    touch('touchstart', 100);
    for (let y = 110; y <= 260; y += 10) touch('touchmove', y);
    touch('touchend', 260);
  });
  await expect.poll(() => fake.counts['/api/read']).toBe(2);

  // The write settles first, then the read from before it lands.
  releaseWrite();
  await page.waitForTimeout(200);
  releaseRead();
  await expect.poll(() => fake.counts['/api/read']).toBe(3);
  await page.waitForTimeout(200);
  await expect(esselunga(page)).toHaveCount(0);
});

test('"+ Add" opens the form on that account, a retry sends the same entry, and it lands back on Home with the new balance', async ({ page }) => {
  const answers = [[503, { error: 'down' }], [200, { message: '1 added', rows: {} }]];
  let account = '';
  const { book, fake } = await open(page, {
    '/api/act/cash': () => {
      const answer = answers.shift();
      // From here on the sheet's formula says the new balance, as Google would.
      if (answer[0] === 200) fake.answers['/api/read'] = () => withBalance(book, account, 777.77);
      return answer;
    }
  });
  await page.goto('/');
  const add = page.getByRole('button', { name: /^Add a transaction to / }).first();
  account = (await add.getAttribute('aria-label')).replace('Add a transaction to ', '');
  await add.click();
  await expect(page.getByRole('heading', { name: 'Add transaction' })).toBeVisible();
  await expect(page).toHaveURL(/v=add/);

  await page.locator('input[inputmode="decimal"]').fill('3.50');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText(/Could not reach the server/);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#toast')).toHaveText('Added.');

  const [first, second] = fake.sent['/api/act/cash'].map((entry) => entry.body);
  expect(first).toMatchObject({ amount: 3.5, direction: 'expense', account });
  expect(first.id).toMatch(/^[0-9a-f]{24}$/);
  expect(second.id).toBe(first.id);

  // Back where it was added from, and the tile reads the book again: a cash
  // account's balance is the sheet's formula, which no answer carries.
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.tile', { hasText: account })).toContainText('777.77');
});

test('"Update" sets the value of an asset, lands back on Home, and the tile shows it', async ({ page }) => {
  let account = '';
  const { book, fake } = await open(page, {
    '/api/act/cash': () => {
      fake.answers['/api/read'] = () => withBalance(book, account, 98765.43);
      return [200, { message: '1 added', rows: {} }];
    }
  });
  await page.goto('/');
  const update = page.getByRole('button', { name: /^Update the balance of / }).first();
  account = (await update.getAttribute('aria-label')).replace('Update the balance of ', '');
  await update.click();
  await expect(page).toHaveURL(/v=value/);

  const field = page.locator('input[inputmode="decimal"]');
  await field.fill('98765.43');
  await page.locator('button.primary').click();

  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('.tile', { hasText: account })).toContainText('98,765.43');
  expect(fake.sent['/api/act/cash']).toHaveLength(1);
});
