/**
 * The deploy script has one job a test can hold it to: never lose the bank's
 * redirect.
 *
 * Two failure modes, and neither one is loud on its own. `clasp deploy` without
 * `-i` mints a new URL — the sheet keeps working, so the only symptom is the
 * next bank connection landing on a URL Enable Banking does not recognise. And
 * a redirect whose access came back as anything but "Anyone" sends the bank's
 * browser to a Google sign-in instead of finishing the consent.
 *
 * So: the create-deployment command must not appear in the script, the checker
 * must actually go red on a redirect that came back wrong, and the manifest the
 * access is rebuilt from must say what the redirect needs.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkRedirect, configProblem, isVersioned, manifestAccess, newestVersion, parseArgs, porcelainPaths,
  settledVersion, ACCESS_HELP, REDIRECT_ACCESS
} from './deploy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const script = readFileSync(join(HERE, 'deploy.mjs'), 'utf8');
const manifestSource = readFileSync(join(ROOT, 'src', 'appsscript.json'), 'utf8');

const CONFIG = { deploymentId: 'bank-id', description: 'Spendsheet banking' };
const live = (overrides = {}) => [{ deploymentId: 'bank-id', versionNumber: 41, access: 'ANYONE_ANONYMOUS', ...overrides }];

describe('the deploy script never creates a deployment', () => {
  // Read as commands, not as prose: the header explains why create-deployment
  // is absent and would trip a looser pattern.
  const commands = [...script.matchAll(/'clasp',\s*'([a-z-]+)'/g)].map((match) => match[1]);

  it('only runs clasp subcommands that keep the existing URL', () => {
    expect(commands.length).toBeGreaterThan(0);
    expect(commands).not.toContain('deploy');
    expect(commands).not.toContain('create-deployment');
    expect(commands).not.toContain('delete-deployment');
    expect(commands).not.toContain('undeploy');
  });

  it('updates the deployment in place', () => {
    expect(commands).toContain('update-deployment');
  });
});

describe('checkRedirect', () => {
  it('passes when the redirect is on the new version and open to anyone', () => {
    expect(checkRedirect(CONFIG, live(), 41)).toEqual([]);
  });

  it('fails, and says why, when the redirect came back behind a sign-in', () => {
    const problems = checkRedirect(CONFIG, live({ access: 'MYSELF' }), 41);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('Spendsheet banking');
    expect(problems[0]).toContain('"Only myself"');
    expect(problems[0]).toContain('nobody signed in');
  });

  it('fails when a redeploy left it on its old version', () => {
    const problems = checkRedirect(CONFIG, live({ versionNumber: 39 }), 41);
    expect(problems).toEqual(['Spendsheet banking is on version 39, expected 41.']);
  });

  it('checks the access alone when no version is expected', () => {
    expect(checkRedirect(CONFIG, live({ versionNumber: 39 }), null)).toEqual([]);
  });

  it('fails when the deployment id no longer resolves', () => {
    expect(checkRedirect(CONFIG, [], 41)[0]).toContain('no longer exists');
  });

  it('has help text for every access value it might have to print', () => {
    expect(ACCESS_HELP.MYSELF).toBe('Only myself');
    expect(ACCESS_HELP[REDIRECT_ACCESS]).toBe('Anyone');
  });
});

describe('the manifest the access is rebuilt from', () => {
  it('says what the redirect needs, since a redeploy takes the access from it', () => {
    expect(manifestAccess(manifestSource)).toBe(REDIRECT_ACCESS);
  });

  it('is read, not assumed, when there is no webapp block', () => {
    expect(manifestAccess('{}')).toBeNull();
  });

  it('is checked before anything is pushed', () => {
    expect(script.indexOf('manifestAccess(readFileSync(MANIFEST_PATH')).toBeLessThan(script.indexOf("'clasp', 'push'"));
  });
});

describe('.deploy.json', () => {
  it('takes one deployment', () => {
    expect(configProblem(CONFIG)).toBeNull();
  });

  it('refuses a file still listing several, before one of them is redeployed alone', () => {
    const problem = configProblem({ doors: [{ key: 'bank' }, { key: 'app' }] });
    expect(problem).toContain('.deploy.example.json');
    // The app deployment is not merely forgotten: left live, it serves a frozen
    // viewer whose cache nothing invalidates.
    expect(problem).toMatch(/Archive the app deployment/);
  });

  it('names a missing field', () => {
    expect(configProblem({ description: 'x' })).toContain('"deploymentId"');
  });

  it('ships an example the script accepts', () => {
    const example = JSON.parse(readFileSync(join(ROOT, '.deploy.example.json'), 'utf8'));
    expect(configProblem(example)).toBeNull();
  });
});

/*
  The stale version list lags a write, like the deployments endpoint, and it is
  the one that cost something: `clasp create-version` made version 44;
  `list-versions` still said 43; 43 is a real number and a plausible one, so the
  deployment was moved to the version before. Version 44 is still there, unused.
*/
describe('reading back the version that was just created', () => {
  it('takes the highest number, not the last one listed', () => {
    expect(newestVersion([{ versionNumber: 43 }, { versionNumber: 41 }])).toBe(43);
  });

  it('is 0 on an empty list, so a project with no versions still has a floor', () => {
    expect(newestVersion([])).toBe(0);
    expect(newestVersion(undefined)).toBe(0);
  });

  it('refuses a list still answering from before the write', () => {
    expect(settledVersion([{ versionNumber: 43 }], 43)).toBe(null);
  });

  it('accepts the first number above the floor', () => {
    expect(settledVersion([{ versionNumber: 44 }, { versionNumber: 43 }], 43)).toBe(44);
  });

  it('refuses to go backwards rather than treating a short list as an answer', () => {
    expect(settledVersion([{ versionNumber: 42 }], 43)).toBe(null);
  });

  it('polls rather than reading once, like the deployments endpoint already does', () => {
    const createVersionBody = script.slice(script.indexOf('async function createVersion'));
    expect(createVersionBody.slice(0, 900)).toMatch(/SETTLE_ATTEMPTS/);
    expect(createVersionBody.slice(0, 900)).toMatch(/await sleep\(SETTLE_DELAY_MS\)/);
  });
});

describe('isVersioned', () => {
  it('is true for the manifest, because a version carries it', () => {
    expect(isVersioned(['src/appsscript.json'])).toBe(true);
  });

  it('is true for every .gs file', () => {
    // The redirect serves every public function in the project at its frozen
    // version, so a gate added to 09_sync.gs and only pushed is on the sheet
    // and missing from the redirect.
    for (const file of readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.gs'))) {
      expect(isVersioned([`src/${file}`]), file).toBe(true);
    }
  });

  it('is false when nothing a version carries changed', () => {
    expect(isVersioned([])).toBe(false);
    expect(isVersioned(['src/notes.md'])).toBe(false);
  });
});

describe('porcelainPaths', () => {
  // The first column of an unstaged modification is a space, so anything that
  // trims the output shifts line one left and a fixed slice eats the first
  // letter of the path. It cost a redeploy once: the path arrived one letter
  // short, matched nothing, and the run reported that nothing had changed in a
  // perfectly confident voice.
  it('reads an unstaged modification whether or not the output was trimmed', () => {
    expect(porcelainPaths(' M src/09_sync.gs\n')).toEqual(['src/09_sync.gs']);
    expect(porcelainPaths(' M src/09_sync.gs\n'.trim())).toEqual(['src/09_sync.gs']);
  });

  it('reads the staged, untracked and deleted forms', () => {
    expect(porcelainPaths('M  src/09_sync.gs\n?? src/24_new.gs\n D src/old.gs\n')).toEqual([
      'src/09_sync.gs',
      'src/24_new.gs',
      'src/old.gs'
    ]);
  });

  it('takes the new path of a rename, because that is what gets pushed', () => {
    expect(porcelainPaths('R  src/old.gs -> src/new.gs\n')).toEqual(['src/new.gs']);
  });

  it('is empty on a clean tree', () => {
    expect(porcelainPaths('')).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('defaults to a full deploy', () => {
    expect(parseArgs([])).toEqual({ dryRun: false, skipTests: false, pushOnly: false, force: false, user: 'default' });
  });

  it('takes a clasp user either way round', () => {
    expect(parseArgs(['--user=work']).user).toBe('work');
    expect(parseArgs(['--user', 'work']).user).toBe('work');
  });
});

describe('the repository', () => {
  it('keeps .deploy.json out of git — it names this book\'s deployment, not the project\'s', () => {
    const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8').split('\n').map((line) => line.trim());
    expect(gitignore).toContain('.deploy.json');
  });

  it('is reachable as npm run deploy', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.deploy).toBe('node scripts/deploy.mjs');
  });
});
