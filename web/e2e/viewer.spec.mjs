/**
 * The viewer's page, in WebKit, against a Worker answered by `page.route`.
 *
 * What only a browser can see here is a resource read that throws. Solid
 * rethrows a failed resource wherever it is read — including as another
 * resource's source — and nothing above the page catches it, so the symptom is
 * a screen frozen on "Checking…" with every unit test green.
 */

import { test, expect } from '@playwright/test';

const OWNER = '104729384756102938475';

/** Answer every Worker path; anything not named is a 500, like a Worker that is down. */
async function worker(page, answers = {}) {
  await page.route((url) => /^\/(api|auth)\//.test(url.pathname), (route) => {
    const path = new URL(route.request().url()).pathname;
    const [status, body] = answers[path] ?? [500, { error: 'down' }];
    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

test('an unreachable server says so, and does not claim you are signed out', async ({ page }) => {
  await worker(page);
  await page.goto('/');
  await expect(page.getByText('Could not reach the server')).toBeVisible();
  await expect(page.getByText('Not signed in.')).toHaveCount(0);
});

test('a refused sign-in shows the add command for the account the Worker sealed', async ({ page }) => {
  await worker(page, {
    '/api/me': [401, { error: 'Not available.' }],
    '/auth/refused': [200, { sub: OWNER, email: 'friend@example.com' }]
  });
  await page.goto('/?signin=refused');
  await expect(page.locator('strong', { hasText: 'friend@example.com' })).toBeVisible();
  await expect(page.locator('pre')).toHaveText(`npm run accounts -- add ${OWNER} friend@example.com`);
});

test('a crafted refusal link draws no command', async ({ page }) => {
  // No sealed cookie behind it, so the Worker has nobody to name.
  await worker(page, { '/api/me': [401, { error: 'Not available.' }], '/auth/refused': [404, { error: 'Not available.' }] });
  await page.goto(`/?signin=refused&account=${OWNER}`);
  await expect(page.getByText("is not on this viewer's list")).toBeVisible();
  await expect(page.locator('pre')).toHaveCount(0);
});

test('a session that ends mid-page stops saying who is signed in', async ({ page }) => {
  let meCalls = 0;
  await page.route((url) => /^\/(api|auth)\//.test(url.pathname), (route) => {
    const path = new URL(route.request().url()).pathname;
    const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/me') return meCalls++ === 0 ? reply(200, { email: 'owner@example.com', sub: OWNER }) : reply(401, {});
    if (path === '/api/book') return reply(401, { error: 'Not available.' });
    return reply(200, { ok: true, build: 'test', configured: {} });
  });
  await page.goto('/');
  await expect(page.getByText('Not signed in.')).toBeVisible();
  await expect(page.getByText('Signed in as')).toHaveCount(0);
});
