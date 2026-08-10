/**
 * vitest.config.mjs — which of the two suites is Vitest's.
 *
 * There are two runners here and their default file patterns overlap: Vitest
 * claims `*.test.*` *and* `*.spec.*`, and Playwright's specs are the second of
 * those. Collected by Vitest, a spec fails at import — `@playwright/test` has
 * no runner behind it there — so the failure is loud, which is the good case.
 * The bad case is the reverse and it is silent: a spec that happens not to
 * import anything Vitest chokes on gets *collected*, reported as passing, and
 * counted in a total that says the browser tests ran when no browser started.
 *
 * Excluded by directory rather than by filename, because a name protects one
 * file and a directory protects whatever anyone puts in it later.
 *
 * `tests/e2e` runs under `npm run test:e2e`. See `playwright.config.mjs`.
 */

import { defineConfig, configDefaults } from 'vitest/config';

export default defineConfig({
  test: {
    // `.claude/worktrees` holds checkouts of this same repository, tests and
    // all, so a run from the root collects every suite in every worktree — a
    // green total that counts a copy of the code nobody is working on, and one
    // that goes red for a branch that was abandoned mid-edit.
    exclude: [...configDefaults.exclude, 'tests/e2e/**', '.claude/**']
  }
});
