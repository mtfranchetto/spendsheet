# Contributing

## Running the tests

```bash
npm run bootstrap  # both installs, root and web/, and the WebKit the browser suite drives
npm test           # the .gs in node:vm against faked Google services, and web/ under Vitest
npm run test:watch
```

The phone app has a suite of its own, in a browser, and it is a separate command:

```bash
npm run test:e2e
```

## How the tests work, and why it matters

There is **no build step and no second copy of the source.** `tests/harness.mjs` uses `node:vm` to load `src/*.gs` into a sandbox with the Google services replaced by in-memory fakes, reproducing exactly what Apps Script does: concatenate every file into one global scope and execute it.

So the files under test are byte-for-byte the files a user pastes into the Apps Script editor.

The consequence to internalise: **`src/*.gs` must never contain `import` or `export`.** Adding one would make a function reachable from a test and simultaneously break the project for every user, because Apps Script would refuse to load it. CI greps for this specifically.

```js
import { load } from './harness.mjs';

const ctx = load();          // every top-level function is on ctx
ctx.setup();
ctx.__spreadsheet.getSheetByName('transactions').headers();
```

The harness exposes a few handles for assertions:

| | |
|---|---|
| `ctx.__spreadsheet` | the fake spreadsheet — `.snapshot()` serialises it for idempotency diffs |
| `ctx.__properties` | Script Properties as a `Map` |
| `ctx.__fetches` | every `UrlFetchApp.fetch` call, with URL and params |
| `ctx.__sentMail` | every `MailApp.sendEmail` call |
| `ctx.__ui` | menus built and alerts raised |
| `ctx.__triggers()` | installed triggers |

Pass options to `load()` to control the environment — `load({ fetch: (url, params) => ({ code: 429, body: '...' }) })` to make an API return a rate-limit error, `load({ properties: { EB_ENV: 'SANDBOX' } })` to preset credentials.

## What to test

The rule this repo follows is that **pure logic is separated from Sheet and HTTP I/O**, and the pure part is where the tests go. Every `.gs` file exposes its real work as functions taking plain arrays and objects; the Apps Script-touching wrappers stay thin enough to eyeball.

This is not architectural purity for its own sake. The expensive bugs in this project live in sign conventions, deduplication, merchant normalisation and recurrence detection — all of which are pure functions, and all of which fail *quietly*. A sign inversion doesn't crash; it reports your salary as an expense. A dedup collision doesn't error; it silently discards a real transaction.

Tests are written **in the same change as the code they cover**, never batched into a final pass.

## Writing formulas

**Author every formula with commas, and write it through `setFormula_()`.**

Sheets in a decimal-comma locale — Italian, German, French, Spanish and others — separates formula arguments with `;`, and `setFormula()` does **not** convert. A comma-separated formula lands in an Italian sheet as `#ERROR!`, a parse failure, with no hint as to why.

`setFormula_()` translates once at the write boundary via `localizeFormula()`, which is quote-aware so a comma inside a string literal survives. The separator itself is detected by asking the spreadsheet rather than by keeping a list of locales: `=SUM(1,1)` evaluates to `2` where the comma separates arguments and `1.1` where it's a decimal point.

The consequence for you: never call `range.setFormula()` directly, and never hand-write semicolons. Both work locally and break for half the world.

## Opening the app without deploying it

The phone app lives in `web/` and runs locally against a real book — [`web/README.md`](../web/README.md) has the commands. Point a browser or Playwright at it. **This is the only way to check anything about layout, a natively-rendered control, or a gesture** — the unit suites can prove a CSS rule is written and cannot prove it is honoured, and the two have disagreed here before on the one device the app is for.

## The browser suite

`npm run test:e2e` runs `web/e2e/` under Playwright, against the built page served by `vite preview`, which it starts itself. It is a second runner rather than more Vitest files, because Vitest cannot host a browser and `npm test` should stay fast. The tests answer every Worker path themselves, so nothing behind the page can change what they see.

**WebKit only, at an iPhone viewport.** The app is opened on a phone; a Chromium pass would be exercising an engine nothing points at it. `hasTouch` from the device descriptor is what makes the touch listeners reachable — without it, swipe-to-confirm is code no test can enter.

What it does not prove: **WebKit is not iOS Safari.** It will not reproduce how the phone sizes a native `input[type="date"]`, which is precisely the bug that shipped here once. Say whether you checked on the device or in a browser; they answer different questions.

Before keeping a browser test, break the thing it covers and watch it go red. A test that cannot fail is worse than no test, because it is counted.

## What can't be tested here

JWT signing against a real key, actual Sheet reads and writes, and the live API client need the Google runtime. Those get a `runSmokeTests()` menu item that writes pass/fail to the `_tests` tab. They are not unit tests, they do not run in CI, and the README says so rather than implying coverage that doesn't exist.

The browser suite narrows this but does not close it: it runs the page against canned answers, so it proves the drawing and proves nothing about Sheets. A formula that a decimal-comma locale rejects still passes everything here.

## Style

- Plain ES5-compatible JavaScript in `src/*.gs`. V8 is available, but the files stay conservative and dependency-free.
- Files are numbered because Apps Script concatenates them in name order. The number is load order, not decoration.
- **Code only for what runs unattended and repeatedly.** One-time human operations get documented, not automated — this is why there is no CSV importer and no "add account" wizard. A pull request that adds one will be asked what makes it recurring.

## clasp

`clasp` is how the code reaches the Apps Script project, for users and contributors alike. Logging in and writing `.clasp.json` is [step 2 of the setup](SETUP.md#2-add-the-code); it is a devDependency, so there is nothing to install globally.

**Day to day:**

```bash
npm run push          # sync src/ → Apps Script
npm run push:watch    # push on every save
npm run pull          # pull remote edits back down
npm run deploy        # test, push, version, and move the live URLs onto it
npm run deploy:dry    # print what that would do, change nothing
```

### Why `rootDir` is `src`

`clasp` requires `appsscript.json` to sit in `rootDir`, which is why the manifest lives in `src/` rather than at the repo root. The payoff is that files arrive in the editor named `00_config`, `04_setup`, `19_menu` — exactly what someone pasting them by hand calls them. With `rootDir: "."` they'd arrive as `src/00_config`, and the two setup paths would produce different projects.

### Watch out

- **`.clasp.json` and `.clasprc.json` are gitignored.** The first holds your script ID, the second your OAuth credentials. Keep it that way.
- **`clasp pull` overwrites local files.** It's for recovering edits made in the web editor, not a merge.
- **Pushing does not deploy.** The web app URL that banks redirect to comes from a *deployment*; `clasp push` only updates the code behind it. `npm run deploy` cuts a version and moves the existing URL onto it — see [docs/DEPLOY.md](DEPLOY.md), which also covers why it never runs `clasp deploy`: that command mints a *new* URL, and the one here is registered with your provider.
