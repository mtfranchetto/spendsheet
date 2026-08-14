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
| `clasp push` | the project's working copy (HEAD), manifest included | anything run from the Sheet, immediately |
| `clasp version` | freezes HEAD as immutable version N | nobody, yet |
| `clasp redeploy` | points a door's URL at version N, and rebuilds its access from that version's manifest | that door's `/exec` |

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

Both carry the same code on every deploy. Nothing about the code makes the consent redirect and the phone allowed to disagree, and one door redeployed by hand is exactly what a version skew looks like afterwards.

They do **not** land on the same version number, and that is deliberate — see below.

### Why each door gets its own version

A deployment's "Who has access" lives on its **entry point**, and `entryPoints` is output-only in the Apps Script API. `deployments.update` — what `clasp redeploy` calls — drops the entry point and rebuilds it from the manifest. Two consequences, and both are load-bearing:

- **Access cannot be set through the API.** There is no field for it. The Apps Script UI is the only place a human can change it.
- **A redeploy does not preserve the setting a door already had.** It takes whatever `webapp.access` the manifest says, every time.

One manifest cannot say `ANYONE_ANONYMOUS` for the bank door and `MYSELF` for the app door at once, so a single shared version cannot deploy both doors correctly. It lands one answer on both — and the direction that costs something is the app door coming back public with only `requireOwner_` between a stranger and the balances.

So the script deploys one door at a time, and each one gets the manifest it needs:

```
write webapp.access = <the door's access>  →  push  →  create-version N
  →  update-deployment <door> -V N
```

The two versions hold identical code and differ in that one manifest field. Adjacent version numbers are what a healthy deploy looks like here.

Sequencing the manifest write immediately before the version is also what keeps this independent of a question the documentation does not answer: whether the rebuilt entry point reads the *version's* manifest or HEAD's at the moment of the update. Done in this order they are the same file, so both answers give the same result.

`src/appsscript.json` is tracked, so it is captured before the first write and restored afterwards — from an `exit` hook as well as a `finally`, because the script's own `fail()` leaves through `process.exit`, which runs neither a `finally` nor a signal handler. A closing push puts HEAD back on the committed manifest, so git and the Apps Script editor agree once a deploy has finished.

### Why the script still reads the doors back

Because the mechanism above is a claim, and the failure it would produce is silent: **this book's balances behind a URL anyone can load**. That looks completely normal from your own phone, because you are allowed in either way.

Every run refetches both entry points from the Apps Script API and fails on any mismatch. `clasp list-deployments` cannot show this — the access setting lives on the entry point, which clasp does not print — so the check goes to the REST API, using the refresh token in `~/.clasprc.json` that clasp is already holding.

That read is **polled**, not taken once. The deployments endpoint lags a redeploy by a few seconds and answers with the *previous* state — not a harmless delay, because the record it returns describes the door as it was before the update. A check that trusts the first answer reads the old access off a door it never actually looked at. The script waits for each door to report the version it was just given, and only then asks what access came back with it.

If it ever does fail:

> Apps Script editor → Deploy → Manage deployments → pencil → set **Who has access**, and Version: **New version**.

Update in place. Never *New deployment*. Then treat it as a bug in the deploy rather than a one-off: the access came from the manifest that run wrote, so a wrong answer will repeat on the next run and undo the manual repair.

## What is not automated

`clasp deploy` (create-deployment) is never called, and `scripts/deploy.test.mjs` fails if it appears in the script. Without `-i` it mints a **new** deploymentId and a new URL: on the bank door that breaks the redirect Enable Banking has registered, and on the app door it points the home-screen icon at nothing.

Recreating a door is a one-time human operation, so it is written down rather than built:

1. Apps Script editor → Deploy → **New deployment** → Web app.
2. Set **Execute as: Me** and **Who has access** to the value in the table above — for the app door, `Only myself`, and check it twice.
3. Copy the new deployment id into `.deploy.json`.
4. For the bank door only: register the new `/exec` URL with Enable Banking as the redirect URI, or consent will fail on the round trip back.
5. For the app door only: re-add the home-screen icon on the phone.

## `.deploy.json`

Gitignored — this repo is public, and the app door's URL is the outer lock on a page showing balances. Copy `.deploy.example.json`, fill in the two ids from `npx clasp list-deployments`, and leave `access` as the table above: it is both the value written into the manifest before that door's version is cut, and the assertion the live door is then checked against.

`lastDeploy` is written by the script. `commit` is how it knows which files changed since; `versions` records the version each door was left on, one per door. Delete it to make the next run treat everything as changed.

## Options

| | |
|---|---|
| `--dry-run` | print the plan, change nothing |
| `--door app` \| `--door bank` | redeploy one door. The other is left on its version, so the two will differ until the next full run |
| `--force` | version and redeploy even though nothing web-facing changed |
| `--push-only` | push and stop |
| `--skip-tests` | push code no suite has seen. Says so, loudly |
| `--user <name>` | a named `clasp login` credential, if you have more than one |
