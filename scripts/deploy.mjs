/**
 * scripts/deploy.mjs — push the code, cut a version, and move the consent
 * redirect onto it *in place*.
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
 * The project has one deployment: the redirect Enable Banking sends a browser
 * to after consent. It serves a frozen version, which is why 2 and 3 exist at
 * all — and `doGet` reaches across the project from there: the session
 * exchange in `02_api.gs`, the accounts in `06_accounts.gs`, the sheet
 * primitives in `03_sheets.gs`. A fix to any of them that is only pushed is a
 * fix the sheet has and the redirect does not, so any `.gs` is versioned.
 *
 * `clasp deploy` (create-deployment) is deliberately never called here, and
 * `deploy.test.mjs` fails if it ever appears. Without `-i` it mints a *new*
 * deploymentId and a new URL, which breaks the redirect Enable Banking has
 * registered. Recreating the deployment is a one-time human operation and is
 * written down in docs/DEPLOY.md instead.
 *
 * ---
 *
 * **The access setting rides on the manifest.** A deployment's "Who has
 * access" lives on its entry point, and the Apps Script API treats entryPoints
 * as output-only: `deployments.update` — which is what `clasp
 * update-deployment` calls — drops the entry point and rebuilds it from the
 * version's manifest. So access cannot be set through the API, and a redeploy
 * does not preserve what the deployment already carried: it takes whatever
 * `webapp.access` the committed manifest says. That is `ANYONE_ANONYMOUS`, and
 * it has to be — the bank sends the browser here with nobody signed in. The
 * run refuses to start if the manifest says otherwise.
 *
 * Every run then reads the deployment back from the API and fails loudly if it
 * is not on the version just cut with the access it must have. Checked every
 * time beats reasoned about once, and `clasp list-deployments` cannot show it —
 * the access lives on the entry point, which clasp does not print, so the check
 * goes to the REST API directly.
 *
 * **Both reads are polled, because both endpoints answer a write with the state
 * from before it.** The deployments endpoint lags a redeploy by a few seconds
 * and describes the deployment as it *was*, so a check that trusts the first
 * answer validates the old access against the new version. `clasp
 * list-versions` lags the same way, and its stale answer is worse: not an
 * error, but the previous version — a real, plausible number — so a single read
 * redeploys to the version before this one. Each is polled against a floor it
 * must rise above.
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

/** What the consent redirect must serve as: "Anyone", signed in or not. */
export const REDIRECT_ACCESS = 'ANYONE_ANONYMOUS';

/**
 * How long to let an endpoint catch up before believing it.
 *
 * Fifteen tries two seconds apart. The lag observed in practice is a few
 * seconds; the ceiling is generous because the cost of waiting too long is a
 * slow deploy and the cost of not waiting long enough is a check made against
 * the state from before the write.
 */
const SETTLE_ATTEMPTS = 15;
const SETTLE_DELAY_MS = 2000;

/**
 * What forces a redeploy, as opposed to being live the moment it is pushed:
 * every file a version carries — the manifest and **every** `.gs`, because the
 * redirect serves every public function at its frozen version.
 *
 * Computed rather than remembered, because remembering is exactly the step
 * that gets skipped at the end of a long change. A conservative answer costs a
 * version; the other direction costs a redirect serving code the repo no
 * longer contains.
 */
const VERSIONED = [/^src\/[^/]+\.gs$/, /^src\/appsscript\.json$/];

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
 * `src/09_sync.gs` arrives as `rc/09_sync.gs` — which matches no pattern, so
 * the file that most needs a redeploy is the one that silently does not get
 * one. Only the first line is affected, which is worse: it depends on what
 * else you happened to edit.
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

/**
 * `.deploy.json`, or the reason it cannot be used.
 *
 * Pure, so the refusal of a file still listing two deployments has a test.
 * The second one is the Apps Script viewer's, which this code no longer
 * serves: redeploying it would put a viewer with no page behind the owner's
 * home-screen icon, and leaving it untouched leaves a frozen one there, still
 * answering and still writing. Archiving it is the only right answer, and it
 * is a human's — so the refusal says so rather than doing it.
 */
export function configProblem(config) {
  if (Array.isArray(config.doors)) {
    return '.deploy.json lists deployments under "doors". There is one now:\n' +
      '  1. Archive the app deployment (access "Only myself") in Deploy → Manage\n' +
      '     deployments. Left live, it goes on serving and writing from a frozen\n' +
      '     version whose ledger cache nothing invalidates any more.\n' +
      '  2. Replace "doors" with the consent redirect\'s own "deploymentId" and\n' +
      '     "description" — see .deploy.example.json.';
  }
  for (const field of ['deploymentId', 'description']) {
    if (!config[field]) return `.deploy.json is missing "${field}".`;
  }
  return null;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    fail(
      '.deploy.json is missing. Copy .deploy.example.json to .deploy.json and fill in\n' +
        '  the deployment id from `npx clasp list-deployments`.'
    );
  }
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  const problem = configProblem(config);
  if (problem) fail(problem);
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

/** The access the manifest will rebuild the entry point with. */
export function manifestAccess(source) {
  return JSON.parse(source).webapp?.access ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Everything under src/ that differs from the last deploy: committed changes
 * since that commit, plus whatever is uncommitted right now. Both halves
 * matter — a push sends the working tree, so uncommitted edits are as deployed
 * as committed ones.
 *
 * No recorded commit means the answer is unknown, and unknown redeploys.
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

export function isVersioned(files) {
  return files.some((file) => VERSIONED.some((pattern) => pattern.test(file)));
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
      url: entry?.webApp?.url || ''
    };
  });
}

function describe(config, live) {
  const version = live?.versionNumber ? `@${live.versionNumber}` : '@HEAD';
  return `${config.description} ${version} ${live?.access || 'unknown'}`;
}

/**
 * The point of the whole file: the redirect, named, with what is wrong with it.
 *
 * `expectedVersion` null checks the access alone — the state before a run.
 */
export function checkRedirect(config, live, expectedVersion) {
  const found = live.find((deployment) => deployment.deploymentId === config.deploymentId);
  if (!found) return [`deployment ${config.deploymentId} no longer exists.`];

  const problems = [];
  if (found.access !== REDIRECT_ACCESS) {
    problems.push(
      `${config.description} is serving as "${ACCESS_HELP[found.access] || found.access}" and must be ` +
        `"${ACCESS_HELP[REDIRECT_ACCESS]}" — the bank sends the browser here with nobody signed in.`
    );
  }
  if (expectedVersion !== null && found.versionNumber !== expectedVersion) {
    problems.push(`${config.description} is on version ${found.versionNumber ?? 'HEAD'}, expected ${expectedVersion}.`);
  }
  return problems;
}

/**
 * The deployment list, once the redirect reports the version it was just given.
 *
 * Returns whatever the last attempt saw if it never does, so the caller fails
 * on the version mismatch rather than on a timeout — a deployment genuinely
 * left behind and one the API is slow to describe read the same here, and only
 * the check has the standing to say which.
 */
async function settledDeployments(id, token, config, expectedVersion) {
  let live = [];
  for (let attempt = 1; attempt <= SETTLE_ATTEMPTS; attempt++) {
    live = await readDeployments(id, token);
    const found = live.find((deployment) => deployment.deploymentId === config.deploymentId);
    if (found && found.versionNumber === expectedVersion) return live;
    if (attempt < SETTLE_ATTEMPTS) {
      console.log(`    still the old answer — retrying (${attempt}/${SETTLE_ATTEMPTS})`);
      await sleep(SETTLE_DELAY_MS);
    }
  }
  return live;
}

export function parseArgs(argv) {
  const options = { dryRun: false, skipTests: false, pushOnly: false, force: false, user: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--push-only') options.pushOnly = true;
    else if (arg === '--force') options.force = true;
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
 * list rather than scraped — and that list lags the write. Its stale answer is
 * the previous version, a real and plausible number, so reading it once
 * redeploys to the version before this one. Observed: version 44 was created
 * and never used, because the list still said 43.
 *
 * Failing after the retries is the right end: no redeploy at all is a deploy
 * that visibly did not finish.
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
    '  Redeploying to a version this run did not create would serve older code,\n' +
    '  so nothing was redeployed. Check `npx clasp list-versions` and re-run.'
  );
}

function verify(config, live, expectedVersion) {
  const problems = checkRedirect(config, live, expectedVersion);
  if (problems.length === 0) return;

  console.error('\n✗ Deployment check failed:');
  for (const problem of problems) console.error(`    - ${problem}`);
  console.error(
    '\n  Repair in the Apps Script editor — Deploy -> Manage deployments -> pencil:\n' +
      '    set "Who has access", and Version: New version. Update in place; a new\n' +
      '    deployment mints a different URL and breaks the bank\'s redirect.\n'
  );
  process.exit(1);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const id = scriptId();

  const access = existsSync(MANIFEST_PATH) ? manifestAccess(readFileSync(MANIFEST_PATH, 'utf8')) : null;
  if (access !== REDIRECT_ACCESS) {
    fail(`src/appsscript.json says webapp.access "${access}". A redeploy rebuilds the redirect's\n` +
      `  access from it, and the redirect must be "${REDIRECT_ACCESS}".`);
  }

  const token = await accessToken(options.user);
  const before = await readDeployments(id, token);
  const current = before.find((deployment) => deployment.deploymentId === config.deploymentId);

  step('As deployed now');
  console.log(`    ${describe(config, current)}`);

  const changed = changedFiles(config.lastDeploy?.commit);
  const needsRedeploy = options.force || changed === null || isVersioned(changed);

  step('What changed under src/');
  if (changed === null) console.log('    unknown (no recorded deploy) — assuming a redeploy is needed');
  else if (changed.length === 0) console.log('    nothing since the last deploy');
  else for (const file of changed) console.log(`    ${file}`);

  if (options.dryRun) {
    step('Dry run — nothing was pushed, versioned or redeployed');
    console.log('    would push:      yes');
    console.log(`    would redeploy:  ${needsRedeploy ? `${config.description} -> push -> version -> redeploy` : 'no — nothing a version carries changed'}`);
    return;
  }

  if (!options.skipTests) {
    step('npm test');
    run(['vitest', 'run']);
  } else {
    console.log('\n  ! --skip-tests: pushing code no suite has seen.');
  }

  step('clasp push --force');
  run(['clasp', 'push', '--force']);

  if (options.pushOnly || !needsRedeploy) {
    const reason = options.pushOnly ? '--push-only' : 'nothing a version carries changed';
    step(`Pushed. No redeploy (${reason}).`);
    console.log('    The Sheet runs at HEAD, so menu items, dialogs and triggers are live now.');
    console.log(`    The redirect stays on @${current?.versionNumber ?? 'HEAD'}.`);
    return;
  }

  const commit = git(['rev-parse', 'HEAD']);
  const subject = git(['log', '-1', '--format=%s']) || 'deploy';
  const floor = newestVersion(JSON.parse(run(['clasp', 'list-versions', '--json'], { capture: true })));

  const message = `${commit.slice(0, 7)} ${subject}`;
  step(`clasp create-version "${message}"`);
  const version = await createVersion(message, floor);
  console.log(`    version ${version}`);

  step(`clasp redeploy -> version ${version}`);
  run(['clasp', 'update-deployment', '-V', String(version), '-d', config.description, config.deploymentId]);

  step('Reading the deployment back from the Apps Script API');
  const after = await settledDeployments(id, token, config, version);
  verify(config, after, version);

  const live = after.find((deployment) => deployment.deploymentId === config.deploymentId);
  console.log(`    ✓ ${describe(config, live)}`);
  console.log(`      ${live.url}`);

  config.lastDeploy = { commit, version, at: new Date().toISOString() };
  saveConfig(config);
  step(`Deployed @${version}.`);
}

// Imported by deploy.test.mjs for the functions worth exercising, so the CLI
// half only runs when this file *is* the command.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
