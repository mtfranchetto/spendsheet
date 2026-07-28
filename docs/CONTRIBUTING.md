# Contributing

## Running the tests

```bash
npm install
npm test
npm run test:watch
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

Tests are written **in the same phase as the code they cover**, never batched into a final pass.

## What can't be tested here

JWT signing against a real key, actual Sheet reads and writes, and the live API client need the Google runtime. Those get a `runSmokeTests()` menu item that writes pass/fail to the `_tests` tab. They are not unit tests, they do not run in CI, and the README says so rather than implying coverage that doesn't exist.

## Style

- Plain ES5-compatible JavaScript in `src/*.gs`. V8 is available, but the files stay conservative and dependency-free.
- Files are numbered because Apps Script concatenates them in name order. The number is load order, not decoration.
- **Code only for what runs unattended and repeatedly.** One-time human operations get documented, not automated — this is why there is no CSV importer and no "add account" wizard. A pull request that adds one will be asked what makes it recurring.

## Optional: clasp

The Apps Script editor has no bulk import — you create each file and paste into it, and drag-and-drop does nothing. That's fine for the three files a user needs, but `src/` grows to eleven, so `clasp` pushes the whole folder in one command.

It's the developer path, not the user path: the README stays copy-paste so nobody needs Node to *use* this.

`clasp` is already a devDependency, so there's nothing to install globally.

**One-time setup:**

```bash
# 1. Enable the Apps Script API for your Google account (once, ever):
#    https://script.google.com/home/usersettings  →  Google Apps Script API: ON
#    Without this, push fails with a 403 that doesn't explain itself.

npx clasp login          # opens a browser

# 2. Point at your script. Apps Script → Project Settings → Script ID.
cat > .clasp.json <<'JSON'
{ "scriptId": "PASTE_YOUR_SCRIPT_ID", "rootDir": "src" }
JSON

npm run status           # lists what would be pushed — check before the first push
npm run push             # --force the first time, to overwrite the remote manifest
```

**Day to day:**

```bash
npm run push          # sync src/ → Apps Script
npm run push:watch    # push on every save
npm run pull          # pull remote edits back down
```

### Why `rootDir` is `src`

`clasp` requires `appsscript.json` to sit in `rootDir`, which is why the manifest lives in `src/` rather than at the repo root. The payoff is that files arrive in the editor named `00_config`, `03_setup`, `10_menu` — exactly what the README tells copy-paste users to call them. With `rootDir: "."` they'd arrive as `src/00_config`, and the two setup paths would produce different projects.

### Watch out

- **`.clasp.json` and `.clasprc.json` are gitignored.** The first holds your script ID, the second your OAuth credentials. Keep it that way.
- **`clasp pull` overwrites local files.** It's for recovering edits made in the web editor, not a merge.
- **Pushing does not deploy.** The web app URL that banks redirect to comes from a *deployment*; `clasp push` only updates the code behind it. Use `clasp deploy` or the editor's Deploy button.
