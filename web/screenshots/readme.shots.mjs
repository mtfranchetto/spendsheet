/**
 * The README's pictures of the phone app: each screen as it opens, drawn from
 * `book.mjs` by the built page in WebKit.
 *
 * Written as tests because the runner is what starts the build, the preview
 * and the browser; the one thing each asserts is that the screen has drawn
 * before it is photographed. What they show is WebKit at a phone's size, not
 * an iPhone — the same caveat the suite carries.
 *
 * `SHOTS_OUT` sends them somewhere else, for looking before replacing.
 */

import { test, expect } from '@playwright/test';
import { signedIn, worker } from '../e2e/worker.mjs';
import { picturedBatch } from './book.mjs';

const OUT = process.env.SHOTS_OUT || 'docs/assets/screenshots';

/** [file, address, what is on screen once the book has been drawn] */
const SHOTS = [
  ['home', '/', '.big'],
  ['records', '/?v=records', '.rec-sub'],
  // Last month, because it is whole: on the 2nd, this month is one bar.
  ['charts', '/?v=analytics&p=last_month', '.catrow'],
  ['long-view', '/?v=analytics&m=long', '.catrow']
];

for (const [name, address, drawn] of SHOTS) {
  test(name, async ({ page }) => {
    await worker(page, { ...signedIn(), '/api/read': [200, picturedBatch()] });
    await page.goto(address);
    await expect(page.locator(drawn).first()).toBeVisible();
    await page.screenshot({ path: `${OUT}/${name}.png` });
  });
}
