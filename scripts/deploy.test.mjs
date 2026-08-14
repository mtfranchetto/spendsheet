/**
 * The deploy script has one job a test can hold it to: never open the app door.
 *
 * Two failure modes, and neither one is loud on its own. `clasp deploy` without
 * `-i` mints a new URL — the app keeps working for whoever runs the command, so
 * the only symptom is a home-screen icon that stopped working and a consent
 * redirect Enable Banking no longer recognises. And a door whose access came
 * back as ANYONE_ANONYMOUS looks *identical* from the owner's phone to one that
 * did not, because the owner is allowed either way.
 *
 * So: the create-deployment command must not appear in the script, the checker
 * must actually go red on a door that came back public, and .deploy.json must
 * stay out of a public repository.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDoors, isWebFacing, manifestWithAccess, parseArgs, porcelainPaths, ACCESS_HELP } from './deploy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const script = readFileSync(join(HERE, 'deploy.mjs'), 'utf8');
const manifestSource = readFileSync(join(ROOT, 'src', 'appsscript.json'), 'utf8');

const DOORS = [
  { key: 'bank', deploymentId: 'bank-id', description: 'Spendsheet banking', access: 'ANYONE_ANONYMOUS' },
  { key: 'app', deploymentId: 'app-id', description: 'Spendsheet viewer', access: 'MYSELF' }
];

// Adjacent versions rather than one shared number: each door is deployed from a
// manifest naming its own access, so each gets its own version cut.
const VERSIONS = { bank: 41, app: 42 };

const live = (overrides = {}) => [
  { deploymentId: 'bank-id', versionNumber: 41, access: 'ANYONE_ANONYMOUS', ...overrides.bank },
  { deploymentId: 'app-id', versionNumber: 42, access: 'MYSELF', ...overrides.app }
];

describe('the deploy script never creates a deployment', () => {
  // Read as commands, not as prose: the header explains why create-deployment
  // is absent and would trip a looser pattern. Same trap as the innerHTML rule.
  const commands = [...script.matchAll(/'clasp',\s*'([a-z-]+)'/g)].map((match) => match[1]);

  it('only runs clasp subcommands that keep the existing URLs', () => {
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).not.toContain('deploy');
    expect(commands).not.toContain('create-deployment');
    expect(commands).not.toContain('delete-deployment');
    expect(commands).not.toContain('undeploy');
  });

  it('updates deployments in place', () => {
    expect(commands).toContain('update-deployment');
  });
});

describe('checkDoors', () => {
  it('passes when each door is on its own new version with the access it declares', () => {
    expect(checkDoors(DOORS, live(), VERSIONS).problems).toEqual([]);
  });

  it('fails, and names the door, when the private door came back public', () => {
    const result = checkDoors(DOORS, live({ app: { access: 'ANYONE_ANONYMOUS' } }), VERSIONS);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('Spendsheet viewer');
    expect(result.problems[0]).toContain('Only myself');
    expect(result.opened).toBe(DOORS[1]);
  });

  it('does not call a public bank door an incident — that one is meant to be open', () => {
    const result = checkDoors(DOORS, live(), VERSIONS);
    expect(result.opened).toBeNull();
  });

  it('fails when a redeploy left a door on its old version', () => {
    const result = checkDoors(DOORS, live({ bank: { versionNumber: 39 } }), VERSIONS);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('version 39');
    expect(result.opened).toBeNull();
  });

  // The doors legitimately sit on different versions now, so a checker that
  // still compared both against one number would call every healthy deploy a
  // failure — and the version half is what the access half is sequenced behind.
  it('holds each door to its own version, not to a shared one', () => {
    expect(checkDoors(DOORS, live(), { bank: 41, app: 42 }).problems).toEqual([]);
    const swapped = checkDoors(DOORS, live(), { bank: 42, app: 41 });
    expect(swapped.problems).toHaveLength(2);
  });

  it('fails when a deployment id no longer resolves', () => {
    const result = checkDoors(DOORS, [live()[0]], VERSIONS);
    expect(result.problems[0]).toContain('no longer exists');
  });

  it('has help text for every access value it might have to print', () => {
    expect(ACCESS_HELP.MYSELF).toBe('Only myself');
    expect(ACCESS_HELP.ANYONE_ANONYMOUS).toBe('Anyone');
  });
});

/**
 * The manifest rewrite is the mechanism the access setting now rides on, and it
 * happens against a tracked file. Two things can go wrong: it sets the wrong
 * access, which the read-back catches; or it sets the right access and quietly
 * drops something else, which nothing catches until a scope is missing at the
 * moment of the call.
 */
describe('manifestWithAccess', () => {
  it('sets the access the door asked for', () => {
    expect(JSON.parse(manifestWithAccess(manifestSource, 'MYSELF')).webapp.access).toBe('MYSELF');
    expect(JSON.parse(manifestWithAccess(manifestSource, 'ANYONE_ANONYMOUS')).webapp.access).toBe('ANYONE_ANONYMOUS');
  });

  it('changes that one field and nothing else', () => {
    const before = JSON.parse(manifestSource);
    const after = JSON.parse(manifestWithAccess(manifestSource, 'MYSELF'));
    expect(after).toEqual({ ...before, webapp: { ...before.webapp, access: 'MYSELF' } });
  });

  it('keeps executeAs, every oauthScope and the Drive advanced service', () => {
    const before = JSON.parse(manifestSource);
    const after = JSON.parse(manifestWithAccess(manifestSource, 'MYSELF'));
    expect(after.webapp.executeAs).toBe(before.webapp.executeAs);
    expect(after.oauthScopes).toEqual(before.oauthScopes);
    expect(after.oauthScopes.length).toBeGreaterThan(0);
    expect(after.dependencies.enabledAdvancedServices).toEqual(before.dependencies.enabledAdvancedServices);
  });

  it('round-trips back to the committed file, which is what restoring relies on', () => {
    const committed = JSON.parse(manifestSource).webapp.access;
    expect(JSON.parse(manifestWithAccess(manifestWithAccess(manifestSource, 'MYSELF'), committed))).toEqual(
      JSON.parse(manifestSource)
    );
  });
});

describe('the manifest restore', () => {
  // process.exit skips both a finally and a signal handler, and fail() is how
  // most of this script stops. Losing the exit hook would leave a rewritten
  // manifest in the working tree for the next commit to pick up.
  it('is wired to process exit, not only to the finally', () => {
    expect(script).toContain("process.on('exit', restoreManifest)");
    expect(script).toMatch(/finally\s*\{\s*restoreManifest\(\);/);
  });

  it('leaves the committed manifest on the bank door setting', () => {
    // What a manual "New deployment" from a fresh clone would inherit, and what
    // the closing push puts HEAD back onto.
    expect(JSON.parse(manifestSource).webapp.access).toBe('ANYONE_ANONYMOUS');
  });
});

describe('isWebFacing', () => {
  const noDoGet = () => '';

  it('is true for the page and its partials', () => {
    expect(isWebFacing(['src/page.html'], noDoGet)).toBe(true);
    expect(isWebFacing(['src/page.records.html'], noDoGet)).toBe(true);
  });

  it('is true for the web app files, 20 through 23', () => {
    expect(isWebFacing(['src/20_webapp.gs'], noDoGet)).toBe(true);
    expect(isWebFacing(['src/23_api.gs'], noDoGet)).toBe(true);
  });

  it('is true for the manifest, because a version carries it', () => {
    expect(isWebFacing(['src/appsscript.json'], noDoGet)).toBe(true);
  });

  it('is true for whichever file defines doGet, wherever it moves to', () => {
    expect(isWebFacing(['src/05_auth.gs'], () => 'function doGet(e) {')).toBe(true);
    expect(isWebFacing(['src/05_auth.gs'], noDoGet)).toBe(false);
  });

  it('is false for the sheet half, which runs at HEAD and is live on push', () => {
    expect(isWebFacing(['src/09_sync.gs', 'src/19_menu.gs'], noDoGet)).toBe(false);
    expect(isWebFacing([], noDoGet)).toBe(false);
  });

  it('finds doGet where it actually lives today', () => {
    // Not a tautology with the injected cases above: this one reads src/ and
    // fails if doGet moves into a file the pattern list does not already cover
    // and the reader stops finding it.
    expect(isWebFacing(['src/05_auth.gs'])).toBe(true);
  });
});

describe('porcelainPaths', () => {
  // The first column of an unstaged modification is a space, so anything that
  // trims the output shifts line one left and a fixed slice eats the first
  // letter of the path. It cost a redeploy of a changed page partial once: the
  // path arrived as `rc/page.records.html`, matched nothing, and the run
  // reported "nothing web-facing changed" in a perfectly confident voice.
  it('reads an unstaged modification whether or not the output was trimmed', () => {
    expect(porcelainPaths(' M src/page.records.html\n')).toEqual(['src/page.records.html']);
    expect(porcelainPaths(' M src/page.records.html\n'.trim())).toEqual(['src/page.records.html']);
  });

  it('reads the staged, untracked and deleted forms', () => {
    expect(porcelainPaths('M  src/23_api.gs\n?? src/24_new.gs\n D src/old.gs\n')).toEqual([
      'src/23_api.gs',
      'src/24_new.gs',
      'src/old.gs'
    ]);
  });

  it('takes the new path of a rename, because that is what gets pushed', () => {
    expect(porcelainPaths('R  src/page.old.html -> src/page.new.html\n')).toEqual(['src/page.new.html']);
  });

  it('is empty on a clean tree', () => {
    expect(porcelainPaths('')).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('defaults to a full deploy of every door', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, skipTests: false, pushOnly: false, force: false, door: null, user: 'default' });
  });

  it('takes a door either way round', () => {
    expect(parseArgs(['--door=app']).door).toBe('app');
    expect(parseArgs(['--door', 'app']).door).toBe('app');
  });
});

describe('the repository', () => {
  it('keeps .deploy.json out of git — the app door URL is the outer lock', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
    expect(gitignore).toContain('.deploy.json');
  });

  it('ships an example whose app door is private', () => {
    const example = JSON.parse(readFileSync(join(ROOT, '.deploy.example.json'), 'utf8'));
    const app = example.doors.find((door) => door.key === 'app');
    expect(app.access).toBe('MYSELF');
    for (const door of example.doors) expect(ACCESS_HELP[door.access]).toBeTruthy();
  });

  it('is reachable as npm run deploy', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.deploy).toBe('node scripts/deploy.mjs');
  });
});
