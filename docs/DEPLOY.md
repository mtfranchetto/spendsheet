# Deploying

This page is the Apps Script half: the sheet, the sync, and the consent redirect. The phone app is a Cloudflare Worker and deploys from `web/` — see [`web/README.md`](../web/README.md).

```
npm run deploy
```

Tests, pushes, cuts a version, moves the consent redirect onto it, then reads it back from Google and refuses to finish quietly if it is not what it should be.

`npm run deploy:dry` prints the same plan and touches nothing — worth running first if it has been a while.

## The three things, and why a push is often enough

clasp touches three separate things and they are easy to conflate:

| | what changes | who sees it |
|---|---|---|
| `clasp push` | the project's working copy (HEAD), manifest included | anything run from the Sheet, immediately |
| `clasp version` | freezes HEAD as immutable version N | nobody, yet |
| `clasp redeploy` | points the redirect's URL at version N, and rebuilds its access from that version's manifest | the redirect's `/exec` |

Menu items, dialogs and the nightly trigger all execute at HEAD, so a push is genuinely all they need. A live `/exec` serves a **frozen version**, which is the whole reason the other two steps exist.

`npm run deploy` decides which case you are in by looking at what changed under `src/` since the last deploy it recorded. A redeploy is forced by:

- **any** `src/*.gs` — the redirect runs a frozen copy of the whole project. It is served to anyone with the `google.script.run` bridge, so every public function in every file is on its surface at the version it serves: a gate pushed but not deployed is a gate the redirect does not have.
- `src/appsscript.json` — a version carries the manifest.

Anything else pushes and stops, and says so.

## The deployment

One: the consent redirect, access **Anyone**. Its URL is registered with Enable Banking, and the browser arriving at it has nobody signed in.

### Where its access comes from

A deployment's "Who has access" lives on its **entry point**, and `entryPoints` is output-only in the Apps Script API. `deployments.update` — what `clasp redeploy` calls — drops the entry point and rebuilds it from the manifest. Two consequences:

- **Access cannot be set through the API.** The Apps Script UI is the only place a human can change it.
- **A redeploy does not preserve the setting the deployment already had.** It takes whatever `webapp.access` the manifest says, every time.

So `src/appsscript.json` says `ANYONE_ANONYMOUS`, and the script refuses to start if it does not.

### Why the script still reads it back

Every run refetches the entry point from the Apps Script API and fails on a wrong version or a wrong access. `clasp list-deployments` cannot show this — the access setting lives on the entry point, which clasp does not print — so the check goes to the REST API, using the refresh token in `~/.clasprc.json` that clasp is already holding.

That read is **polled**, not taken once, and so is `clasp list-versions`. Both endpoints lag a write by a few seconds and answer with the *previous* state: the deployments endpoint describes the redirect as it was before the update, and the version list names the previous version — a real, plausible number, which a single read would redeploy to. The script waits for each to move past what existed before it wrote.

If it ever does fail:

> Apps Script editor → Deploy → Manage deployments → pencil → set **Who has access**, and Version: **New version**.

Update in place. Never *New deployment*.

## What is not automated

`clasp deploy` (create-deployment) is never called, and `scripts/deploy.test.mjs` fails if it appears in the script. Without `-i` it mints a **new** deploymentId and a new URL, which breaks the redirect Enable Banking has registered.

Recreating the deployment is a one-time human operation, so it is written down rather than built:

1. Apps Script editor → Deploy → **New deployment** → Web app.
2. Set **Execute as: Me** and **Who has access: Anyone**.
3. Copy the new deployment id into `.deploy.json`.
4. Register the new `/exec` URL with Enable Banking as the redirect URI, or consent will fail on the round trip back.

## `.deploy.json`

Gitignored — it names this book's deployment, not the project's. Copy `.deploy.example.json` and fill in the id from `npx clasp list-deployments`.

`lastDeploy` is written by the script. `commit` is how it knows which files changed since; `version` is the version the redirect was left on. Delete it to make the next run treat everything as changed.

A `.deploy.json` that still lists `doors` is refused before anything is pushed: replace the list with the bank door's `deploymentId` and `description`.

## Options

| | |
|---|---|
| `--dry-run` | print the plan, change nothing |
| `--force` | version and redeploy even though nothing a version carries changed |
| `--push-only` | push and stop |
| `--skip-tests` | push code no suite has seen. Says so, loudly |
| `--user <name>` | a named `clasp login` credential, if you have more than one |
