/**
 * playwright.screenshots.config.mjs — the pictures in the README, retaken.
 *
 * `npm run screenshots` draws the phone app from an invented book and writes
 * `docs/assets/screenshots/`. A config of its own rather than a project in
 * `playwright.config.mjs`, because that one is the suite: everything under it
 * runs on `npm run test:e2e` and in CI, and a run that rewrites four tracked
 * images every time it passes is a diff nobody asked for.
 *
 * The same engine, the same built page and the same answered Worker as the
 * suite, for the suite's reasons. Two things differ:
 *
 * - **The viewport is the whole screen.** The device descriptor's is what
 *   Safari leaves under its toolbars; this app is opened from a Home Screen
 *   icon, which has none.
 * - **Two device pixels to one, not three.** The README draws these a few
 *   hundred pixels wide, and the third costs more than half of every file.
 *
 * A port of its own, and never a reused server: the pictures are of this
 * checkout's build, and a preview already up is one nobody knows the age of.
 */

import { defineConfig, devices } from '@playwright/test';

const VIEWER_PORT = Number(process.env.VIEWER_PORT || 4324);

export default defineConfig({
  testDir: 'web/screenshots',
  // Not `*.spec.*` or `*.test.*`: Vitest claims both, and would collect it.
  testMatch: '*.shots.mjs',
  retries: 0,
  reporter: [['list']],

  projects: [
    {
      name: 'readme',
      use: {
        ...devices['iPhone 13'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        baseURL: `http://localhost:${VIEWER_PORT}`,
        serviceWorkers: 'block'
      }
    }
  ],

  webServer: {
    command: `npm --prefix web run build && npm --prefix web run preview -- --port=${VIEWER_PORT} --strictPort`,
    url: `http://localhost:${VIEWER_PORT}/`,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe'
  }
});
