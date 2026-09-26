/**
 * scripts/deploy.mjs — push the code, cut a version, and move the two doors
 * onto it *in place*.
 *
 * Three things clasp touches and they are not the same thing:
 *
 *   1. Content. `clasp push` overwrites the project's working copy (HEAD).
 *      Nothing else changes — no version, no URL. Everything reached from the
 *      Sheet runs at HEAD, so a menu item or a trigger picks a push up at once.
 *   2. A version. `clasp version` freezes current HEAD — *including
 *      appsscript.json* — as immutable version N.
 *   3. A deployment. A URL pinned to one version. `clasp redeploy <id> -V N`
 *      is the "Manage deployments -> pencil -> Version: New version" flow, and
 *      it keeps the URL.
 *
 * A live /exec serves a frozen version, which is why 2 and 3 exist at all: a
 * push alone leaves the app on whatever it was deployed at, and the sheet half
 * of a feature goes live while the phone half does not.
 *
 * `clasp deploy` (create-deployment) is deliberately never called here, and
 * `deploy.test.mjs` fails if it ever appears. Without `-i` it mints a
 * *new* deploymentId and a new URL: on the bank door that breaks the redirect
 * Enable Banking has registered, and on the app door it points the home-screen
 * icon at nothing. Recreating a door is a one-time human operation and is
 * written down in docs/DEPLOY.md instead.
 *
 * ---
 *
 * The reason this file is more than three `clasp` calls in a row is the access
 * setting, and it is worth stating exactly.
 *
 * A deployment's "Who has access" lives on its *entry point*, and the Apps
 * Script API treats entryPoints as output-only: `deployments.update` — which is
 * what `clasp update-deployment` calls — drops the entry point and rebuilds it
 * from the manifest. So access cannot be set through the API at all, and a
 * redeploy does not preserve the setting a deployment already carried. It takes
 * whatever `webapp.access` the manifest says, every time.
 *
 * That matters here because the two doors need different answers. The bank door
 * is the consent redirect and must be ANYONE_ANONYMOUS: Enable Banking sends a
 * browser to it with nobody signed in. The app door serves this book's balances
 * and must be MYSELF. One manifest cannot say both, so a single shared version
 * cannot deploy both doors correctly — it lands whichever access the manifest
 * happened to hold on *both* of them, and the direction that costs something is
 * the app door coming back public with only requireOwner_ between a stranger
 * and the balances.
 *
 * So each door gets its own manifest value and its own version:
 *
 *     write webapp.access = <the door's access>  ->  push  ->  create-version N
 *       ->  update-deployment <door> -V N
 *
 * once per door. The code in both versions is identical — they differ in one
 * manifest field and in nothing else, which is why the doors sitting on
 * adjacent version numbers is not the skew this script exists to prevent.
 *
 * Writing the manifest immediately before cutting the version is also what
 * makes this independent of a question the documentation does not settle:
 * whether the rebuilt entry point reads the *version's* manifest or HEAD's at
 * the moment of the update. Sequenced this way they are the same file, so both
 * answers give the same result and neither one has to be established.
 *
 * src/appsscript.json is tracked, so it is captured before the first write and
 * restored afterwards — from an `exit` hook as well as a `finally`, because
 * `fail()` leaves through `process.exit` and would otherwise strand a mutated
 * manifest in the working tree for the next commit to sweep up. A closing push
 * puts HEAD back on the repository's own manifest, so what git holds and what
 * the Apps Script editor shows agree once a deploy has finished.
 *
 * Every run then reads both doors back from the API and fails loudly if either
 * is not what .deploy.json says it must be. Checked every time beats reasoned
 * about once, and `clasp list-deployments` cannot show it — the access setting
 * lives on the entry point, which clasp does not print, so the check goes to
 * the REST API directly.
 *
 * That read is polled rather than taken once. The deployments endpoint lags a
 * redeploy by a few seconds and answers with the *previous* state, which is not
 * a harmless delay: the record it returns describes the door as it was before
 * the update, so a check that trusts the first answer reads the old access off
 * a door it never actually looked at, and reports on a version that is not the
 * one it just deployed. It waits for each door to report the version it was
 * given, and only then asks what access came back with it.
 *
 * The credential for that is the refresh token in ~/.clasprc.json — the one
 * clasp itself uses, already carrying the deployments scope. No second login,
 * and nothing new to keep secret.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(ROOT, '.deploy.json');
const CLASP_PATH = join(ROOT, '.clasp.json');
const MANIFEST_PATH = join(ROOT, 'src', 'appsscript.json');

/**
 * How long to let the deployments endpoint catch up before believing it.
 *
 * Fifteen tries two seconds apart. The lag observed in practice is a few
 * seconds; the ceiling is generous because the cost of waiting too long is a
 * slow deploy and the cost of not waiting long enough is asserting the access
 * setting against a door as it was before the redeploy.
 */
const SETTLE_ATTEMPTS = 15;
const SETTLE_DELAY_MS = 2000;

/**
 * What forces a redeploy, as opposed to being live the moment it is pushed.
 *
 * Every file a version carries: the page, the manifest, and **every** `.gs`.
 * A menu click or a trigger runs at HEAD, so for those a push is enough. But a
 * door runs a frozen copy of the whole project, not only of 20-23, and two
 * things follow from that.
 *
 * Door 1 is served to anyone with the `google.script.run` bridge attached, so
 * every public function in every file is on its surface *at the version it
 * serves*. A gate added in `09_sync.gs` and pushed is a gate the bank door
 * does not have, and nothing reports the difference. And Door 2's API calls
 * into 03-17 for every number it shows, so a fix there is live on the sheet
 * and stale on the phone.
 *
 * Computed rather than remembered, because remembering is exactly the step
 * that gets skipped at the end of a long change. A conservative answer costs
 * a version per door; the other direction costs a door serving code the repo
 * no longer contains.
 */
const WEB_FACING = [/^src\/page.*\.html$/, /^src\/[^/]+\.gs$/, /^src\/appsscript\.json$/];
const PAGE_FILE = /^src\/page.*\.html$/;

export const ACCESS_HELP = {
  MYSELF: 'Only myself',
  ANYONE_ANONYMOUS: 'Anyone',
  ANYONE: 'Anyone with a Google account',
  DOMAIN: 'Anyone within the domain'
};

function fail(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function step(message) {
  console.log(`\n── ${message}`);
}

/** Inherits stdio: clasp's own output is the progress report, not a spinner. */
function run(args, { capture = false } = {}) {
  try {
    const out = execFileSync('npx', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit'
    });
    return capture ? out : '';
  } catch (e) {
    fail(`\`npx ${args.join(' ')}\` failed (exit ${e.status ?? '?'}).`);
    return '';
  }
}

/**
 * `trim` is an option rather than the behaviour, because `status --porcelain`
 * puts the status in the first two columns and an unstaged modification's
 * first column is a **space**. Trimming the output shifts line one left by a
 * character, `slice(3)` then eats the first letter of the path, and
 * `src/page.records.html` arrives as `rc/page.records.html` — which matches no
 * pattern, so the file that most needs a redeploy is the one that silently
 * does not get one. Only the first line is affected, which is worse: it
 * depends on what else you happened to edit.
 */
function git(args, { trim = true } = {}) {
  try {
    const out = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
    return trim ? out.trim() : out;
  } catch {
    return '';
  }
}

/**
 * Paths out of `git status --porcelain`, tolerant of whether anything trimmed
 * it on the way here. A rename reports "old -> new" and it is the new path
 * that gets pushed.
 */
export function porcelainPaths(output) {
  const paths = [];
  for (const line of output.split('\n')) {
    const match = /^\s*[ACDMRTU?!]{1,2}\s+(.+)$/.exec(line);
    if (!match) continue;
    const path = match[1].trim();
    paths.push(path.includes(' -> ') ? path.split(' -> ')[1] : path);
  }
  return paths;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    fail(
      '.deploy.json is missing. Copy .deploy.example.json to .deploy.json and fill in\n' +
        '  the two deployment ids from `npx clasp list-deployments`. It is gitignored:\n' +
        '  this repo is public and the app door is a private URL.'
    );
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (!Array.isArray(config.doors) || config.doors.length === 0) fail('.deploy.json declares no doors.');
  for (const door of config.doors) {
    for (const field of ['key', 'deploymentId', 'description', 'access']) {
      if (!door[field]) fail(`.deploy.json: a door is missing "${field}".`);
    }
    if (!ACCESS_HELP[door.access]) {
      fail(`.deploy.json: door "${door.key}" declares an unknown access "${door.access}".`);
    }
  }
  return config;
}

function saveConfig(config) {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

function scriptId() {
  if (!existsSync(CLASP_PATH)) fail('.clasp.json is missing — run `npx clasp clone` or restore it.');
  const id = JSON.parse(readFileSync(CLASP_PATH, 'utf8')).scriptId;
  if (!id) fail('.clasp.json has no scriptId.');
  return id;
}

/**
 * The manifest with one field changed, as text.
 *
 * Pure, and exported, because the thing worth testing is that setting the one
 * field leaves the rest of the manifest alone: a deploy that quietly dropped an
 * oauthScope or the Drive advanced service would cut a version whose snapshot
 * fails at the moment of the call, days later, with nothing pointing here.
 * Spreading over the existing `webapp` keeps executeAs rather than rewriting
 * the object around the one key this cares about.
 */
export function manifestWithAccess(source, access) {
  const manifest = JSON.parse(source);
  manifest.webapp = { ...manifest.webapp, access };
  return JSON.stringify(manifest, null, 2) + '\n';
}

/**
 * The bytes src/appsscript.json held before this run touched it, or null if it
 * has not been touched. Restoring writes these back verbatim rather than
 * re-serialising, so a deploy cannot reformat a tracked file as a side effect.
 */
let manifestOriginal = null;

function restoreManifest() {
  if (manifestOriginal === null) return;
  const original = manifestOriginal;
  // Cleared first: the exit hook and the finally both call this, and the second
  // caller must not write a file the user may have edited in between.
  manifestOriginal = null;
  writeFileSync(MANIFEST_PATH, original);
}

function setManifestAccess(access) {
  if (manifestOriginal === null) {
    if (!existsSync(MANIFEST_PATH)) fail('src/appsscript.json is missing — a version cannot be cut without it.');
    manifestOriginal = readFileSync(MANIFEST_PATH, 'utf8');

    // `fail()` exits through process.exit, which runs neither a finally nor a
    // signal handler. An exit hook is the only one of the three that sees every
    // way out of this script, and writeFileSync is synchronous, so it is
    // allowed to do real work here.
    process.on('exit', restoreManifest);
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        restoreManifest();
        process.exit(130);
      });
    }
  }
  writeFileSync(MANIFEST_PATH, manifestWithAccess(manifestOriginal, access));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything under src/ that differs from the last deploy: committed changes
 * since that commit, plus whatever is uncommitted right now. Both halves
 * matter — a push sends the working tree, so uncommitted page edits are as
 * deployed as committed ones.
 *
 * No recorded commit means the answer is unknown, and unknown redeploys. A
 * conservative wrong answer here costs one extra version; the other direction
 * costs a feature that is live on the sheet and missing on the phone.
 */
function changedFiles(lastCommit) {
  const known = lastCommit && git(['rev-parse', '--verify', '--quiet', `${lastCommit}^{commit}`]);
  if (!known) return null;

  const files = new Set();
  for (const line of git(['diff', '--name-only', lastCommit, 'HEAD', '--', 'src']).split('\n')) {
    if (line) files.add(line);
  }
  for (const path of porcelainPaths(git(['status', '--porcelain', '--', 'src'], { trim: false }))) {
    files.add(path);
  }
  return [...files];
}

export function isWebFacing(files) {
  return files.some((file) => WEB_FACING.some((pattern) => pattern.test(file)));
}

/**
 * The token clasp is already holding. `--user` names a credential set inside
 * the same file; "default" is what a plain `clasp login` writes.
 */
async function accessToken(user = 'default') {
  const candidates = [join(homedir(), '.clasprc.json'), join(homedir(), '.config', 'clasp', '.clasprc.json')];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) fail('No ~/.clasprc.json — run `npx clasp login`.');

  const tokens = JSON.parse(readFileSync(path, 'utf8')).tokens || {};
  const credential = tokens[user];
  if (!credential?.refresh_token) fail(`No stored credential for user "${user}" — run \`npx clasp login\`.`);

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credential.client_id,
      client_secret: credential.client_secret,
      refresh_token: credential.refresh_token,
      grant_type: 'refresh_token'
    })
  });
  const body = await response.json();
  if (!body.access_token) fail(`Could not refresh the clasp token (${body.error || response.status}) — try \`npx clasp login\`.`);
  return body.access_token;
}

/**
 * The deployment list with its entry points, which is the part clasp does not
 * print and the only place the access setting is readable.
 */
async function readDeployments(id, token) {
  const response = await fetch(`https://script.googleapis.com/v1/projects/${id}/deployments`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const body = await response.json();
  if (body.error) fail(`Apps Script API: ${body.error.status} — ${body.error.message}`);

  return (body.deployments || []).map((deployment) => {
    const entry = (deployment.entryPoints || []).find((point) => point.entryPointType === 'WEB_APP');
    return {
      deploymentId: deployment.deploymentId,
      versionNumber: deployment.deploymentConfig?.versionNumber ?? null,
      description: deployment.deploymentConfig?.description || '',
      access: entry?.webApp?.entryPointConfig?.access || null,
      executeAs: entry?.webApp?.entryPointConfig?.executeAs || null,
      url: entry?.webApp?.url || ''
    };
  });
}

function describe(door, live) {
  const version = live?.versionNumber ? `@${live.versionNumber}` : '@HEAD';
  return `${door.key} (${door.description}) ${version} ${live?.access || 'unknown'}`;
}

/**
 * The point of the whole file. A door that is not what .deploy.json says it is
 * gets named, along with what it must be and how to put it back — because the
 * one setting that matters here cannot be repaired from the API, only in the
 * UI, and a warning that does not say which door is a warning nobody can act
 * on at the end of a deploy.
 */
export function checkDoors(doors, live, expectedVersions) {
  const problems = [];
  let opened = null;
  for (const door of doors) {
    const found = live.find((deployment) => deployment.deploymentId === door.deploymentId);
    if (!found) {
      problems.push(`${door.key}: deployment ${door.deploymentId} no longer exists.`);
      continue;
    }
    if (found.access !== door.access) {
      problems.push(
        `${door.key} (${door.description}) is serving as "${ACCESS_HELP[found.access] || found.access}" ` +
          `and must be "${ACCESS_HELP[door.access]}".`
      );
      // A door that should be private and is not is the only problem on this
      // list that is an incident rather than an inconvenience, so it is
      // reported as itself and not as one bullet among several.
      if (door.access === 'MYSELF') opened = door;
    }
    // Keyed by door, because the doors are deployed from different manifests
    // and so land on different versions by design.
    const expected = expectedVersions?.[door.key] ?? null;
    if (expected !== null && found.versionNumber !== expected) {
      problems.push(
        `${door.key} (${door.description}) is on version ${found.versionNumber ?? 'HEAD'}, expected ${expected}.`
      );
    }
  }
  return { problems, opened };
}

/**
 * The deployment list, once every door reports the version it was just given.
 *
 * Returns whatever the last attempt saw if they never agree, so the caller
 * fails on the version mismatch rather than on a timeout — a door genuinely
 * left behind and a door the API is slow to describe read the same here, and
 * only the check has the standing to say which.
 */
async function settledDeployments(id, token, doors, expectedVersions) {
  let live = [];
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    live = await readDeployments(id, token);
    const pending = doors.filter((door) => {
      const found = live.find((deployment) => deployment.deploymentId === door.deploymentId);
      return !found || found.versionNumber !== expectedVersions[door.key];
    });
    if (pending.length === 0) return live;
    if (attempt < SETTLE_ATTEMPTS) {
      console.log(`    still the old answer for ${pending.map((door) => door.key).join(', ')} — retrying (${attempt}/${SETTLE_ATTEMPTS})`);
      await sleep(SETTLE_DELAY_MS);
    }
  }
  return live;
}

function verify(doors, live, expectedVersions) {
  const { problems, opened } = checkDoors(doors, live, expectedVersions);
  if (problems.length === 0) return;

  console.error('\n✗ Deployment check failed:');
  for (const problem of problems) console.error(`    - ${problem}`);
  if (opened) {
    console.error(
      `\n  ⚠ "${opened.description}" serves this book's balances. Until its access is\n` +
        '    "Only myself" again, anyone holding the URL can load it.'
    );
  }
  console.error(
    '\n  Repair in the Apps Script editor — Deploy -> Manage deployments -> pencil:\n' +
      '    set "Who has access", and Version: New version. Update in place; a new\n' +
      '    deployment mints a different URL and breaks the door.\n'
  );
  // The access this run deployed came from the manifest it wrote, so a door
  // that came back wrong means that mechanism did not hold — the manual repair
  // above closes the door, and the next `npm run deploy` would undo it again.
  if (opened) {
    console.error(
      '  Then treat this as a bug in the deploy, not a one-off: the access came\n' +
        '  from the manifest this run wrote, so a wrong answer here will repeat.\n'
    );
  }
  process.exit(1);
}

export function parseArgs(argv) {
  const options = { dryRun: false, skipTests: false, pushOnly: false, force: false, door: null, user: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--push-only') options.pushOnly = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--door') options.door = argv[++i];
    else if (arg.startsWith('--door=')) options.door = arg.slice('--door='.length);
    else if (arg === '--user') options.user = argv[++i];
    else if (arg.startsWith('--user=')) options.user = arg.slice('--user='.length);
    else fail(`Unknown option "${arg}". See docs/DEPLOY.md.`);
  }
  return options;
}

/** The highest version number in what `clasp list-versions` returned. */
export function newestVersion(list) {
  return (list || []).reduce((max, version) => Math.max(max, version.versionNumber || 0), 0);
}

/**
 * That number, but only if it is one this call could have produced.
 *
 * `floor` is the highest version that existed *before* `clasp create-version`
 * ran, so anything at or below it is the list answering from before the write.
 * Null means "ask again", which is the answer a single read cannot give.
 */
export function settledVersion(list, floor) {
  const latest = newestVersion(list);
  return latest > floor ? latest : null;
}

/**
 * Create a version and return its number, once the list admits it exists.
 *
 * clasp prints the number in prose, so it has to be read back from the version
 * list rather than scraped — and **that list lags the write**, exactly like the
 * deployments endpoint `settledDeployments` polls. This is the same lesson at a
 * second endpoint, and it cost a live incident before it was learned twice.
 *
 * A single read is what makes it dangerous rather than flaky. The stale answer
 * is not an error or an empty list: it is the *previous* version — a real
 * number, and a plausible one. The caller then redeploys its door to whatever
 * the door before it got, so both doors end up serving the first door's
 * manifest. On the app door that manifest says `ANYONE_ANONYMOUS`, so the
 * failure lands as a public door, silently, on the one door where being wrong
 * costs something. Observed: version 44 was created for the app door and never
 * used, because the list still said 43.
 *
 * Failing after the retries is the right end. A door left on the previous
 * door's version is the incident this whole file exists to prevent, and no
 * version at all is a deploy that visibly did not finish.
 */
async function createVersion(message, floor) {
  run(['clasp', 'create-version', message]);

  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    const listed = JSON.parse(run(['clasp', 'list-versions', '--json'], { capture: true }));
    const settled = settledVersion(listed, floor);
    if (settled !== null) return settled;

    if (attempt < SETTLE_ATTEMPTS) {
      console.log(`    version list still says ${newestVersion(listed)} — retrying (${attempt}/${SETTLE_ATTEMPTS})`);
      await sleep(SETTLE_DELAY_MS);
    }
  }

  fail(
    `Created a version but the list never reported one above ${floor}.\n` +
    '  Deploying a door to a version this run did not create would point it at\n' +
    '  the previous door\'s manifest, so nothing was redeployed. Check\n' +
    '  `npx clasp list-versions` and re-run.'
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const id = scriptId();

  const doors = options.door ? config.doors.filter((door) => door.key === options.door) : config.doors;
  if (doors.length === 0) fail(`No door named "${options.door}" in .deploy.json.`);

  const token = await accessToken(options.user);
  const before = await readDeployments(id, token);

  step('Doors as deployed now');
  for (const door of config.doors) console.log(`    ${describe(door, before.find((d) => d.deploymentId === door.deploymentId))}`);

  const changed = changedFiles(config.lastDeploy?.commit);
  const needsRedeploy = options.force || changed === null || isWebFacing(changed);
  const needsE2e = changed === null || changed.some((file) => PAGE_FILE.test(file));

  step('What changed under src/');
  if (changed === null) console.log('    unknown (no recorded deploy) — assuming a redeploy is needed');
  else if (changed.length === 0) console.log('    nothing since the last deploy');
  else for (const file of changed) console.log(`    ${file}`);

  if (options.dryRun) {
    step('Dry run — nothing was pushed, versioned or redeployed');
    console.log(`    would push:      yes`);
    console.log(`    would run e2e:   ${needsE2e ? 'yes (src/page*.html changed)' : 'no'}`);
    console.log(`    would redeploy:  ${needsRedeploy ? doors.map((d) => d.key).join(', ') : 'no — nothing web-facing changed'}`);
    if (needsRedeploy) {
      // Named per door because the version count and the manifest rewrite are
      // the two things about this sequence that surprise on a first reading.
      for (const door of doors) {
        console.log(`      ${door.key}: webapp.access = ${door.access} ("${ACCESS_HELP[door.access]}") -> push -> version -> redeploy`);
      }
      console.log(`    src/appsscript.json is rewritten per door and restored afterwards.`);
    }
    return;
  }

  if (!options.skipTests) {
    step('npm test');
    run(['vitest', 'run']);
    if (needsE2e) {
      step('npm run test:e2e (src/page*.html changed)');
      run(['playwright', 'test']);
    }
  } else {
    console.log('\n  ! --skip-tests: pushing code no suite has seen.');
  }

  if (options.pushOnly || !needsRedeploy) {
    step('clasp push --force');
    run(['clasp', 'push', '--force']);

    const reason = options.pushOnly ? '--push-only' : 'nothing web-facing changed';
    step(`Pushed. No redeploy (${reason}).`);
    console.log('    The Sheet runs at HEAD, so menu items, dialogs and triggers are live now.');
    console.log(`    The doors stay on the version they were: ${config.doors
      .map((door) => `${door.key} @${before.find((d) => d.deploymentId === door.deploymentId)?.versionNumber ?? 'HEAD'}`)
      .join(', ')}.`);
    return;
  }

  const commit = git(['rev-parse', 'HEAD']);
  const subject = git(['log', '-1', '--format=%s']) || 'deploy';
  const versions = {};

  // What existed before this run wrote anything. Every version created below
  // has to come back above it, and above whatever the door before it got — a
  // door deployed to a number this loop did not just create is a door serving
  // the previous door's manifest.
  let floor = newestVersion(JSON.parse(run(['clasp', 'list-versions', '--json'], { capture: true })));

  try {
    // One pass per door: the manifest states that door's access, the version
    // freezes it, and the redeploy rebuilds the entry point from it. Pushing
    // inside the loop is what makes the version carry the right manifest, so
    // there is no separate push before this — the first pass performs it.
    for (const door of doors) {
      step(`${door.key}: webapp.access = ${door.access} ("${ACCESS_HELP[door.access]}")`);
      setManifestAccess(door.access);
      run(['clasp', 'push', '--force']);

      const message = `${commit.slice(0, 7)} ${subject} [${door.key}]`;
      step(`clasp create-version "${message}"`);
      versions[door.key] = await createVersion(message, floor);
      floor = versions[door.key];
      console.log(`    version ${versions[door.key]}`);

      step(`clasp redeploy ${door.key} -> version ${versions[door.key]}`);
      run(['clasp', 'update-deployment', '-V', String(versions[door.key]), '-d', door.description, door.deploymentId]);
    }
  } finally {
    restoreManifest();
  }

  // HEAD is left on the repository's own manifest rather than on whichever door
  // happened to go last, so the Apps Script editor and git agree and a manual
  // "New deployment" inherits the committed setting rather than a leftover.
  step('clasp push --force (HEAD back onto the committed manifest)');
  run(['clasp', 'push', '--force']);

  step('Reading the doors back from the Apps Script API');
  const after = await settledDeployments(id, token, doors, versions);
  verify(doors, after, versions);

  for (const door of doors) {
    const live = after.find((deployment) => deployment.deploymentId === door.deploymentId);
    console.log(`    ✓ ${describe(door, live)}`);
    console.log(`      ${live.url}`);
  }

  config.lastDeploy = { commit, versions, at: new Date().toISOString() };
  saveConfig(config);
  step(`Deployed ${doors.map((door) => `${door.key} @${versions[door.key]}`).join(' and ')}.`);
}

// Imported by deploy.test.mjs for the two functions worth exercising, so
// the CLI half only runs when this file *is* the command.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
