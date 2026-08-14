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
 * `tests/deploy.test.mjs` fails if it ever appears. Without `-i` it mints a
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
 * A deployment's "Who has access" is per-deployment, but it is *derived from
 * the manifest of the version being deployed* when a deployment is created.
 * src/appsscript.json declares ANYONE_ANONYMOUS, which is the bank door's
 * setting; the app door was set to MYSELF in the UI and so diverges from the
 * manifest it was cut from. Whether `redeploy` re-derives access from the new
 * version's manifest or leaves the deployment's own setting alone is not
 * something the documentation answers, and the failure mode if it re-derives
 * is the one the project treats as fatal: this book's balances behind a URL
 * anyone can load, with only requireOwner_ between them and a stranger.
 *
 * So it is not assumed in either direction. Every run reads both doors back
 * from the Apps Script API afterwards and fails loudly if either one is not
 * what .deploy.json says it must be. Checked every time beats reasoned about
 * once, and `clasp list-deployments` cannot show it — the access setting lives
 * on the entry point, which clasp does not print, so the check goes to the
 * REST API directly.
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

/**
 * What forces a redeploy, as opposed to being live the moment it is pushed.
 *
 * This is CLAUDE.md's rule — "anything touching doGet, src/page.html or 20-23"
 * — computed rather than remembered, because remembering it is exactly the
 * step that gets skipped at the end of a long change. The manifest is in the
 * list because a version carries it: a scope added today is not a scope the
 * deployed app has until a version is cut with it.
 *
 * doGet is found by reading the file rather than by naming 05_auth.gs, so
 * moving it does not quietly disarm this.
 */
const WEB_FACING = [/^src\/page.*\.html$/, /^src\/2[0-3]_.*\.gs$/, /^src\/appsscript\.json$/];
const PAGE_FILE = /^src\/page.*\.html$/;
const DEFINES_DOGET = /function\s+doGet\s*\(/;

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

/**
 * `read` is injected so a test can ask about a file that is not on disk — the
 * doGet half of this rule is the half that cannot be checked by pattern, and a
 * guard nothing exercises is a guard nobody knows the state of.
 */
export function isWebFacing(files, read = (file) => (existsSync(join(ROOT, file)) ? readFileSync(join(ROOT, file), 'utf8') : '')) {
  return files.some((file) => {
    if (WEB_FACING.some((pattern) => pattern.test(file))) return true;
    if (!file.endsWith('.gs')) return false;
    return DEFINES_DOGET.test(read(file));
  });
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
export function checkDoors(doors, live, expectedVersion) {
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
    if (expectedVersion !== null && found.versionNumber !== expectedVersion) {
      problems.push(
        `${door.key} (${door.description}) is on version ${found.versionNumber ?? 'HEAD'}, expected ${expectedVersion}.`
      );
    }
  }
  return { problems, opened };
}

function verify(doors, live, expectedVersion) {
  const { problems, opened } = checkDoors(doors, live, expectedVersion);
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

/**
 * clasp prints the new version in prose, so the number is read back from the
 * version list rather than scraped: the list is authoritative whatever the
 * wording does next release.
 */
function createVersion(message) {
  run(['clasp', 'create-version', message]);
  const versions = JSON.parse(run(['clasp', 'list-versions', '--json'], { capture: true }));
  const latest = versions.reduce((max, version) => Math.max(max, version.versionNumber || 0), 0);
  if (!latest) fail('Created a version but could not read its number back.');
  return latest;
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

  step('clasp push --force');
  run(['clasp', 'push', '--force']);

  if (options.pushOnly || !needsRedeploy) {
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
  step(`clasp create-version "${commit.slice(0, 7)} ${subject}"`);
  const version = createVersion(`${commit.slice(0, 7)} ${subject}`);
  console.log(`    version ${version}`);

  // Both doors go to the same version, always. They were on 38 and 39 when
  // this script was written, which is what one door being redeployed by hand
  // looks like afterwards — and nothing about the code says the phone and the
  // consent redirect are allowed to disagree.
  for (const door of doors) {
    step(`clasp redeploy ${door.key} -> version ${version}`);
    run(['clasp', 'update-deployment', '-V', String(version), '-d', door.description, door.deploymentId]);
  }

  step('Reading both doors back from the Apps Script API');
  const after = await readDeployments(id, token);
  verify(doors, after, version);

  for (const door of doors) {
    const live = after.find((deployment) => deployment.deploymentId === door.deploymentId);
    console.log(`    ✓ ${describe(door, live)}`);
    console.log(`      ${live.url}`);
  }

  config.lastDeploy = { commit, version, at: new Date().toISOString() };
  saveConfig(config);
  step(`Deployed version ${version} to ${doors.map((door) => door.key).join(' and ')}.`);
}

// Imported by tests/deploy.test.mjs for the two functions worth exercising, so
// the CLI half only runs when this file *is* the command.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
