/**
 * playwright.config.mjs — the browser half of the suite.
 *
 * Everything under `tests/*.test.mjs` runs in `node:vm` against faked Google
 * services, which is what makes it fast and what makes it blind to the page:
 * the harness loads the `.gs` files and nothing inside an HTML file reaches it.
 * `tests/page.test.mjs` closes part of that by compiling the assembled document
 * with `new Function` — it proves the page *parses* and runs none of it. A page
 * that parses and throws on the first line of its boot is a blank screen, and
 * is indistinguishable from a healthy one by every test that existed before
 * this file.
 *
 * So this is a second runner, deliberately. Vitest cannot host a browser and
 * `npm test` should not grow a fifteen-second browser start; `npm run test:e2e`
 * is the other command, and CI runs both.
 *
 * **WebKit, and only WebKit.** This app is opened on one device by one person
 * and that device runs Safari, so a Chromium run would be testing an engine
 * nobody points at it. WebKit is not iOS Safari — it will not reproduce how the
 * phone sizes a native `input[type="date"]`, which is the exact bug that shipped
 * once here — but it is the same engine family, and choosing Chromium for a
 * phone-only app would bake the wrong default into every future test. What this
 * suite can prove is in the header of `tests/e2e/app.spec.mjs`, along with what
 * it cannot.
 *
 * The device descriptor is doing more than setting a width. `isMobile` and
 * `hasTouch` are what make the touch listeners in `page.gestures.html` and
 * `page.records.html` reachable at all: without them the page loads and the
 * swipe-to-confirm gesture is dead code no test can enter.
 *
 * `webServer` runs the same `npm run preview` a person would, on a port of its
 * own so a preview left open in another terminal is neither reused by accident
 * nor in the way. Locally an already-running server on that port is reused,
 * which keeps the edit-and-rerun loop quick; in CI it never is, because a
 * server that was already up is a server nobody knows the age of.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.PREVIEW_PORT || 4322);

// The viewer (`web/`) is a second page with a second server: Vite's own, on a
// port clear of both the preview's and `vite.config.ts`'s default. Its tests
// answer every Worker path themselves with `page.route`, so nothing behind the
// dev server's proxy — running or not — can change what they see.
const VIEWER_PORT = Number(process.env.VIEWER_PORT || 4323);

// The viewer again, **built**, because its service worker registers only in a
// production page — the dev server's shell changes on every save. `web/e2e/
// shell/` is the one directory that runs against it.
const SHELL_PORT = Number(process.env.SHELL_PORT || 4324);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,

  // No retries, here or in CI. Nothing in this suite touches a network or a
  // real server — the page, a canned answer table and a timer — so a test that
  // passes on the second attempt is reporting a race in the page, which is the
  // one kind of bug this suite exists to find. A retry would hide it.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure'
  },

  projects: [
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'] } },
    {
      name: 'viewer-webkit',
      testDir: 'web/e2e',
      testIgnore: 'shell/**',
      use: { ...devices['iPhone 13'], baseURL: `http://localhost:${VIEWER_PORT}` }
    },
    {
      name: 'viewer-shell',
      testDir: 'web/e2e/shell',
      use: { ...devices['iPhone 13'], baseURL: `http://localhost:${SHELL_PORT}` }
    }
  ],

  webServer: [
    {
      command: `npm run preview -- --port=${PORT}`,
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe'
    },
    {
      command: `npm --prefix web run dev -- --port=${VIEWER_PORT} --strictPort`,
      url: `http://localhost:${VIEWER_PORT}/`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe'
    },
    {
      command: `npm --prefix web run build && npm --prefix web run preview -- --port=${SHELL_PORT} --strictPort`,
      url: `http://localhost:${SHELL_PORT}/`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe'
    }
  ]
});
