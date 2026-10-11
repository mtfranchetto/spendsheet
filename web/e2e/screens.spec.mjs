/**
 * The three screens, drawn from a real book, in WebKit, on the built page.
 *
 * What these can prove: the screens draw what the book holds, the address is
 * the view in both directions, the stored copy is drawn before the read lands,
 * and **nothing of an account stays on the device after it signs out or is
 * refused** — including when a read was still in the air, which is the one
 * the Apps Script viewer got wrong twice. What they cannot: that iOS keeps the
 * copy for a Home Screen icon, or how the phone sizes a native control. Those
 * are checks on the device.
 */

import { test, expect } from '@playwright/test';
import { OWNER, signedIn, storedOwner, worker } from './worker.mjs';

test('the dashboard draws the book, and the tabs and the address agree', async ({ page }) => {
  await worker(page, signedIn());
  await page.goto('/');
  await expect(page.locator('.big')).toHaveText('€42,232.89');
  await expect(page.locator('.tile')).toHaveCount(4);
  await expect(page.getByText('Fineco: bank consent expires in 6 days')).toBeVisible();

  await page.locator('#tabs button', { hasText: 'Records' }).click();
  await expect(page.locator('h1')).toHaveText('Records');
  await expect(page).toHaveURL(/\?v=records$/);

  await page.locator('#tabs button', { hasText: 'Home' }).click();
  await expect(page).toHaveURL(/\/$/);
});

test('an account tile opens its records, and the filter is in the address', async ({ page }) => {
  await worker(page, signedIn());
  await page.goto('/');
  await page.locator('.tile', { hasText: 'Fineco' }).click();
  await expect(page).toHaveURL(/v=records&a=Fineco/);
  await expect(page.locator('.filters .chip.on', { hasText: 'Fineco' })).toBeVisible();
  await expect(page.locator('.rec-sub', { hasText: 'Wallet' })).toHaveCount(0);
});

test('a deep link opens the screen and filters it names', async ({ page }) => {
  await worker(page, signedIn());
  await page.goto('/?v=records&u=1&p=last_12');
  await expect(page.locator('.filters').getByRole('button', { name: 'Needs review' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.stepper .when')).toHaveText('Last 12 months');
  // Twelve months ending today is no one month or year, so there is nothing to step by.
  await expect(page.locator('.stepper .step')).toHaveCount(0);
  // Every row drawn is one that needs review.
  await expect(page.locator('.tap .check')).toHaveCount(0);
});

test('a category opens onto its children, and a child drills into Records with a chip to undo it', async ({ page }) => {
  await worker(page, signedIn());
  await page.goto('/?v=analytics');
  await page.locator('.catrow', { hasText: 'Food & Drink' }).last().click();
  await page.locator('.catkid', { hasText: 'Groceries' }).last().click();
  await expect(page.locator('h1')).toHaveText('Records');
  await expect(page.locator('.filters .chip.on')).toHaveCount(3);
  await page.locator('.filters').getByRole('button', { name: 'Clear' }).click();
  await expect(page.locator('.filters .chip.on')).toHaveCount(0);
});

test('the arrows step the period a year or a month at a time, and stop at the present', async ({ page }) => {
  await worker(page, signedIn());
  const now = new Date();
  const year = now.getFullYear();

  // Records opens on the year so far.
  await page.goto('/?v=records');
  await expect(page.locator('.stepper .when')).toHaveText(String(year));
  await expect(page.getByRole('button', { name: 'Next year' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous year' }).click();
  await expect(page.locator('.stepper .when')).toHaveText(String(year - 1));
  await expect(page).toHaveURL(new RegExp('p=year%3A' + (year - 1)));
  await page.getByRole('button', { name: 'Next year' }).click();
  await expect(page).toHaveURL(/\?v=records$/);

  // Charts opens on the month so far, and a step back crosses into last year in January.
  await page.locator('#tabs button', { hasText: 'Charts' }).click();
  await expect(page.getByRole('button', { name: 'Next month' })).toBeDisabled();
  await page.getByRole('button', { name: 'Previous month' }).click();
  const before = new Date(year, now.getMonth() - 1, 1);
  const id = before.getFullYear() + '-' + String(before.getMonth() + 1).padStart(2, '0');
  await expect(page).toHaveURL(new RegExp('p=month%3A' + id));
  await page.getByRole('button', { name: 'Next month' }).click();
  await expect(page).toHaveURL(/\?v=analytics$/);
});

test('a pill opens a sheet, and what is chosen there is on the pill and in the address', async ({ page }) => {
  await worker(page, signedIn());
  await page.goto('/?v=records');
  const pill = page.locator('.filters .chip.opens').first();
  await expect(pill).toHaveText('Accounts');
  await pill.click();
  await page.getByRole('option', { name: 'Fineco' }).click();
  // Several at a time, so the sheet stays until it is dismissed.
  await expect(page.getByRole('option', { name: 'Fineco' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('option', { name: 'Fineco' })).toBeHidden();
  await expect(pill).toHaveText('Fineco');
  await expect(page).toHaveURL(/v=records&a=Fineco/);
  await expect(page.locator('.rec-sub', { hasText: 'Wallet' })).toHaveCount(0);

  // A period from the sheet closes it.
  await page.locator('.stepper .when').click();
  await page.getByRole('option', { name: 'Last 12 months' }).click();
  await expect(page.getByRole('option', { name: 'Last 12 months' })).toBeHidden();
  await expect(page.locator('.stepper .when')).toHaveText('Last 12 months');
  await expect(page).toHaveURL(/p=last_12/);
});

test('the stored copy is drawn before the read lands, and says how old it is', async ({ page }) => {
  const fake = await worker(page, signedIn());
  await page.goto('/');
  await expect.poll(() => storedOwner(page)).toBe(OWNER);

  const release = fake.hold('/api/read');
  await page.reload();
  await expect(page.locator('.big')).toHaveText('€42,232.89');
  await expect(page.locator('#refresh')).toHaveText(/Last updated/);
  release();
  await expect(page.locator('#refresh')).toBeHidden();
});

test('with no server to ask, the stored copy is drawn anyway and says it is the last one', async ({ page }) => {
  const fake = await worker(page, signedIn());
  await page.goto('/');
  await expect.poll(() => storedOwner(page)).toBe(OWNER);

  fake.answers['/api/me'] = [503, { error: 'down' }];
  fake.answers['/api/read'] = [503, { error: 'down' }];
  await page.reload();
  await expect(page.locator('.big')).toHaveText('€42,232.89');
  await expect(page.getByText(/This is the last copy this phone kept/).first()).toBeVisible();
  await expect(page.getByText('Could not reach the server')).toHaveCount(0);

  // Back online, a pull opens properly: who, then the read.
  fake.answers['/api/me'] = signedIn()['/api/me'];
  fake.answers['/api/read'] = signedIn()['/api/read'];
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.reload();
  await expect(page.getByText(/This is the last copy this phone kept/)).toHaveCount(0);
});

test('"Book chosen" goes once the book has been read', async ({ page }) => {
  const fake = await worker(page, signedIn());
  const release = fake.hold('/api/read');
  await page.goto('/?connected=1');
  await expect(page.getByText('Book chosen. Reading it…')).toBeVisible();
  release();
  await expect(page.locator('.big')).toHaveText('€42,232.89');
  await expect(page.getByText('Book chosen. Reading it…')).toHaveCount(0);
});

test('signing out forgets the copy, and a read already in the air cannot put it back', async ({ page }) => {
  const fake = await worker(page, signedIn());
  await page.goto('/');
  await expect.poll(() => storedOwner(page)).toBe(OWNER);

  const release = fake.hold('/api/read');
  await page.reload();
  await expect(page.locator('.big')).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Not signed in.')).toBeVisible();

  release();
  await expect.poll(() => fake.counts['/api/read']).toBe(2);
  await page.waitForTimeout(300);
  expect(await storedOwner(page)).toBeNull();
  await expect(page.locator('.big')).toHaveCount(0);
});

test('a refusal on opening forgets the copy', async ({ page }) => {
  const fake = await worker(page, signedIn());
  await page.goto('/');
  await expect.poll(() => storedOwner(page)).toBe(OWNER);

  fake.answers['/api/me'] = [401, { error: 'Not available.' }];
  await page.reload();
  await expect(page.getByText('Not signed in.')).toBeVisible();
  await expect.poll(() => storedOwner(page)).toBeNull();
});

test('a refusal from the read forgets the copy, and a dropped read keeps it', async ({ page }) => {
  const fake = await worker(page, signedIn());
  await page.goto('/');
  await expect.poll(() => storedOwner(page)).toBe(OWNER);

  // A dropped connection is not a refusal: the copy is drawn and kept.
  fake.answers['/api/read'] = [502, { error: 'down' }];
  await page.reload();
  await expect(page.locator('.big')).toBeVisible();
  await expect(page.locator('#toast')).toHaveText(/last copy/);
  expect(await storedOwner(page)).toBe(OWNER);

  fake.answers['/api/read'] = [401, { error: 'Not available.' }];
  await page.reload();
  await expect(page.getByText('Not signed in.')).toBeVisible();
  await expect.poll(() => storedOwner(page)).toBeNull();
});

/**
 * A one-finger vertical drag. WebKit refuses `new Touch` and a `TouchEvent`
 * built from a plain array, so the points go through the older
 * `createTouch`/`createTouchList`, which is the only shape it accepts.
 */
async function drag(page, fromY, toY) {
  await page.evaluate(
    ({ fromY, toY }) => {
      const target = document.querySelector('#screens h1');
      const point = (y) => document.createTouch(window, target, 1, 200, y, 200, y);
      const touch = (type, y) => {
        const one = point(y);
        const none = document.createTouchList();
        const some = document.createTouchList(one);
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
      touch('touchstart', fromY);
      for (let y = fromY + 10; y <= toY; y += 10) touch('touchmove', y);
      touch('touchend', toY);
    },
    { fromY, toY }
  );
}

test('pulling down at the top reads the book again', async ({ page }) => {
  const fake = await worker(page, signedIn());
  await page.goto('/');
  await expect(page.locator('.big')).toBeVisible();
  await expect.poll(() => fake.counts['/api/read']).toBe(1);

  const release = fake.hold('/api/read');
  await drag(page, 100, 260);
  await expect(page.locator('#refresh')).toHaveText('Refreshing');
  release();
  await expect.poll(() => fake.counts['/api/read']).toBe(2);
  await expect(page.locator('#refresh')).toBeHidden();

  // A short pull is not a refresh.
  await drag(page, 100, 140);
  await page.waitForTimeout(300);
  expect(fake.counts['/api/read']).toBe(2);
});

test('the page cannot be pinched or double-tapped into a zoom', async ({ page }) => {
  await worker(page, signedIn());
  await page.goto('/');
  await expect(page.locator('.big')).toBeVisible();

  const refused = await page.evaluate(() => {
    const viewport = document.querySelector('meta[name="viewport"]').getAttribute('content');
    // WebKit's pinch events, which a test cannot synthesise from a real
    // gesture — so they are sent as the plain events they are.
    const cancelled = (type) => {
      const event = new Event(type, { bubbles: true, cancelable: true });
      document.querySelector('.big').dispatchEvent(event);
      return event.defaultPrevented;
    };
    return {
      viewport,
      touchAction: getComputedStyle(document.documentElement).touchAction,
      gesturestart: cancelled('gesturestart'),
      gesturechange: cancelled('gesturechange')
    };
  });

  expect(refused.viewport).toContain('maximum-scale=1');
  expect(refused.viewport).toContain('user-scalable=no');
  expect(refused.touchAction).toBe('pan-x pan-y');
  expect(refused.gesturestart).toBe(true);
  expect(refused.gesturechange).toBe(true);
});

test('the strip at the top has room under the status bar at rest, and still pins to the top when scrolled', async ({ page }) => {
  const fake = await worker(page, signedIn());
  await page.goto('/');
  await expect.poll(() => storedOwner(page)).toBe(OWNER);
  // Up on every open that has a copy to draw, until the read lands.
  const release = fake.hold('/api/read');
  await page.reload();
  const strip = page.locator('#refresh');
  await expect(strip).toHaveText(/Last updated/);

  expect((await strip.boundingBox()).y).toBeGreaterThanOrEqual(8);

  await page.evaluate(() => {
    document.body.style.minHeight = '3000px';
    window.scrollTo(0, 400);
  });
  await expect.poll(async () => (await strip.boundingBox()).y).toBe(0);
  release();
});
