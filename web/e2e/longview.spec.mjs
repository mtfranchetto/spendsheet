/**
 * Charts' Long view, in WebKit, on the built page.
 *
 * What these can prove: the switch is the way in and the address agrees with
 * it in both directions; every section draws its figure from a book with
 * three years in it; a book with no history says so instead of drawing a year
 * out of forty days; and nothing on the screen is wider than the phone. What
 * they cannot: how the phone itself lays the screen out. WebKit here is not
 * iOS Safari, and that is a check on the device.
 *
 * Every figure asserted is one `worker.mjs` argues is the same on any day the
 * suite runs — which is why the monthly charts are held by what they draw
 * rather than by a value: the preview's own rows move between months as the
 * days pass.
 */

import { test, expect } from '@playwright/test';
import { bookToday, longBatch, signedIn, worker } from './worker.mjs';

const withHistory = () => ({ ...signedIn(), '/api/read': [200, longBatch()] });

const CARD_AFTER = 'xpath=following-sibling::div[contains(@class,"card")]';

/** The first card under a heading. */
const section = (page, heading) => page.locator('h2', { hasText: heading }).locator(CARD_AFTER).first();
const stat = (page, label) => page.locator('.stat', { has: page.locator('.label', { hasText: label }) });

test('the switch is the way in, and the address says which mode in both directions', async ({ page }) => {
  await worker(page, withHistory());
  await page.goto('/?v=analytics');
  const period = page.getByRole('button', { name: 'Period', exact: true });
  const long = page.getByRole('button', { name: 'Long view', exact: true });

  await expect(period).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.stepper .when')).toBeVisible();

  await long.click();
  await expect(page).toHaveURL(/\?v=analytics&m=long$/);
  await expect(long).toHaveAttribute('aria-pressed', 'true');
  // No picker: the long view's windows are not chosen.
  await expect(page.locator('.stepper .when')).toHaveCount(0);
  await expect(page.getByText('compared with the 12 months before')).toBeVisible();

  await period.click();
  await expect(page).toHaveURL(/\?v=analytics$/);
  await expect(page.locator('.stepper .when')).toBeVisible();

  // Still three tabs: the long view is a mode of Charts, not a place.
  await expect(page.locator('#tabs button')).toHaveCount(3);
});

test('an address naming the long view opens it, and reloading keeps it', async ({ page }) => {
  await worker(page, withHistory());
  await page.goto('/?v=analytics&m=long');
  await expect(page.getByRole('button', { name: 'Long view', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(stat(page, 'Annual spending')).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\?v=analytics&m=long$/);
  await expect(stat(page, 'Annual spending')).toBeVisible();
});

test('the four cards answer over the last 12 months', async ({ page }) => {
  await worker(page, withHistory());
  await page.goto('/?v=analytics&m=long');

  // Eleven rents and the preview's own spending; a twelfth of it a month.
  await expect(stat(page, 'Annual spending')).toContainText('€12,952.68');
  await expect(stat(page, 'Annual spending')).toContainText('€1,079.39 a month');
  await expect(stat(page, 'Savings rate')).toContainText('33%');
  await expect(stat(page, 'Savings rate')).toContainText('€6,371.40 kept of €19,324.08 earned');
  // The two banks and the wallet, over a month's spending. Degiro is not spendable.
  await expect(stat(page, 'Runway')).toContainText('9.9 months');
  await expect(stat(page, 'Runway')).toContainText('€10,732.89 in bank and cash');
  await expect(stat(page, 'Net worth change')).toContainText('+€7,071.40');
  await expect(stat(page, 'Net worth change')).toContainText('€35,161.49 → €42,232.89');
});

test('every section draws its figure from three years of history', async ({ page }) => {
  await worker(page, withHistory());
  await page.goto('/?v=analytics&m=long');

  const rolling = section(page, 'Income and spending, rolling 12 months');
  await expect(rolling.locator('polyline.line.in')).toHaveCount(1);
  await expect(rolling.locator('polyline.line.out')).toHaveCount(1);
  await expect(rolling.locator('.legend')).toContainText('Income');
  await expect(rolling.locator('.legend')).toContainText('Spending');
  await expect(rolling).toContainText('Income +7.4%, spending +7.9% on the 12 months before');
  await expect(rolling).toContainText('€6,371.40 now, €6,000.00 a year earlier');

  // The year before last is finished and holds nothing but twelve rents.
  const years = section(page, 'Year by year');
  const finished = years.locator('.item', { hasText: String(bookToday().year - 2) });
  await expect(finished).toContainText('€12,000.00 full year');
  await expect(finished.locator('.bar-fill.rest')).toHaveCount(1);
  await expect(years.locator('.item', { hasText: String(bookToday().year) })).toContainText('year in progress');

  const typical = section(page, 'A typical year, month by month');
  await expect(typical.locator('rect.barmark.flat')).toHaveCount(12);
  await expect(typical.locator('.xlabels span')).toHaveCount(12);

  const worth = page.locator('h2', { hasText: 'Net worth' }).locator(CARD_AFTER);
  await expect(worth.nth(0).locator('polyline.line')).toHaveCount(1);
  await expect(worth.nth(0)).toContainText('€42,233');
  const sources = worth.nth(1);
  await expect(sources.locator('.item', { hasText: 'Saved from income' })).toContainText('+€6,371.40');
  await expect(sources.locator('.item', { hasText: 'Assets revalued' })).toContainText('+€700.00');
  // The two explain the change, so there is no third row.
  await expect(sources.locator('.item')).toHaveCount(2);
  const held = worth.nth(2).locator('.item', { hasText: 'Investments and assets' });
  await expect(held).toContainText('€31,500.00');
  await expect(held).toContainText('75% of net worth');
  await expect(held).toContainText('+€700.00 in 12 months');
  const pace = worth.nth(3);
  await expect(pace).toContainText('with no market growth assumed');
  await expect(pace.locator('.row', { hasText: 'In 5 years' })).toContainText('€74,089.89');

  const went = section(page, 'Where it went');
  const housing = went.locator('.catrow', { hasText: 'Housing' });
  await expect(housing).toContainText('€12,228.20');
  await expect(housing).toContainText('94% of spending');
  await expect(housing).toContainText('€1,019.02 a month');

  const movers = section(page, 'Biggest changes');
  await expect(movers.locator('.item', { hasText: 'Housing' })).toContainText('+€228.20');
  await expect(movers.locator('.bar-fill.more')).toHaveCount(7);
  await expect(movers.locator('.mid')).toHaveCount(7);

  const rates = section(page, 'Savings rate by month');
  await expect(rates).toContainText('33% across the year.');
  await expect(rates.locator('rect.barmark')).toHaveCount(12);
});

test('the spending card and a category open Records on the same 12 months', async ({ page }) => {
  await worker(page, withHistory());
  await page.goto('/?v=analytics&m=long');

  await stat(page, 'Annual spending').click();
  await expect(page.locator('h1')).toHaveText('Records');
  await expect(page).toHaveURL(/v=records&p=custom&from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/);
  await expect(page.locator('.filters .chip.on')).toHaveText(/Money out/);
  // To today, from the day after this date a year ago: both ends are in the period's sheet.
  const today = bookToday();
  await page.locator('.stepper .when').click();
  await expect(page.getByLabel('Custom to')).toHaveValue(
    today.year + '-' + String(today.month).padStart(2, '0') + '-' + String(today.date).padStart(2, '0'));
  await expect(page.getByLabel('Custom from')).toHaveValue(new RegExp('^' + (today.year - 1) + '-'));
  await page.getByRole('button', { name: 'Done' }).click();

  await page.locator('#tabs button', { hasText: 'Charts' }).click();
  await expect(page).toHaveURL(/\?v=analytics&m=long$/);
  await section(page, 'Where it went').locator('.catrow', { hasText: 'Housing' }).click();
  await page.getByRole('button', { name: 'All Housing transactions →' }).click();
  await expect(page).toHaveURL(/v=records&p=custom&from=/);
  await expect(page.locator('.filters .chip.on')).toHaveCount(2);
});

test('a book with no history says how little it holds instead of drawing a year', async ({ page }) => {
  await worker(page, signedIn());
  await page.goto('/?v=analytics&m=long');

  await expect(page.getByText(/the ledger holds (no complete month yet|1 complete month)/).first()).toBeVisible();
  await expect(page.getByText('compared with the 12 months before')).toHaveCount(0);
  // The sum is the sum; what it is not called is annual, and it is not divided by twelve.
  await expect(stat(page, 'Spending so far')).toContainText('€1,952.68');
  await expect(stat(page, 'Annual spending')).toHaveCount(0);
  await expect(page.getByText(/€[\d,.]+ a month/)).toHaveCount(0);
  await expect(stat(page, 'Runway')).toContainText('—');
  await expect(stat(page, 'Savings rate')).toContainText('31%');

  await expect(section(page, 'Income and spending, rolling 12 months')).toContainText('needs 13 complete months');
  await expect(section(page, 'Year by year')).toContainText('does not cover a year from January yet');
  await expect(section(page, 'Biggest changes')).toContainText('needs 24 complete months');
  await expect(page.getByText('A pace needs 12 complete months')).toBeVisible();
  await expect(section(page, 'Where it went').locator('.catrow', { hasText: 'Housing' })).toContainText('€1,228.20');
});

test('nothing on the long view is wider than the phone', async ({ page }) => {
  await worker(page, withHistory());
  await page.goto('/?v=analytics&m=long');
  await expect(stat(page, 'Annual spending')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
