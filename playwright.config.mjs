/**
 * playwright.config.mjs — the browser half of the suite.
 *
 * Vitest runs the viewer's domain and Worker in Node, which is what makes it
 * fast and what makes it blind to the page: nothing there lays anything out,
 * registers a service worker, or receives a touch. A page that compiles and
 * throws on the first line of its boot is a blank screen, and is
 * indistinguishable from a healthy one by every unit test.
 *
 * So this is a second runner, deliberately. Vitest cannot host a browser and
 * `npm test` should not grow a fifteen-second browser start; `npm run test:e2e`
 * is the other command, and CI runs both.
 *
 * **WebKit, and only WebKit.** This app is opened on one device by one person
 * and that device runs Safari, so a Chromium run would be testing an engine
 * nobody points at it. WebKit is not iOS Safari — it will not reproduce how the
 * phone sizes a native `input[type="date"]`, which is the exact bug that
 * shipped once here — but it is the same engine family.
 *
 * The device descriptor is doing more than setting a width: `hasTouch` is what
 * makes the page's touch listeners reachable at all.
 *
 * **The built page** under `vite preview`, because that is what ships — a
 * production build compiles the JSX differently from the dev server, and
 * registers the service worker, which only a built page does. Built once,
 * served on a port clear of `vite.config.ts`'s default. The tests answer every
 * Worker path themselves with `page.route`, so nothing behind the proxy —
 * running or not — can change what they see. Locally an already-running server
 * on that port is reused, which keeps the edit-and-rerun loop quick; in CI it
 * never is, because a server that was already up is a server nobody knows the
 * age of.
 *
 * `web/e2e/shell/` runs against the same `dist/`, through a preview it starts
 * and stops itself: taking the server away is the only offline a WebKit
 * service worker believes.
 */

import { defineConfig, devices } from '@playwright/test';

const VIEWER_PORT = Number(process.env.VIEWER_PORT || 4323);

export default defineConfig({
  testDir: 'web/e2e',
  fullyParallel: true,

  // No retries, here or in CI. Nothing in this suite touches a network or a
  // real server — the page, a canned answer table and a timer — so a test that
  // passes on the second attempt is reporting a race in the page, which is the
  // one kind of bug this suite exists to find. A retry would hide it.
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],

  use: {
    trace: 'retain-on-failure'
  },

  projects: [
    {
      name: 'viewer-webkit',
      testIgnore: 'shell/**',
      // The built page registers its service worker, and `page.route` cannot
      // see a request a worker answers. The shell's own test allows it.
      use: { ...devices['iPhone 13'], baseURL: `http://localhost:${VIEWER_PORT}`, serviceWorkers: 'block' }
    },
    {
      name: 'viewer-shell',
      testDir: 'web/e2e/shell',
      use: { ...devices['iPhone 13'] }
    }
  ],

  webServer: {
    command: `npm --prefix web run build && npm --prefix web run preview -- --port=${VIEWER_PORT} --strictPort`,
    url: `http://localhost:${VIEWER_PORT}/`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe'
  }
});
