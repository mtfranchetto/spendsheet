/**
 * app.spec.mjs — the app, running, in the engine it was written for.
 *
 * Every other test in this project proves something about the page's *text*:
 * that no string is assigned as markup, that every name it calls exists on the
 * server, that the assembled document parses. None of them run a line of it.
 * The failure that gets past all of them is a page that parses and throws while
 * booting, which reaches the one person allowed to open the app as a blank
 * screen with a 200 behind it — twice now, historically.
 *
 * So the assertion under most of what follows is the dull one: *it drew, and
 * nothing threw*. `errors` is an auto-fixture rather than something each test
 * remembers to set up, because a test that forgets it still passes, and a suite
 * where forgetting is silent is one that erodes.
 *
 * ## What this can prove
 *
 * That the page boots, that every screen draws, that a tap reaches the entry
 * point it claims to, that a write invalidates what it should, that a late
 * answer does not overwrite a newer one, and that nothing overflows sideways.
 * Also two rules from CLAUDE.md that until now were enforced by prose alone:
 * that a `preserveAspectRatio="none"` plot carries no `<text>` of its own, and
 * that the scale beside it says what its height is worth.
 *
 * ## What it cannot
 *
 * **This is WebKit, not iOS Safari.** The distinction cost a release once: an
 * `input[type="date"]` sizes to its own content on the phone while honouring
 * `width` in every browser this project is developed in, and the second of two
 * side by side went off the right edge. WebKit is the same engine family and is
 * the closest an automated run gets, and it is still not the device. A rule
 * about a natively-rendered control is *applied* here and is proven only on the
 * phone — say which one you did.
 *
 * **There is no server behind this.** `google.script.run` is the fake in
 * `tests/page.mjs`, answering from a table built by calling the real `21`–`23`
 * against the book in `tests/book.mjs`. Nothing here measures anything: every
 * timing in CLAUDE.md was taken against the live deployment, and a millisecond
 * from this suite is a millisecond of `setTimeout`.
 */

import { test as base, expect } from '@playwright/test';

/**
 * The page, with somewhere for its failures to go.
 *
 * Two channels, because they catch different things. `pageerror` is an uncaught
 * exception — the blank-screen case. `console` at `error` level is what the
 * page's own `fail()` path and the browser's resource loader report, and it is
 * the one that catches a screen which drew an apology instead of content.
 */
const test = base.extend({
  errors: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push('uncaught: ' + error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push('console: ' + message.text());
    });
    await use(errors);
  }
});

/** The three tab-bar screens, by the label the tab shows. */
const HOME = '🏠Home';
const CHARTS = '📊Charts';
const RECORDS = '📄Records';

const tab = (page, label) => page.locator('#tabs button', { hasText: label.slice(2) });

/**
 * Open the app and wait for the whole first screen, not just the fast half.
 *
 * The dashboard is two calls drawn as they land — the top comes from the boot
 * payload templated into the document and the rest waits on `appOverview` — so
 * a test that acted as soon as net worth appeared would be racing the half it
 * came to look at. The spend line is in the second half.
 */
async function open(page, query = '') {
  await page.goto('/' + query);
  await expect(page.locator('#screens')).toContainText('Net worth');
  await expect(page.locator('#screens .tiles')).toBeVisible();
}

/** Every name the page has asked the server for, in order. */
const calls = (page) => page.evaluate(() => window.__calls.map((c) => c.name));

/** The same names, once the answer has been handed to the page and applied. */
const answered = (page) => page.evaluate(() => window.__answered);

test.describe('opening the app', () => {
  test('boots, draws the first screen, and throws nothing', async ({ page, errors }) => {
    await open(page);

    // The figure rather than the label: the label is in the markup either way,
    // and a boot that died after painting the shell would still show it.
    await expect(page.locator('#screens .big.num').first()).toHaveText(/€/);
    await expect(page.locator('#screens .tile')).not.toHaveCount(0);
    await expect(tab(page, HOME)).toHaveAttribute('aria-current', 'page');

    expect(errors).toEqual([]);
  });

  test('survives a document served with no boot payload', async ({ page, errors }) => {
    // What a browser gets when `appInlineBoot_` threw: the two scriptlets come
    // back `null` and the page has to fetch what it was going to be handed.
    // `readView` is written to fall back to the first tab, and this is the only
    // place that claim is tested against a parser rather than against a comment.
    await open(page, '?answers=cold');

    await expect(tab(page, HOME)).toHaveAttribute('aria-current', 'page');
    expect(errors).toEqual([]);
  });

  test('says so when the server has no answer, rather than sitting on a spinner', async ({ page }) => {
    // A missing or renamed entry point presents through `withFailureHandler`,
    // and the thing that must not happen is the screen keeping its spinner: an
    // app that looks like it is still loading is one nobody reports.
    await page.goto('/?answers=broken');

    await expect(page.locator('#screens')).toContainText('Net worth');
    await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

    // And it has to be specific about *which* half failed, because the other
    // half is on the screen above it and is correct. A blanket "something went
    // wrong" over a page showing live balances is the worse of the two lies.
    await expect(page.locator('#screens')).toContainText('appOverview');
    await expect(page.locator('#screens')).toContainText(/Net worth and balances above are current/i);
  });
});

test.describe('the three screens', () => {
  for (const [label, expected] of [[HOME, 'Net worth'], [CHARTS, 'Cashflow'], [RECORDS, 'Search']]) {
    test(`${label.slice(2)} draws`, async ({ page, errors }) => {
      await open(page);
      await tab(page, label).click();

      await expect(tab(page, label)).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('#screens')).toContainText(expected);
      await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

      expect(errors).toEqual([]);
    });
  }

  test('nothing overflows sideways on any of them', async ({ page }) => {
    // The symptom the date-input bug actually arrived as: the document is wider
    // than the phone, the view slides, and the white behind it is Apps Script's
    // own wrapper page, which the iframed document cannot paint. Whatever the
    // cause, it is visible here as one number exceeding another.
    await open(page);

    for (const label of [HOME, CHARTS, RECORDS]) {
      await tab(page, label).click();
      await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

      const widths = await page.evaluate(() => ({
        content: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth
      }));
      expect(widths.content, `${label} is wider than the phone`)
        .toBeLessThanOrEqual(widths.viewport);
    }
  });
});

/*
  The category breakdown, on both screens that draw it.

  It is one function — `categoryBars` — so Home and Charts cannot disagree, and
  the test runs against Home because that is the copy you meet first.

  Worth a browser rather than a file test for the reason the caret exists: the
  glyph is drawn by the page and turned by a stylesheet keyed on
  `aria-expanded`, and nothing outside a browser resolves that pairing. A rule
  that stopped matching would leave a caret that never moves — an indicator
  pointing the same way whatever the row is doing, which is worse than none.
*/
test.describe('the category rows', () => {
  test('say they open, and the caret turns when they do', async ({ page, errors }) => {
    await open(page);
    await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

    const rows = page.locator('#screens .catrow');
    const count = await rows.count();
    expect(count, 'no category rows to look at').toBeGreaterThan(1);

    // One on every row, because every row opens — including a category with no
    // subcategories, which opens onto its drill button alone. A caret on some
    // rows would make the same gesture mean two things depending on a fact you
    // cannot see before tapping.
    await expect(page.locator('#screens .catrow .caret')).toHaveCount(count);

    const turn = (i) => rows.nth(i).locator('.caret')
      .evaluate((node) => getComputedStyle(node).transform);
    const closed = await turn(0);

    await rows.first().click();
    await expect(rows.first()).toHaveAttribute('aria-expanded', 'true');

    // The one that opened turned; its neighbour did not. Asserting only the
    // first would pass just as well against a rule that turned every caret on
    // the screen at once.
    expect(await turn(0), 'the caret did not turn when the row opened').not.toBe(closed);
    expect(await turn(1), 'a row that did not open turned its caret').toBe(closed);

    // A child is a leaf — it drills rather than opening — so a caret on one
    // would promise something that never happens.
    await expect(page.locator('#screens .catkid')).not.toHaveCount(0);
    await expect(page.locator('#screens .catkid .caret')).toHaveCount(0);

    expect(errors).toEqual([]);
  });
});

test.describe('the charts', () => {
  test('draw something, and carry no glyph inside a stretched viewBox', async ({ page, errors }) => {
    await open(page);
    await tab(page, CHARTS).click();
    await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

    const drawn = await page.evaluate(() =>
      [...document.querySelectorAll('#screens svg[preserveAspectRatio="none"]')].map((svg) => ({
        // A polyline of one point is a chart of one day, which is what an empty
        // series and a broken one both look like.
        points: (svg.querySelector('polyline') || { getAttribute: () => '' })
          .getAttribute('points').trim().split(/\s+/).filter(Boolean).length,
        bars: svg.querySelectorAll('rect').length,
        // The rule this exists for: the viewBox is scaled by ~3.5 on x and ~3
        // on y, so a glyph inside it would be stretched by different amounts on
        // each axis. `vector-effect` rescues a stroke and nothing rescues text.
        texts: svg.querySelectorAll('text').length,
        // A `.plot` is a full chart and owes a scale; the rest are the
        // thumbnails on the stat tiles, which are a shape beside a number that
        // already says what it is worth.
        //
        // Measured as boxes and not just as text, because whether two labels
        // are readable is a question about where they landed. See below.
        ticks: svg.closest('.plot')
          ? [...svg.closest('.plot').querySelectorAll('.ytick')].map((t) => {
            const box = t.getBoundingClientRect();
            return { text: t.textContent, top: box.top, bottom: box.bottom, height: box.height };
          })
          : null
      })));

    expect(drawn.length, 'no scaled plot on Charts at all').toBeGreaterThan(0);
    expect(drawn.filter((d) => d.ticks), 'no full-size plot on Charts').not.toHaveLength(0);

    for (const plot of drawn) {
      expect(plot.texts, 'a stretched viewBox carries its own <text>').toBe(0);
      expect(plot.points + plot.bars, 'a plot with nothing drawn in it').toBeGreaterThan(1);

      if (plot.ticks) {
        // A plot with a truncated baseline and no scale reads as starting from
        // zero, which is the most misleading thing a chart here can do quietly.
        expect(plot.ticks.length, 'a plot with no scale').toBeGreaterThan(0);
        for (const tick of plot.ticks) expect(tick.text).toMatch(/\d/);

        // And two labels close enough to read as one block are not a tight
        // scale, they are no scale at all. It is what a chart with one huge end
        // and one small one does by default: a month earning €2,800 and
        // spending €308 put zero and the spending mark 15px apart with 11px
        // text between them, and `spacedMarks` is what drops the loser.
        //
        // Measured against the labels' own height rather than against a pixel
        // count, so it keeps meaning the same thing if the type size moves —
        // and so it does not simply restate `MARK_GAP_PIXELS` back at itself.
        // The first version asked only that the boxes not overlap, which the
        // broken layout satisfied with four pixels to spare: it passed with the
        // fix reverted, which is the one result that makes a test worthless.
        const sorted = [...plot.ticks].sort((a, b) => a.top - b.top);
        for (let i = 1; i < sorted.length; i++) {
          const clear = sorted[i].top - sorted[i - 1].bottom;
          const room = Math.max(sorted[i].height, sorted[i - 1].height) / 2;
          expect(clear, `"${sorted[i - 1].text}" and "${sorted[i].text}" are packed together`)
            .toBeGreaterThanOrEqual(room);
        }
      }
    }

    expect(errors).toEqual([]);
  });

  test('the trend on Home draws thirty days, with the scale that makes it readable', async ({ page, errors }) => {
    // It draws with the *lower* half of the dashboard, because a trend is every
    // row in the book and the top half deliberately reads none — so this can
    // only be looked for after the overview lands. A card that appeared with
    // the top half would be a card built from data nobody had fetched.
    await open(page);
    await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

    const card = page.locator('h2', { hasText: /Net worth, last \d+ days/ })
      .locator('xpath=following-sibling::div[1]');

    // Thirty days is thirty points. One point is what an empty series and a
    // series the page failed to read both look like.
    const points = await card.locator('polyline').getAttribute('points');
    expect(points.trim().split(/\s+/).filter(Boolean)).toHaveLength(30);

    // The same rule the Charts plots are held to, and it matters more here:
    // this one sits directly under the total, where a line climbing from the
    // floor of the card reads as a net worth that started from nothing.
    const ticks = await card.locator('.ytick').allTextContents();
    expect(ticks.length, 'the trend has no scale beside it').toBeGreaterThan(1);
    for (const tick of ticks) expect(tick).toMatch(/\d/);

    expect(errors).toEqual([]);
  });
});

test.describe('confirming a transaction', () => {
  test('sends the uid to appConfirm and re-reads the dashboard', async ({ page, errors }) => {
    await open(page);
    await tab(page, RECORDS).click();

    const pending = page.locator('#screens button[aria-label^="Needs review"]').first();
    await expect(pending).toBeVisible();
    const label = await pending.getAttribute('aria-label');

    await pending.click();
    await expect(page.locator('#sheet')).toBeVisible();
    await page.locator('#sheet button.primary', { hasText: 'Confirm' }).click();

    /*
      `appConfirm` takes an array of decisions, so the call's first argument is
      a list and the row is its first entry. Once each: the retry in
      `callOrRetry` is for a dropped transport and a second call here would mean
      the page had decided a refusal was worth repeating.

      The uid is on no part of the page — a row is drawn from its description —
      so there is nothing in the DOM to compare it against. That it was the
      *right* row is the assertion below rather than this one.
    */
    const [decisions, ...rest] = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appConfirm').map((c) => c.args[0]));

    expect(rest, 'appConfirm called more than once').toHaveLength(0);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ confirmed: true });
    expect(String(decisions[0].uid), 'a decision with no uid on it').not.toHaveLength(0);

    /*
      `reloadAfterWrite` is written up at length in `page.boot.html`: clearing
      `state.cache` alone was the bug, and it looked like it worked, because the
      cleared entry was never consulted. The claim it makes is that a write
      re-reads the dashboard, and this is what holds it to that.
    */
    await expect.poll(() => calls(page)).toContain('appDashboard');

    // And the row it was tapped on stops asking to be reviewed, without a
    // refetch — the optimistic patch, which is the other half of that comment.
    await expect(page.locator(`#screens button[aria-label="${label}"]`)).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  /**
   * The same claim on the other screen, where it used to be false.
   *
   * `dropConfirmed` removes from whichever list the row came from, and the
   * dashboard's is the one with no filter to consult — a queue drawn under
   * "Needs review" has no reading in which a ticked row belongs. It used to keep
   * it, until the refetch a second or two later replaced the block wholesale, so
   * one swipe's feedback was nothing, a pause, then the whole screen moving.
   *
   * **Read once, without retrying, and inside a window where the refetch cannot
   * have landed.** Both halves matter. `toHaveCount` polls until it is satisfied,
   * so it would go green on the refetch alone and pass against the behaviour this
   * is here to reject — and the refetch is only ~60ms away at the default
   * latency. Slowing the transport is what separates "the page removed the row"
   * from "the server said so eventually", which are the two explanations for an
   * identical screen.
   */
  test('a row confirmed on the dashboard leaves the queue at once', async ({ page, errors }) => {
    await open(page);

    const queue = page.locator('#screens h2:has-text("Needs review") + .card');
    const rows = queue.locator('button.tap');

    const before = await rows.count();
    expect(before, 'no backlog on the dashboard to confirm from').toBeGreaterThan(1);

    const first = rows.first();
    const label = await first.getAttribute('aria-label');
    expect(label).toMatch(/^Needs review/);

    await first.click();
    await expect(page.locator('#sheet')).toBeVisible();

    await page.evaluate(() => { window.__latency = 1500; });
    await page.locator('#sheet button.primary', { hasText: 'Confirm' }).click();

    // Synchronous: the listener mutates the record, drops it and renders before
    // the click resolves, so this reads the screen the thumb was on.
    expect(await rows.count(), 'the row is still in the queue, wearing its tick')
      .toBe(before - 1);
    await expect(queue.locator(`button[aria-label="${label}"]`)).toHaveCount(0);

    // And the refetch agrees rather than handing it back. Waited on by the
    // answer rather than the call, or every assertion below is taken on the
    // screen as it was before the reload — see `answered`. The fake applies the
    // write to its own table so there is something to agree with, which is the
    // note on `previewPage`.
    await expect.poll(() => answered(page), { timeout: 10000 }).toContain('appDashboard');
    await expect(rows).toHaveCount(before - 1);

    // The rest of the screen survives that refetch. `loadDashboard` distributes
    // one answer back into the two halves the boot fetched separately, and the
    // half it rebuilds used to be named field by field — so the trend was drawn
    // from the boot payload and then dropped by the first write, and confirming
    // a transaction took the chart off the screen until a reload.
    await expect(page.locator('#screens h2:has-text("Net worth, last")')).toBeVisible();
    await expect(page.locator('#screens .ytick').first()).toBeVisible();

    expect(errors).toEqual([]);
  });
});

test.describe('two requests in flight', () => {
  test('a late answer does not overwrite a newer one', async ({ page, errors }) => {
    /*
      `loadRecords` stamps each request and drops any answer that is not the
      newest — the guard exists, it is commented, and nothing has ever entered
      it. Reproducing the case needs a slow call overtaken by a fast one, which
      is what `window.__latency` is for: the shim reads it, and the answer, at
      *call* time, so these two calls differ in both.
    */
    await open(page);
    await tab(page, RECORDS).click();
    await expect(page.locator('#screens .chip', { hasText: 'Revolut' })).toBeVisible();

    const stamp = async (text, latency) => page.evaluate(([mark, wait]) => {
      window.__latency = wait;
      const answer = window.__answers.appRecords;
      answer.rows = [Object.assign({}, answer.rows[0], { description: mark, uid: mark })];
      answer.total = 1;
      answer.hasMore = false;
    }, [text, latency]);

    await stamp('STALE ANSWER', 1500);
    await page.locator('#screens .chip', { hasText: 'Revolut' }).click();

    await stamp('FRESH ANSWER', 50);
    await page.locator('#screens .chip', { hasText: 'Fineco' }).click();

    await expect(page.locator('#screens')).toContainText('FRESH ANSWER');

    // Past when the slow one has landed, or this asserts only that it had not
    // arrived yet — which is true of a page with no guard at all.
    await page.waitForTimeout(2000);
    await expect(page.locator('#screens')).toContainText('FRESH ANSWER');
    await expect(page.locator('#screens')).not.toContainText('STALE ANSWER');

    expect(errors).toEqual([]);
  });
});

test.describe('the gestures', () => {
  test('a swipe right across a row confirms it', async ({ page, errors }) => {
    /*
      The one interaction with no keyboard or mouse equivalent, and therefore
      the one a browser without `hasTouch` cannot reach at all: the listeners in
      `swipeToConfirm` are `touchstart`/`touchmove`/`touchend`, and nothing else
      on the page ever calls them.

      Synthesised rather than driven, because `page.touchscreen` taps and does
      not drag. Two things about doing that in the engine this suite runs in and
      the app is for: **`new Touch` is an illegal constructor in WebKit**, and
      **`TouchEvent` there refuses a plain array of points** — both want the
      older `document.createTouch`/`createTouchList` pair, which WebKit kept and
      which is the only shape it accepts. The standard constructors are here as
      the fallback rather than as the main path, for the day another engine
      joins; today they are the ones that do not work.
    */
    await open(page);
    await tab(page, RECORDS).click();

    const pending = page.locator('#screens button[aria-label^="Needs review"]').first();
    await expect(pending).toBeVisible();
    const box = await pending.boundingBox();

    const fired = await page.evaluate(([left, top, width]) => {
      const target = document.querySelector('#screens button[aria-label^="Needs review"]');
      const point = (x) => (document.createTouch
        ? document.createTouch(window, target, 1, x, top, x, top)
        : new Touch({ identifier: 1, target, clientX: x, clientY: top }));

      const list = (...points) => (document.createTouchList
        ? document.createTouchList(...points) : points);

      const touch = (type, x) => {
        const one = point(x);
        target.dispatchEvent(new TouchEvent(type, {
          bubbles: true, cancelable: true,
          touches: type === 'touchend' ? list() : list(one),
          targetTouches: type === 'touchend' ? list() : list(one),
          changedTouches: list(one)
        }));
      };

      // Past `swipeThreshold`, which is a quarter of the row's width clamped to
      // 60–96px, and in steps: the direction is decided once at `SWIPE_INTENT`
      // and a single jump from start to finish would decide it on a move the
      // gesture never made.
      const travel = Math.max(120, width * 0.6);
      touch('touchstart', left);
      for (let step = 1; step <= 8; step += 1) touch('touchmove', left + (travel * step) / 8);
      touch('touchend', left + travel);
      return travel;
    }, [
      // Clear of `EDGE_GUARD`: a drag begun at the very edge is the system's
      // back gesture, and the row deliberately ignores it.
      box.x + 40, box.y + box.height / 2, box.width
    ]);

    expect(fired).toBeGreaterThan(96);
    await expect.poll(() => calls(page)).toContain('appConfirm');
    expect(errors).toEqual([]);
  });
});
