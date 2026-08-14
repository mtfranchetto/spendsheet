# Deploying

```
npm run deploy
```

Tests, pushes, cuts a version, moves both doors onto it, then reads both doors back from Google and refuses to finish quietly if either one is not what it should be.

`npm run deploy:dry` prints the same plan and touches nothing — worth running first if it has been a while.

## The three things, and why a push is often enough

clasp touches three separate things and they are easy to conflate:

| | what changes | who sees it |
|---|---|---|
| `clasp push` | the project's working copy (HEAD) | anything run from the Sheet, immediately |
| `clasp version` | freezes HEAD as immutable version N | nobody, yet |
| `clasp redeploy` | points a door's URL at version N | that door's `/exec` |

Menu items, dialogs and the nightly trigger all execute at HEAD, so a push is genuinely all they need. A live `/exec` serves a **frozen version**, which is the whole reason the other two steps exist: without them the sheet half of a change is live and the phone half is not, and nothing anywhere reports a problem.

`npm run deploy` decides which case you are in by looking at what changed under `src/` since the last deploy it recorded. A redeploy is forced by:

- `src/page*.html` — the app document and every partial
- `src/20`–`src/23` — routing, the owner gate, queries, actions, the public API
- whichever file defines `doGet` (found by reading, not by name)
- `src/appsscript.json` — a version carries the manifest, so a scope added today is not a scope the deployed app has until a version is cut with it

Anything else pushes and stops, and says so.

If `src/page*.html` changed it also runs `npm run test:e2e` before pushing, because that is the suite covering the half being deployed.

## The two doors

One script, two deployments, and they are not interchangeable.

| door | key | description | access | what it is |
|---|---|---|---|---|
| 1 | `bank` | Spendsheet banking | **Anyone** | the consent redirect. Its URL is registered with Enable Banking, and the browser arriving at it has nobody signed in. |
| 2 | `app` | Spendsheet viewer | **Only myself** | the mobile app. It serves this book's balances. |

Both go to the same version on every deploy. Nothing about the code makes the consent redirect and the phone allowed to disagree, and one door redeployed by hand is exactly what a version skew looks like afterwards.

### Why the script reads the doors back

A deployment's access setting is per-deployment, but it is *derived from the manifest of the version being deployed* when a deployment is created. `src/appsscript.json` declares `ANYONE_ANONYMOUS` — the bank door's setting. The app door was set to `MYSELF` in the UI, so it diverges from the manifest it was cut from.

Whether `redeploy` re-derives access from the new version's manifest or leaves the deployment's own setting alone is not something the documentation settles, and the failure mode if it re-derives is the one worth being paranoid about: **this book's balances behind a URL anyone can load**, with only `requireOwner_` between them and a stranger. It would also look completely normal from your own phone, because you are allowed in either way.

So it is not assumed in either direction. Every run refetches both entry points from the Apps Script API and fails on any mismatch. `clasp list-deployments` cannot show this — the access setting lives on the entry point, which clasp does not print — so the check goes to the REST API, using the refresh token in `~/.clasprc.json` that clasp is already holding.

If it ever does fail:

> Apps Script editor → Deploy → Manage deployments → pencil → set **Who has access**, and Version: **New version**.

Update in place. Never *New deployment*.

## What is not automated

`clasp deploy` (create-deployment) is never called, and `tests/deploy.test.mjs` fails if it appears in the script. Without `-i` it mints a **new** deploymentId and a new URL: on the bank door that breaks the redirect Enable Banking has registered, and on the app door it points the home-screen icon at nothing.

Recreating a door is a one-time human operation, so it is written down rather than built:

1. Apps Script editor → Deploy → **New deployment** → Web app.
2. Set **Execute as: Me** and **Who has access** to the value in the table above — for the app door, `Only myself`, and check it twice.
3. Copy the new deployment id into `.deploy.json`.
4. For the bank door only: register the new `/exec` URL with Enable Banking as the redirect URI, or consent will fail on the round trip back.
5. For the app door only: re-add the home-screen icon on the phone.

## `.deploy.json`

Gitignored — this repo is public, and the app door's URL is the outer lock on a page showing balances. Copy `.deploy.example.json`, fill in the two ids from `npx clasp list-deployments`, and leave `access` as the table above: it is the assertion the script checks the live door against, not a setting it applies.

`lastDeploy` is written by the script and is how it knows which files changed since. Delete it to make the next run treat everything as changed.

## Options

| | |
|---|---|
| `--dry-run` | print the plan, change nothing |
| `--door app` \| `--door bank` | redeploy one door. The other is left on its version, so the two will differ until the next full run |
| `--force` | version and redeploy even though nothing web-facing changed |
| `--push-only` | push and stop |
| `--skip-tests` | push code no suite has seen. Says so, loudly |
| `--user <name>` | a named `clasp login` credential, if you have more than one |
