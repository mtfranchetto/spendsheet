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
 * The dashboard is two calls drawn as they land — `appOpen` for the top and
 * `appOverview` for everything below it — so a test that acted as soon as net
 * worth appeared would be racing the half it came to look at. The spend line is
 * in the second half.
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

  test('survives a document served with no view payload', async ({ page, errors }) => {
    // What a browser gets when `webAppView_` could not be built: the scriptlet
    // comes back `null` and the page has to fall back to its own defaults.
    // `readView` is written to land on the first tab, and this is the only
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
  The account tiles: two rows deep, and the rest sideways.

  The number of accounts belongs to the user and it grows, so the thing worth
  holding is not a layout at four tiles but the *rule* — height is bounded and
  width is where the overflow goes. Nine is enough tiles to break it: on a
  wrapping grid that is five rows and the month disappears below the fold.

  **The extra tiles are cloned in the browser rather than added to the book.**
  What is being tested is the stylesheet at a tile count, and `book.mjs` is
  shared by every unit test that asserts a total — growing it to prove a CSS
  rule would move net worth in thirty other places. Clones are the same nodes
  the page built, laid out by the same rules, which is the whole of what this
  can see.

  The straddling tile is the affordance and not an accident of arithmetic: a
  column that starts inside the visible width and ends outside it is the sliver
  that says there is more to the right. Sized to exactly two columns it would
  vanish, the block would look complete, and the accounts past the second would
  be reachable only by a swipe nobody has a reason to try.
*/
test.describe('the account tiles', () => {
  test('stay two rows deep and put the rest sideways', async ({ page, errors }) => {
    await open(page);

    // The settled screen, not the first half of it. `renderDashboard` draws the
    // whole root again when the ledger call lands, which replaces the tiles —
    // so a measurement taken before that is of a block about to be rebuilt, and
    // the clones below would be measured on their way out of the document.
    await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

    const layout = await page.evaluate(() => {
      const box = document.querySelector('#screens .tiles');

      const original = Array.from(box.children);
      while (box.children.length < 9) {
        box.appendChild(original[box.children.length % original.length].cloneNode(true));
      }

      const boxLeft = box.getBoundingClientRect().left;
      const tiles = Array.from(box.children).map((tile) => {
        const rect = tile.getBoundingClientRect();
        return {
          top: Math.round(rect.top),
          left: Math.round(rect.left - boxLeft),
          right: Math.round(rect.right - boxLeft)
        };
      });

      return {
        tiles: tiles.length,
        rows: new Set(tiles.map((t) => t.top)).size,
        visible: box.clientWidth,
        scrollable: box.scrollWidth,
        straddling: tiles.filter((t) => t.left < box.clientWidth && t.right > box.clientWidth).length,
        page: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth
      };
    });

    expect(layout.tiles).toBe(9);
    expect(layout.rows, 'nine account tiles should occupy two rows').toBe(2);
    expect(layout.scrollable, 'the tiles should have somewhere to scroll to')
      .toBeGreaterThan(layout.visible);
    expect(layout.straddling, 'a tile should be cut by the right edge, so there is visibly more')
      .toBeGreaterThan(0);

    // And the overflow stays inside the block: the document must not have grown
    // sideways with it, which is the white-edges failure `html { overflow-x }`
    // is for and the one a horizontal scroller is most likely to reintroduce.
    expect(layout.page).toBeLessThanOrEqual(layout.viewport);

    expect(errors).toEqual([]);
  });

  /*
    The secondary action is one line, starts where the tile's own text starts,
    and stays inside the tile.

    **One line**, because every tile in a grid row is as tall as the tallest: a
    label that wraps makes its whole row of tiles a line taller, which is the
    height this block exists to save. "+ Add transaction" and "↕ Update
    balance" both wrapped at this width and added 23px to every tile beside
    them.

    **Left-aligned**, because a button centres its label and every
    `button.link` on the page is text you read from the left. Measured against
    the amount rather than the tile's padding box, because the padding is what
    the assertion would otherwise be restating; the amount is the thing on
    screen the eye compares the button to.

    **Inside the tile**, because the one-line half is `white-space: nowrap`,
    and a nowrap label that outgrows its column does not wrap — it runs out
    over the border and into the next tile. The bottom edge is checked for the
    same reason: the button's lower padding is pulled into the tile's own with
    a negative margin, and a margin larger than that padding would put the hit
    box outside the thing it is drawn in.

    320px is the narrowest the tiles have to work at, so it is the width where
    all three can fail.
  */
  test('keep the action inside a tile to one left-aligned line', async ({ page, errors }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await open(page);
    await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

    const actions = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('#screens .tiles .tile'))
        .filter((tile) => tile.querySelector('button.link'))
        .map((tile) => {
          const button = tile.querySelector('button.link');

          // The rendered text, not the button's box: a left-aligned box holding
          // centred lines has the left edge this is looking for and puts the
          // glyphs somewhere else entirely.
          const text = document.createRange();
          text.selectNodeContents(button);

          // The tile's content box: its border box less the padding, since a
          // label that reaches the padding is already over the visible edge
          // of the text column.
          const box = tile.getBoundingClientRect();
          const style = getComputedStyle(tile);
          const glyphs = text.getBoundingClientRect();
          const hit = button.getBoundingClientRect();

          return {
            label: button.textContent,
            lines: text.getClientRects().length,
            textLeft: glyphs.left,
            textRight: glyphs.right,
            contentRight: box.right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth),
            hitBottom: hit.bottom,
            tileBottom: box.bottom - parseFloat(style.borderBottomWidth),
            amountLeft: tile.querySelector('.amount').getBoundingClientRect().left
          };
        });
    });

    expect(actions.length, 'no tile carries a secondary action').toBeGreaterThan(0);

    for (const action of actions) {
      expect(action.lines, `"${action.label}" wraps at 320px, so its row of tiles grows a line`)
        .toBe(1);
      expect(action.textLeft, `"${action.label}" does not start where the balance does`)
        .toBeCloseTo(action.amountLeft, 0);
      expect(action.textRight, `"${action.label}" runs past the edge of its tile`)
        .toBeLessThanOrEqual(action.contentRight + 0.5);
      expect(action.hitBottom, `"${action.label}"'s tap target hangs below its tile`)
        .toBeLessThanOrEqual(action.tileBottom + 0.5);
    }

    expect(errors).toEqual([]);
  });

  test('mark a bank with what it is, and a dot only when it needs one', async ({ page, errors }) => {
    // 🟢 on every healthy tile was an alert glyph repeated down the screen
    // saying nothing, and it trains the eye to skip the dots — including the
    // one that is not green. A kind is not a state: 🏦, 💵 and 📈 say what the
    // account is, so the coloured dot is still the only one on the row.
    await open(page);
    await expect(page.locator('#screens .spinner')).toHaveCount(0, { timeout: 10000 });

    const marks = await page.evaluate(() => {
      const of = (name) => Array.from(document.querySelectorAll('#screens .tile'))
        .find((tile) => tile.textContent.includes(name));
      return ['Revolut', 'Fineco', 'Wallet', 'Degiro']
        .map((name) => [name, of(name).querySelector('.who span').textContent]);
    });

    expect(Object.fromEntries(marks)).toEqual({
      Revolut: '\u{1F3E6}', Fineco: '\u{1F7E0}',
      Wallet: '\u{1F4B5}', Degiro: '\u{1F4C8}'
    });
    expect(await page.locator('#screens .tiles').textContent()).not.toContain('\u{1F7E2}');
    expect(errors).toEqual([]);
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

  /**
   * The one above proves the refetch agrees. This proves it agrees about a row
   * it could not have known about — which is the case working through a backlog
   * puts you in every time.
   *
   * Every write ends in a dashboard reload, and a reload is one execution
   * reading the ledger. Confirm a second row while the first row's reload is in
   * the air and that execution answers honestly with a queue that still holds
   * the second row: the write had not landed when it looked. The answer replaces
   * `state.data.overview` whole, so a row you have already swiped comes back
   * under a heading that says it needs reviewing — and swiping it again is how a
   * queue of multi-second executions builds up behind a bridge that eventually
   * drops one.
   *
   * The arrangement is the `__latency` trick the ordering test uses, in three
   * steps. The first confirmation is slow enough to leave a window; the reload
   * it fires inherits that latency at *call* time, so the window is still open
   * when the second row is confirmed inside it; and the second confirmation is
   * put far out of the way, so nothing can correct the screen before the
   * assertion. What is read at the end is the reload's own answer, once, without
   * polling — `toHaveCount` would wait for the second reload and go green on the
   * behaviour this rejects.
   */
  test('a row confirmed during a reload is not handed back by it', async ({ page, errors }) => {
    await open(page);

    const queue = page.locator('#screens h2:has-text("Needs review") + .card');
    const rows = queue.locator('button.tap');

    const before = await rows.count();
    expect(before, 'fewer than two rows in the backlog to confirm').toBeGreaterThan(1);

    const labels = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')));

    const confirm = async (label) => {
      await queue.locator(`button[aria-label="${label}"]`).click();
      await expect(page.locator('#sheet')).toBeVisible();
      await page.locator('#sheet button.primary', { hasText: 'Confirm' }).click();
    };

    await page.evaluate(() => { window.__latency = 2500; });
    await confirm(labels[0]);

    // The reload is *issued* here, carrying a 2500ms answer with it. `calls`
    // rather than `answered` on purpose: the window this test needs is between
    // the request leaving and its answer arriving.
    await expect.poll(() => calls(page), { timeout: 15000 }).toContain('appDashboard');

    await page.evaluate(() => { window.__latency = 8000; });
    await confirm(labels[1]);
    expect(await queue.locator(`button[aria-label="${labels[1]}"]`).count(),
      'the second row did not leave the queue when it was confirmed').toBe(0);

    await expect.poll(() => answered(page), { timeout: 15000 }).toContain('appDashboard');

    expect(await queue.locator(`button[aria-label="${labels[1]}"]`).count(),
      'the reload put a row back that had already been confirmed').toBe(0);
    expect(await queue.locator(`button[aria-label="${labels[0]}"]`).count(),
      'the reload put the first row back too').toBe(0);

    expect(errors).toEqual([]);
  });

  /**
   * A run of swipes is one call, not one call each.
   *
   * `appConfirm` takes a list and says why in its own comment — a request per
   * tap queues multi-second executions behind each other on Apps Script, and the
   * bridge in front of them gives up on one with an error about the transport
   * that says nothing about the cause. The gesture that sends them is one row at
   * a time, so the batching only happens if the page holds what is swiped while
   * a call is out.
   *
   * Both halves are asserted, because either alone passes against something
   * broken: that three rows left the screen, and that they did it in fewer than
   * three calls.
   */
  test('swipes made while a confirmation is in flight travel together', async ({ page, errors }) => {
    await open(page);

    const queue = page.locator('#screens h2:has-text("Needs review") + .card');
    const rows = queue.locator('button.tap');

    const before = await rows.count();
    expect(before, 'fewer than three rows in the backlog').toBeGreaterThan(2);

    const labels = await rows.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('aria-label')));

    // Slow enough that all three are made before the first call is answered,
    // which is the ordinary case on a platform with a ~2.7s round-trip floor.
    await page.evaluate(() => { window.__latency = 5000; });

    for (const label of labels.slice(0, 3)) {
      await queue.locator(`button[aria-label="${label}"]`).click();
      await expect(page.locator('#sheet')).toBeVisible();
      await page.locator('#sheet button.primary', { hasText: 'Confirm' }).click();
    }

    await expect(rows).toHaveCount(before - 3);

    // How many decisions each call carried. Polled rather than read once: the
    // rows leave the screen on the swipe and the calls behind them are still
    // going, so a single read here counts whatever had left by then and would
    // call a page that dropped two of them a batch of one.
    const sent = () => page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appConfirm').map((c) => c.args[0].length));

    await expect
      .poll(async () => (await sent()).reduce((total, count) => total + count, 0),
        { timeout: 20000 })
      .toBe(3);

    expect((await sent()).length, 'one call per swipe, which is what the batch is for')
      .toBeLessThan(3);

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

/*
  An amount field groups its digits as they are typed.

  Worth a browser for the two things only a browser has: `InputEvent.data`,
  which is how the field knows a `,` was a key press rather than a separator it
  drew itself, and the caret, which a reformat moves unless it is put back.
  The keyboard is `page.keyboard`, so every character arrives as the input
  event a phone would send — though a synthesised key is still not the iOS
  decimal pad, and that half is the phone's to prove.
*/
test.describe('typing an amount', () => {
  const openAdd = async (page) => {
    await open(page);
    await page.locator('#screens .tile button.link', { hasText: '+ Add' }).click();
    await expect(page.locator('#screens h1')).toHaveText('Add transaction');
    const field = page.locator('#screens input[inputmode="decimal"]');
    await field.click();
    return field;
  };

  test('groups the digits as they arrive', async ({ page, errors }) => {
    const field = await openAdd(page);
    await page.keyboard.type('1500000');
    await expect(field).toHaveValue('1,500,000');
    expect(errors).toEqual([]);
  });

  test('takes either key as the decimal point, and sends the number', async ({ page, errors }) => {
    const field = await openAdd(page);

    // A comma on a phone whose own decimal point is a dot: the key pressed is
    // what counts, so this is one thousand two hundred and thirty-four and a half.
    await page.keyboard.type('1234,5');
    await expect(field).toHaveValue('1,234.5');

    await page.locator('#screens button.primary', { hasText: 'Add' }).click();
    await expect.poll(() => calls(page)).toContain('appAddCash');

    const sent = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appAddCash').map((c) => c.args[0].amount));
    expect(sent).toEqual([1234.5]);
    expect(errors).toEqual([]);
  });

  test('sends which way the money went from the buttons, not from a sign', async ({ page, errors }) => {
    const field = await openAdd(page);
    // The parents the picker offers, read off its headings with an empty
    // search — opened, read and closed again so the form is left as it was.
    const offered = async () => {
      await page.locator('#screens .catpick-current').click();
      const names = await page.locator('#screens .catpick-group').evaluateAll(
        (groups) => groups.map((g) => g.textContent.replace(/^\S+\s/, '')));
      await page.locator('#screens .catpick-current').click();
      return names;
    };

    // Expense is the default and offers no Income category to file under.
    await expect(page.locator('#screens .seg[aria-pressed="true"]')).toHaveText('Expense');
    expect(await offered()).not.toContain('Income');

    await page.locator('#screens .seg', { hasText: 'Income' }).click();
    await expect(page.locator('#screens .seg[aria-pressed="true"]')).toHaveText('Income');
    expect(await offered()).toContain('Income');
    expect(await offered()).not.toContain('Food & Drink');

    // Redrawing the tabs leaves what was typed alone.
    await field.click();
    await page.keyboard.type('200');
    await page.locator('#screens .catpick-current').click();
    await page.locator('#screens .catpick input').fill('income');
    await page.locator('#screens .catpick-option', { hasText: 'Anything in Income' }).click();
    await page.locator('#screens button.primary', { hasText: 'Add' }).click();
    await expect.poll(() => calls(page)).toContain('appAddCash');

    const sent = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appAddCash').map((c) => c.args[0]));
    expect(sent).toMatchObject([{ amount: 200, direction: 'income', category: 'Income' }]);
    expect(errors).toEqual([]);
  });

  test('keeps the caret beside the digit just typed when a separator appears', async ({ page, errors }) => {
    const field = await openAdd(page);
    await page.keyboard.type('123456');
    await expect(field).toHaveValue('123,456');

    // Into the middle, after the `1`, in a place where one more digit makes a
    // new group: `1723,456` regroups to `1,723,456`, putting a separator ahead
    // of the caret. Inserting where the groups do not change reformats nothing
    // and would prove nothing — that is how the first version of this test
    // passed against a page that never put the caret back at all.
    //
    // The second digit is the assertion. A caret left at its old offset lands
    // before the `7`, and one that the browser sent to the end lands after the
    // `6`; only a restored one puts the `8` after the `7`.
    await field.evaluate((input) => input.setSelectionRange(1, 1));
    await page.keyboard.type('7');
    await expect(field).toHaveValue('1,723,456');
    await page.keyboard.type('8');
    await expect(field).toHaveValue('17,823,456');
    expect(errors).toEqual([]);
  });

  /*
    Backspace straight after a separator deletes the digit before it.

    The separator is the field's own, so removing it alone changes no digit and
    the reformat draws it straight back with the caret where it was — a key that
    does nothing however often it is pressed. Only reachable with the caret
    beside a separator, which backspacing from the end never is.
  */
  test('backspace beside a separator deletes a digit rather than nothing', async ({ page, errors }) => {
    const field = await openAdd(page);
    await page.keyboard.type('1234567');
    await expect(field).toHaveValue('1,234,567');

    await field.evaluate((input) => input.setSelectionRange(6, 6));
    await page.keyboard.press('Backspace');
    await expect(field).toHaveValue('123,567');

    // And the caret stayed beside the deletion, so a second press keeps going.
    await page.keyboard.press('Backspace');
    await expect(field).toHaveValue('12,567');
    expect(errors).toEqual([]);
  });

  /*
    A pre-filled amount is replaced by what you type, not added to.

    `renderSetValue` arrives holding the current balance and selects it on
    focus, so a new number replaces it. A selection made synchronously in
    `focus` is collapsed by the tap that caused it, the digits go on the end —
    and two-decimal grouping then drops every one of them, so the field looks
    as if it ignored the keyboard. `tap` rather than `click`, because a touch
    is the gesture whose caret placement does the collapsing.
  */
  test('replaces a pre-filled balance rather than appending to it', async ({ page, errors }) => {
    await open(page);
    await page.locator('#screens .tile button.link', { hasText: 'Update' }).click();
    await expect(page.locator('#screens h1')).toHaveText('Update balance');

    const field = page.locator('#screens input[inputmode="decimal"]');
    await expect(field).not.toHaveValue('');
    await field.tap();
    await page.waitForTimeout(50);
    await page.keyboard.type('33250');

    await expect(field).toHaveValue('33,250');
    await expect(page.locator('#screens .card')).toContainText('recorded as one transaction');
    expect(errors).toEqual([]);
  });

  /*
    A page left open overnight still offers today.

    `generatedAt` is the server's day at the moment `appOpen` answered, and it
    is not refreshed while the page sits in the background. Used alone as the
    picker's `max`, the morning after would refuse the day you spent the money.
    The phone's clock is moved two days past the answer the preview was built
    with, which is that morning.
  */
  test('offers today even when the server last answered on an earlier day', async ({ page, errors }) => {
    const later = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await page.clock.setFixedTime(later);

    await openAdd(page);
    const pad = (n) => (n < 10 ? '0' : '') + n;
    const phoneToday = later.getFullYear() + '-' + pad(later.getMonth() + 1) + '-' + pad(later.getDate());

    await expect(page.locator('#screens input[type="date"]')).toHaveAttribute('max', phoneToday);
    await expect(page.locator('#screens input[type="date"]')).toHaveValue(phoneToday);
    expect(errors).toEqual([]);
  });

  test('offers no date after today', async ({ page, errors }) => {
    await openAdd(page);
    const today = await page.evaluate(() => document.querySelector('#screens input[type="date"]').value);
    expect(today, 'the date field arrived empty').not.toBe('');
    await expect(page.locator('#screens input[type="date"]')).toHaveAttribute('max', today);
    expect(errors).toEqual([]);
  });

  test.describe('on a phone that writes a comma for the decimal point', () => {
    test.use({ locale: 'it-IT' });

    /*
      The case the whole design turns on. In it-IT the thousands separator is
      a dot, so a field that read every `.` as a decimal point would read its
      own grouping back as one — and deleting the last digit of `1.234` would
      leave `1,23`, a thousand turned into one euro twenty-three.
    */
    test('does not read its own grouping back as a decimal point', async ({ page, errors }) => {
      const field = await openAdd(page);

      await page.keyboard.type('1234,50');
      await expect(field).toHaveValue('1.234,50');

      for (const expected of ['1.234,5', '1.234,', '1.234', '123']) {
        await page.keyboard.press('Backspace');
        await expect(field).toHaveValue(expected);
      }
      expect(errors).toEqual([]);
    });
  });
});

test.describe('the tab bar', () => {
  /**
   * Order, which nothing has ever asserted and which has now been changed twice.
   *
   * It is kept in three places that have to agree — `SCREENS` and `NAV` in
   * `page.view.html`, and `WEBAPP_SCREENS` on the server — and the bar draws in
   * `SCREENS` order *filtered by* `NAV` membership, so moving one list and not
   * the other reorders nothing while looking done. A file test can compare the
   * two arrays; only this can say what the bar renders.
   */
  test('draws Home, Records, Charts, in that order', async ({ page, errors }) => {
    await open(page);

    await expect(page.locator('#tabs button')).toHaveText([HOME, RECORDS, CHARTS]);
    expect(errors).toEqual([]);
  });
});

test.describe('deleting a cash transaction', () => {
  /** Open the sheet on the one row in the fixture that carries a delete. */
  const openCash = async (page) => {
    await tab(page, RECORDS).click();
    await page.locator('#screens button.tap', { hasText: 'Caffè e cornetto' }).click();
    await expect(page.locator('#sheet')).toBeVisible();
  };

  test('offers no delete on a synced row', async ({ page, errors }) => {
    // `deletable` comes from the server and is false for everything the bank
    // sent, which is almost every row — so this is the ordinary case and the
    // one worth pinning.
    await open(page);
    await tab(page, RECORDS).click();
    await page.locator('#screens button.tap', { hasText: 'ESSELUNGA' }).first().click();

    await expect(page.locator('#sheet')).toBeVisible();
    await expect(page.locator('#sheet button.danger')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('takes two taps, and the first one sends nothing', async ({ page, errors }) => {
    /*
      The whole point of arming. A single-tap delete on a phone is one mis-tap
      from a row that no longer exists, and the first tap has to be provably
      inert rather than merely look it — `toHaveCount(0)` after a wait, because
      the call is asynchronous and asserting immediately would pass against a
      page that sent it 10ms later.
    */
    await open(page);
    await openCash(page);

    const button = page.locator('#sheet button.danger');
    await expect(button).toHaveText('Delete');

    await button.click();
    await expect(button).toHaveText('Tap again to delete');
    await page.waitForTimeout(300);
    expect(await calls(page)).not.toContain('appDeleteRecord');

    await button.click();
    await expect.poll(() => calls(page)).toContain('appDeleteRecord');
    expect(errors).toEqual([]);
  });

  test('stays armed rather than disarming itself', async ({ page, errors }) => {
    // No timer undoes the first tap. A control that changes what it does while
    // you are looking at it is worse than one that waits — the tap meant for
    // the armed button would land on a disarmed one and do nothing.
    await open(page);
    await openCash(page);

    await page.locator('#sheet button.danger').click();
    await page.waitForTimeout(5000);

    await expect(page.locator('#sheet button.danger')).toHaveText('Tap again to delete');
    expect(errors).toEqual([]);
  });

  test('sends the uid and takes the row off the screen', async ({ page, errors }) => {
    await open(page);
    await openCash(page);

    await page.locator('#sheet button.danger').click();
    await page.locator('#sheet button.danger').click();

    const [request, ...rest] = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appDeleteRecord').map((c) => c.args[0]));

    expect(rest, 'appDeleteRecord called more than once').toHaveLength(0);
    expect(String(request.uid)).toHaveLength(3);

    // Gone from the list without waiting on a refetch — `dropRecord` removes it
    // unconditionally, where `dropConfirmed` would have left it unless the list
    // happened to be filtered to unconfirmed.
    await expect(page.locator('#screens button.tap', { hasText: 'Caffè e cornetto' }))
      .toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('picking a category', () => {
  const openAdd = async (page) => {
    await open(page);
    await page.locator('#screens .tile button.link', { hasText: '+ Add' }).click();
    await expect(page.locator('#screens h1')).toHaveText('Add transaction');
    await page.locator('#screens input[inputmode="decimal"]').fill('12');
  };

  const search = async (page, text) => {
    await page.locator('#screens .catpick-current').click();
    await page.locator('#screens .catpick input').fill(text);
  };

  const options = (page) => page.locator('#screens .catpick-option');

  const sentCategory = async (page) => {
    await page.locator('#screens button.primary', { hasText: 'Add' }).click();
    await expect.poll(() => calls(page)).toContain('appAddCash');
    const [sent] = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appAddCash').map((c) => c.args[0]));
    return { category: sent.category, subcategory: sent.subcategory };
  };

  test('narrows as you type, and a child sends its parent with it', async ({ page, errors }) => {
    // The parent travelling with the child is load-bearing: a row already
    // carrying a `category_override` — every transfer does — would otherwise
    // go on winning over the child you picked.
    await openAdd(page);
    const everything = await (async () => {
      await page.locator('#screens .catpick-current').click();
      return options(page).count();
    })();

    await page.locator('#screens .catpick input').fill('bars');
    await expect(options(page)).toHaveCount(1);
    expect(everything).toBeGreaterThan(20);

    await options(page).first().click();
    await expect(page.locator('#screens .catpick-panel')).toBeHidden();
    await expect(page.locator('#screens .catpick-current')).toContainText('Bars & Cafes');
    expect(await sentCategory(page)).toEqual({ category: 'Food & Drink', subcategory: 'Bars & Cafes' });
    expect(errors).toEqual([]);
  });

  test('keeps the parent on its own reachable by searching its name', async ({ page, errors }) => {
    // "This is Shopping and I do not know what kind" is a real answer.
    await openAdd(page);
    await search(page, 'shopping');

    await page.locator('#screens .catpick-option', { hasText: 'Anything in Shopping' }).click();
    expect(await sentCategory(page)).toEqual({ category: 'Shopping', subcategory: '' });
    expect(errors).toEqual([]);
  });

  test('shows a child under its parent\'s heading even when only the child matched', async ({ page, errors }) => {
    await openAdd(page);
    await search(page, 'rent');

    await expect(page.locator('#screens .catpick-group')).toContainText(['Housing']);
    await expect(page.locator('#screens .catpick-option', { hasText: 'Anything in Housing' }))
      .toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('ignores case and accents', async ({ page, errors }) => {
    await openAdd(page);
    await search(page, 'BÄRS');

    await expect(options(page)).toHaveText([/Bars & Cafes/]);
    expect(errors).toEqual([]);
  });

  test('picks the first match on Return', async ({ page, errors }) => {
    await openAdd(page);
    await search(page, 'bars');
    await page.keyboard.press('Enter');

    expect(await sentCategory(page)).toEqual({ category: 'Food & Drink', subcategory: 'Bars & Cafes' });
    expect(errors).toEqual([]);
  });

  test('says so when nothing matches', async ({ page, errors }) => {
    await openAdd(page);
    await search(page, 'zzzz');

    await expect(options(page)).toHaveCount(0);
    await expect(page.locator('#screens .catpick-panel')).toContainText('No category matches');
    expect(errors).toEqual([]);
  });

  test('offers only the tab\'s own kind in the transaction sheet', async ({ page, errors }) => {
    // A salary should not be offered sixty expense categories, and the search
    // must not be a way round that.
    await open(page);
    await tab(page, RECORDS).click();
    await page.locator('#screens button.tap', { hasText: 'ESSELUNGA' }).first().click();
    await page.locator('#sheet .catpick-current').click();
    await page.locator('#sheet .catpick input').fill('salary');

    await expect(page.locator('#sheet .catpick-option')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('confirms a row with what was picked in the sheet', async ({ page, errors }) => {
    await open(page);
    await tab(page, RECORDS).click();
    await page.locator('#screens button.tap', { hasText: 'ESSELUNGA' }).first().click();
    await page.locator('#sheet .catpick-current').click();
    await page.locator('#sheet .catpick input').fill('bars');
    await page.locator('#sheet .catpick-option').first().click();
    await page.locator('#sheet button.primary').click();

    await expect.poll(() => calls(page)).toContain('appConfirm');
    const [decision] = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appConfirm').map((c) => c.args[0][0]));
    expect(decision).toMatchObject({ category_override: 'Food & Drink',
      subcategory_override: 'Bars & Cafes' });
    expect(errors).toEqual([]);
  });
});

test.describe('a merchant nothing has filed yet', () => {
  const openUnfiled = async (page) => {
    await open(page);
    await page.locator('#screens button.tap', { hasText: 'MERCATO CENTRALE' }).first().click();
  };

  test('opens on the suggestion, says where it came from, and confirms it in one tap',
    async ({ page, errors }) => {
      await openUnfiled(page);
      await expect(page.locator('#sheet .suggested')).toHaveText(
        'Suggested from \u201cmercato centrale roma\u201d.');
      await expect(page.locator('#sheet .catpick-current')).toContainText('Groceries');

      await page.locator('#sheet button.primary').click();
      await expect.poll(() => calls(page)).toContain('appConfirm');
      const [decision] = await page.evaluate(() =>
        window.__calls.filter((c) => c.name === 'appConfirm').map((c) => c.args[0][0]));
      expect(decision).toMatchObject({ category_override: 'Food & Drink',
        subcategory_override: 'Groceries' });
      expect(errors).toEqual([]);
    });

  test('offers nothing on a row the cascade already filed', async ({ page, errors }) => {
    await open(page);
    await page.locator('#screens button.tap', { hasText: 'ESSELUNGA' }).first().click();
    await expect(page.locator('#sheet .catpick-current')).toBeVisible();
    await expect(page.locator('#sheet .suggested')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('the time of day', () => {
  test('shows on a row that recorded one, and on its sheet', async ({ page, errors }) => {
    await open(page);
    await tab(page, RECORDS).click();
    const cash = page.locator('#screens button.tap', { hasText: 'Caff' }).first();
    await expect(cash.locator('.rec-sub')).toHaveText('08:05 \u00b7 Wallet');

    await cash.click();
    await expect(page.locator('#sheet p.muted').first()).toContainText('08:05');
    expect(errors).toEqual([]);
  });

  test('is absent on a row that knows only its day', async ({ page, errors }) => {
    await open(page);
    await tab(page, RECORDS).click();
    const bank = page.locator('#screens button.tap', { hasText: 'ESSELUNGA' }).first();
    await expect(bank.locator('.rec-sub')).toHaveText('Revolut');
    expect(errors).toEqual([]);
  });
});

test.describe('labels on a cash entry', () => {
  const openAdd = async (page) => {
    await open(page);
    await page.locator('#screens .tile button.link', { hasText: '+ Add' }).click();
    await expect(page.locator('#screens h1')).toHaveText('Add transaction');
  };

  const chip = (page, name) => page.locator('#screens .chip', { hasText: name });

  test('sends what is ticked, in the shape the column holds', async ({ page, errors }) => {
    await openAdd(page);
    await page.locator('#screens input[inputmode="decimal"]').fill('12');
    await chip(page, 'travel').click();

    await page.locator('#screens button.primary', { hasText: 'Add' }).click();
    await expect.poll(() => calls(page)).toContain('appAddCash');

    const [sent] = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appAddCash').map((c) => c.args[0]));
    expect(sent.labels).toEqual(['travel']);
    expect(errors).toEqual([]);
  });

  test('takes the chips away on a transfer, and sends none', async ({ page, errors }) => {
    // The rule the edit sheet's transfer pane already keeps, and the server
    // refuses the same write: a label is an axis over spending, and a transfer
    // is counted in neither direction.
    await openAdd(page);
    await page.locator('#screens input[inputmode="decimal"]').fill('12');
    await chip(page, 'travel').click();

    await page.locator('#screens .catpick-current').click();
    await page.locator('#screens .catpick input').fill('between');
    await page.locator('#screens .catpick-option', { hasText: 'Between accounts' }).click();
    await expect(chip(page, 'travel')).toBeHidden();

    await page.locator('#screens button.primary', { hasText: 'Add' }).click();
    await expect.poll(() => calls(page)).toContain('appAddCash');

    const [sent] = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appAddCash').map((c) => c.args[0]));
    expect(sent.labels).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('still hides them after the Expense/Income tabs redraw the category list', async ({ page, errors }) => {
    // Switching tabs replaces the category select, so a listener attached to
    // the first one is listening to a node that is gone.
    await openAdd(page);
    await page.locator('#screens .seg', { hasText: 'Income' }).click();
    await page.locator('#screens .seg', { hasText: 'Expense' }).click();

    await page.locator('#screens .catpick-current').click();
    await page.locator('#screens .catpick input').fill('between');
    await page.locator('#screens .catpick-option', { hasText: 'Between accounts' }).click();
    await expect(chip(page, 'travel')).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test.describe('editing the amount of a cash transaction', () => {
  const openCash = async (page) => {
    await tab(page, RECORDS).click();
    await page.locator('#screens button.tap', { hasText: 'Caffè e cornetto' }).click();
    await expect(page.locator('#sheet')).toBeVisible();
    return page.locator('#sheet input[inputmode="decimal"]');
  };

  const sentDecisions = (page) => page.evaluate(() =>
    window.__calls.filter((c) => c.name === 'appConfirm').map((c) => c.args[0][0]));

  test('offers no amount field on a row the bank sent', async ({ page, errors }) => {
    await open(page);
    await tab(page, RECORDS).click();
    await page.locator('#screens button.tap', { hasText: 'ESSELUNGA' }).first().click();

    await expect(page.locator('#sheet')).toBeVisible();
    await expect(page.locator('#sheet input[inputmode="decimal"]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('arrives holding the size, and sends the corrected one', async ({ page, errors }) => {
    // The row is −6.50 and the field says 6.50: the sign is not in the amount,
    // here as everywhere else in this project.
    await open(page);
    const field = await openCash(page);
    await expect(field).toHaveValue('6.50');

    await field.fill('');
    await page.keyboard.type('8.20');
    await page.locator('#sheet button.primary').click();

    await expect.poll(() => calls(page)).toContain('appConfirm');
    expect((await sentDecisions(page))[0].amount).toBe(8.2);
    expect(errors).toEqual([]);
  });

  test('sends no amount at all when the field was not touched', async ({ page, errors }) => {
    // Present-and-unchanged and absent are different requests: the writer
    // reports an amount it wrote, and a confirm that always sent one would
    // report a change on every tap.
    await open(page);
    await openCash(page);

    await page.locator('#sheet button.primary').click();
    await expect.poll(() => calls(page)).toContain('appConfirm');

    expect((await sentDecisions(page))[0]).not.toHaveProperty('amount');
    expect(errors).toEqual([]);
  });

  test('keeps the sheet open and says so rather than sending a blank', async ({ page, errors }) => {
    // The sheet closes on an optimistic redraw, so a refusal has to happen
    // before it does — otherwise the row goes back a round trip later with a
    // toast, which looks like a tap that did not land.
    await open(page);
    const field = await openCash(page);

    await field.fill('');
    await page.locator('#sheet button.primary').click();

    await expect(page.locator('#toast')).toContainText('Type an amount');
    await expect(page.locator('#sheet')).toBeVisible();
    await page.waitForTimeout(300);
    expect(await calls(page)).not.toContain('appConfirm');
    expect(errors).toEqual([]);
  });
});

/*
  What the phone already knows, and what it does with it.

  The app opens in ~6.5s and almost none of that is this project: ~2,400ms of
  Apps Script container spin-up for the document, then ~2,700ms of fixed
  overhead on every `google.script.run` call before a line of server code runs.
  There is no round trip left to remove, so the cache removes the *wait* — it
  draws the last answers straight away and refreshes behind them.

  The claims worth a browser are the ones no file test can reach: that something
  is on screen while the calls are still out, that it is replaced when they
  land, that a shape this code does not recognise is not drawn at all, and that
  a refusal from the gate takes the stored copy with it.
*/
test.describe('opening on what the phone already knows', () => {
  const KEY = 'spendsheet';

  const stored = (page) => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, KEY);

  const store = (page, held) => page.evaluate(([key, copy]) => {
    localStorage.setItem(key, JSON.stringify(copy));
  }, [KEY, held]);

  /**
   * Keep every call in flight for the length of an assertion.
   *
   * The shim assigns `window.__latency` as the document parses, which is before
   * any test code can run and before the boot has fired its two calls — so the
   * assignment the other tests here use, `page.evaluate` after load, is far too
   * late to slow a *boot*. A property that refuses to be written keeps its
   * value through the shim's own assignment, which is the only way to hold the
   * opening calls open and look at what is on screen without them.
   */
  const holdAnswers = (page) => page.addInitScript(() => {
    Object.defineProperty(window, '__latency', {
      get: () => 4000,
      set: () => {},
      configurable: true
    });
  });

  /**
   * One session's worth of answers on the phone, with a mark in them.
   *
   * The mark is an account *name* rather than a number: `money()` formats
   * through `Intl` in the browser's own locale, so asserting on a total would
   * be asserting on which side the euro sign lands. A name is drawn as it is
   * given, and one nothing on the server would produce says exactly where what
   * is on screen came from.
   */
  async function seedFromOneSession(page, mark = 'CACHED ACCOUNT') {
    await open(page);

    const held = await stored(page);
    expect(held, 'nothing was stored after a healthy open').not.toBeNull();

    held.open.accounts[0].name = mark;
    await store(page, held);
    return held;
  }

  test('stores what it was told', async ({ page, errors }) => {
    await open(page);
    const held = await stored(page);

    // Both halves, because they land independently and the write is a
    // read-modify-write for exactly that reason — one arriving must not drop
    // the other.
    expect(held.open, 'the appOpen half was not stored').toBeTruthy();
    expect(held.overview, 'the appOverview half was not stored').toBeTruthy();
    expect(held.at, 'no timestamp, so nothing can say how old this is').toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('draws it before a single answer has come back', async ({ page, errors }) => {
    await seedFromOneSession(page);
    await holdAnswers(page);
    await page.goto('/');

    // On screen with every call still out. `__answered` is pushed when an
    // answer reaches the page, so an empty one is the whole claim: this was
    // drawn from storage and from nothing else.
    await expect(page.locator('#screens')).toContainText('CACHED ACCOUNT');
    expect(await answered(page), 'an answer landed before the assertion').toEqual([]);

    // And it says so, rather than passing last week's balances off as today's.
    await expect(page.locator('#refresh')).toBeVisible();
    await expect(page.locator('#refresh')).toContainText('Last updated');
    expect(errors).toEqual([]);
  });

  test('replaces it when the answers land, and stops saying it is old', async ({ page, errors }) => {
    await seedFromOneSession(page);
    await page.goto('/');

    // The mark is gone and the strip is down — the two halves of "this is now
    // the truth". Asserted in that order because the strip clears only once
    // *both* calls are back, so it is the later of the two.
    await expect(page.locator('#screens')).not.toContainText('CACHED ACCOUNT');
    await expect(page.locator('#refresh')).toBeHidden();
    await expect(page.locator('#screens')).toContainText('Net worth');
    expect(errors).toEqual([]);
  });

  test('will not draw a stored copy whose shape it does not know', async ({ page, errors }) => {
    const held = await seedFromOneSession(page);

    // What a deploy that renamed a field looks like from here. The stored copy
    // is perfectly readable and is not this version's, and drawing half of it
    // is the one outcome worse than drawing none.
    held.v = 999;
    await store(page, held);

    await holdAnswers(page);
    await page.goto('/');

    await expect(page.locator('#screens .spinner')).toBeVisible();
    await expect(page.locator('#screens')).not.toContainText('CACHED ACCOUNT');
    // No strip either: there is nothing on screen for it to qualify.
    await expect(page.locator('#refresh')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('forgets what it stored when the gate refuses', async ({ page }) => {
    await seedFromOneSession(page);

    // `appOpen` is the call that carries the verdict. What is stored belongs to
    // whoever was signed in when it was written, so a refusal has to take the
    // screen *and* the copy — otherwise the next reload paints their balances
    // again, ahead of the refusal that is the entire point of the gate.
    await page.goto('/?answers=refused');

    await expect(page.locator('#screens')).toContainText(/signed in as a different Google account/i);
    await expect(page.locator('#screens')).not.toContainText('CACHED ACCOUNT');
    expect(await stored(page), 'the refused session left its copy on the phone').toBeNull();
  });

  test('draws Charts from storage and still asks whether it is right', async ({ page, errors }) => {
    /*
      The one place the cache could quietly stop the app ever being correct.

      `loadAnalytics` returns early on a hit in `state.cache`, which is right
      for a slice fetched this session — the answer is already in hand and
      asking again is a round trip for nothing. A slice hydrated out of storage
      sits in the same map under the same key and is last week's answer, so the
      same early return would draw a stale total and never once check it.
    */
    await open(page);
    await tab(page, CHARTS).click();
    await expect(page.locator('#screens .spinner')).toHaveCount(0);

    const held = await stored(page);
    expect(held.slices.some((slice) => slice.screen === 'analytics'),
      'Charts was opened and no slice was stored').toBe(true);

    await page.goto('/?v=analytics');

    await expect
      .poll(async () => (await calls(page)).filter((name) => name === 'appAnalytics').length)
      .toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('keeps a deep link when the fetched payload lands over the stored one', async ({ page, errors }) => {
    /*
      `applyUrlFilters` consumes the query string on its first call, and the
      stored payload and the fetched one both go through `applyOverview`. A
      second pass that re-adopted the server's defaults would put them over
      filters the URL had already set, with nothing left to apply them again —
      so the screen would show the asked-for slice and then silently revert to
      the year to date a few seconds later.
    */
    await seedFromOneSession(page);
    await page.goto('/?v=records&u=1');

    await expect(tab(page, RECORDS)).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#refresh')).toBeHidden();

    // Still the filter the URL asked for, after both answers have landed.
    const unconfirmed = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appRecords').map((c) => c.args[0].unconfirmedOnly));

    expect(unconfirmed.length, 'Records never fetched for the URL slice').toBeGreaterThan(0);
    expect(unconfirmed.every(Boolean), 'a fetch went out without the URL filter').toBe(true);
    expect(errors).toEqual([]);
  });
});

/*
  Pull to refresh, which had no test and stopped working.

  The gesture guarded on `state.refreshing`, a boolean it owned. The opening
  calls turned that name into an object with a slot each — and an object is
  always truthy, so `if (state.refreshing) return;` began returning on every
  touch and the gesture was silently dead. Nothing threw, nothing was logged,
  every other test stayed green, and it reached the phone.

  A shared name in a shared object is a shared name, and the reason it got past
  everything is that this file had nothing pointed at the gesture at all.
*/
test.describe('pull to refresh', () => {
  /** A downward drag from the top of the document, in the shape WebKit accepts. */
  const pull = (page, distance, selector) => page.evaluate(([travel, at]) => {
    const target = at ? document.querySelector(at) : document.body;
    const point = (y) => (document.createTouch
      ? document.createTouch(window, target, 1, 40, y, 40, y)
      : new Touch({ identifier: 1, target, clientX: 40, clientY: y }));

    const list = (...points) => (document.createTouchList
      ? document.createTouchList(...points) : points);

    const touch = (type, y) => {
      const one = point(y);
      target.dispatchEvent(new TouchEvent(type, {
        bubbles: true, cancelable: true,
        touches: type === 'touchend' ? list() : list(one),
        targetTouches: type === 'touchend' ? list() : list(one),
        changedTouches: list(one)
      }));
    };

    // In steps, because `touchmove` is where the distance is accumulated and a
    // single jump would arrive as one move the gesture never followed.
    touch('touchstart', 10);
    for (let step = 1; step <= 8; step += 1) touch('touchmove', 10 + (travel * step) / 8);
    touch('touchend', 10 + travel);
  }, [distance, selector || null]);

  test('a pull past the threshold re-reads the dashboard', async ({ page, errors }) => {
    await open(page);
    await page.evaluate(() => { window.__calls.length = 0; });

    // PULL_THRESHOLD is 70; 140 clears it with room for the damping above it.
    await pull(page, 140);

    await expect.poll(() => calls(page)).toContain('appDashboard');

    // And it asks for the ledger to be re-read, which is the whole difference
    // between this gesture and simply looking at the screen again.
    const fresh = await page.evaluate(() =>
      window.__calls.filter((c) => c.name === 'appDashboard').map((c) => c.args[0]));
    expect(fresh.some(Boolean), 'appDashboard was not asked for a fresh read').toBe(true);
    expect(errors).toEqual([]);
  });

  test('a drag inside a list scrolled down is that list\'s scroll', async ({ page, errors }) => {
    // The category picker's list scrolls inside itself. At the top of the
    // page, dragging it back towards its own top is the same gesture as a pull,
    // and used to arm one.
    await open(page);
    await page.locator('#screens .tile button.link', { hasText: '+ Add' }).click();
    await page.locator('#screens .catpick-current').click();
    await page.evaluate(() => { document.querySelector('.catpick-list').scrollTop = 200; });
    await page.evaluate(() => { window.__calls.length = 0; });

    await pull(page, 140, '.catpick-option:not(.first)');

    await page.waitForTimeout(300);
    expect(await calls(page)).not.toContain('appDashboard');
    expect(errors).toEqual([]);
  });

  test('a pull too short to arm sends nothing', async ({ page, errors }) => {
    await open(page);
    await page.evaluate(() => { window.__calls.length = 0; });

    await pull(page, 30);

    await page.waitForTimeout(400);
    expect(await calls(page)).not.toContain('appDashboard');
    expect(errors).toEqual([]);
  });

  test('shows the same strip the app opens with, and clears it when the answer lands',
    async ({ page, errors }) => {
      // One thing on this page means "being brought up to date". The pill is the
      // affordance for the drag and goes the moment you let go; the strip
      // reports the fetch, and is cleared by the answer rather than by a timer.
      await open(page);
      // Long enough that the strip is unambiguously up while the call is out,
      // short enough that "it came down" is not a bet on how loaded the machine
      // is — the assertions below are ordered, not timed.
      await page.evaluate(() => { window.__latency = 1200; });

      await pull(page, 140);

      await expect(page.locator('#refresh')).toBeVisible();
      await expect(page.locator('#refresh')).toContainText('Refreshing');
      await expect(page.locator('#pull')).toBeHidden();

      await expect(page.locator('#refresh')).toBeHidden({ timeout: 15000 });
      expect(errors).toEqual([]);
    });
});

/*
  A dropped connection is not the owner gate, and the difference is the cache.

  `withFailureHandler` reports both with nothing to tell them apart but the
  wording, which is why the page has `isTransportFailure` at all. `openFailed`
  did not consult it, so one queued Apps Script execution or one lift threw away
  a perfectly good stored copy — the next open was cold with nothing on screen
  explaining why, and the one after that was fine again. From the outside: two
  refreshes give cached data and the third does not.
*/
test.describe('a refusal and a dropped connection', () => {
  const KEY = 'spendsheet';

  const stored = (page) => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, KEY);

  const failWith = (page, message) => page.addInitScript((text) => {
    window.__failures = { appOpen: text };
  }, message);

  /**
   * Wait until the failure has actually been handled, rather than for a while.
   *
   * `callOrRetry` sleeps `RETRY_MS` before its second attempt, so `openFailed`
   * does not run for well over a second — and an assertion made straight after
   * `goto` is asserting about the hydrated screen with the failure still in the
   * post. A fixed sleep covers that and turns every one of these into a race
   * against however loaded the machine is, which is what this suite's "no
   * retries" rule exists to stop being hidden.
   *
   * The toast is the signal: `openFailed` raises one whenever there is a screen
   * to keep, so its appearance *is* the handler having run.
   */
  const failureHandled = (page) => expect(page.locator('#toast')).toBeVisible({ timeout: 15000 });

  test('a dropped connection keeps the stored copy', async ({ page }) => {
    await open(page);
    expect(await stored(page), 'nothing was stored by a healthy open').not.toBeNull();

    // The sandbox host's own wording for an XHR that died, which is the string
    // `isTransportFailure` is written against.
    await failWith(page, 'http connection failure 0');
    await page.goto('/');
    await failureHandled(page);

    expect(await stored(page), 'a dropped connection threw the copy away').not.toBeNull();
  });

  test('a dropped connection keeps the screen it drew from storage', async ({ page }) => {
    await open(page);
    const held = await stored(page);
    held.open.accounts[0].name = 'CACHED ACCOUNT';
    await page.evaluate(([key, copy]) => {
      localStorage.setItem(key, JSON.stringify(copy));
    }, [KEY, held]);

    await failWith(page, 'http connection failure 0');
    await page.goto('/');

    // After the handler has run, not before it — asserted straight after
    // `goto`, this passed against code that wiped the screen, which is the only
    // thing it exists to catch.
    await failureHandled(page);

    // Still there. Replacing a working screen with an error page because the
    // radio dropped throws away the one useful thing the page is holding — and
    // it must not offer the wrong-account explanation, which is about a refusal.
    await expect(page.locator('#screens')).toContainText('CACHED ACCOUNT');
    await expect(page.locator('#screens'))
      .not.toContainText(/signed in as a different Google account/i);
  });
});
