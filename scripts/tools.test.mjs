/**
 * tools.sh — the readiness check.
 *
 * What is held here is what the check decides for itself: the shape of its
 * table, the version comparison, and the floor it reads. Whether `brew` or
 * `wrangler` is on this machine is the machine's business and is not asserted.
 *
 * Every run goes through `/bin/bash` where there is one, because that is 3.2
 * on macOS and the header of `lib/tools.sh` promises it runs there.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'scripts', 'lib', 'tools.sh');
const COMMAND = join(ROOT, 'scripts', 'tools.sh');
const BASH = existsSync('/bin/bash') ? '/bin/bash' : 'bash';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Source the library and run one line of shell against it. */
function shell(line, env = {}) {
  return spawnSync(BASH, ['-c', `. "${LIB}"; ${line}`], { encoding: 'utf8', env: { ...process.env, ...env } });
}

/** A root holding only a `package.json`, so no project-local tool is present. */
function emptyRoot(engines) {
  const dir = mkdtempSync(join(tmpdir(), 'spendsheet-tools-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: engines } }, null, 2));
  return dir;
}

/** A directory whose `node` answers `--version` with the version given. */
function fakeNode(version) {
  const dir = mkdtempSync(join(tmpdir(), 'spendsheet-node-'));
  const path = join(dir, 'node');
  writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
  chmodSync(path, 0o755);
  return dir;
}

describe('the table', () => {
  const rows = shell('printf "%s\\n" "$TOOLS_TABLE"')
    .stdout.split('\n')
    .filter(Boolean)
    .map((row) => row.split('|'));

  it('gives every row a name, a kind, an installer and a reason', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toHaveLength(4);
      expect(row.every((field) => field.trim() !== '')).toBe(true);
    }
  });

  it('uses only the kinds and installers the script acts on', () => {
    for (const [name, kind, installer] of rows) {
      expect(['required', 'optional'], name).toContain(kind);
      expect(installer, name).toMatch(/^(brew:.+|cask:.+|bootstrap|manual)$/);
    }
  });

  it('names both command-line tools a deploy signs in with', () => {
    const names = rows.map(([name]) => name);
    expect(names).toContain('clasp');
    expect(names).toContain('wrangler');
  });
});

describe('version_at_least', () => {
  const atLeast = (have, want) => shell(`version_at_least ${have} ${want}`).status === 0;

  it('compares field by field, not as text', () => {
    expect(atLeast('22.12.0', '22.12.0')).toBe(true);
    expect(atLeast('22.13.0', '22.12.0')).toBe(true);
    expect(atLeast('24.0.0', '22.12.0')).toBe(true);
    expect(atLeast('22.11.9', '22.12.0')).toBe(false);
    expect(atLeast('20.19.0', '22.12.0')).toBe(false);
    // As text, "9" sorts after "22" and "100" before it.
    expect(atLeast('9.0.0', '22.12.0')).toBe(false);
    expect(atLeast('100.0.0', '22.12.0')).toBe(true);
  });

  it('ignores a leading v and counts a missing field as zero', () => {
    expect(atLeast('v22.12.0', '22.12')).toBe(true);
    expect(atLeast('v22', '22.12')).toBe(false);
  });
});

describe('the Node floor', () => {
  const engines = readJson(join(ROOT, 'package.json')).engines.node;

  it('is read from the root package.json, in the one form it understands', () => {
    expect(engines).toMatch(/^>=[0-9]+(\.[0-9]+)*$/);
    expect(shell('node_floor').stdout.trim()).toBe(engines.slice(2));
  });

  it('is the same floor web/ declares', () => {
    expect(readJson(join(ROOT, 'web', 'package.json')).engines.node).toBe(engines);
  });

  it('is met by the line .nvmrc pins', () => {
    const pinned = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim();
    expect(pinned).toMatch(/^[0-9]+$/);
    expect(Number(pinned)).toBeGreaterThanOrEqual(Number(engines.slice(2).split('.')[0]));
  });

  it('reports a Node below it as too old, and the check fails', () => {
    const root = emptyRoot('>=22.12.0');
    const result = shell('tools_check', {
      TOOLS_ROOT_DIR: root,
      PATH: `${fakeNode('v20.19.0')}:${process.env.PATH}`
    });
    expect(result.stdout).toMatch(/^ {2}node +TOO OLD +v20\.19\.0, and this needs 22\.12\.0 or later/m);
    expect(result.status).toBe(1);
  });

  it('reports a Node at it as ok', () => {
    const root = emptyRoot('>=22.12.0');
    const result = shell('tools_check', {
      TOOLS_ROOT_DIR: root,
      PATH: `${fakeNode('v22.12.0')}:${process.env.PATH}`
    });
    expect(result.stdout).toMatch(/^ {2}node +ok +v22\.12\.0$/m);
  });
});

describe('project-local tools', () => {
  it('are missing from a root nothing was installed in', () => {
    const result = shell('tools_check', { TOOLS_ROOT_DIR: emptyRoot('>=22.12.0') });
    expect(result.stdout).toMatch(/^ {2}clasp +MISSING/m);
    expect(result.stdout).toMatch(/^ {2}wrangler +MISSING/m);
    expect(result.stdout).toMatch(/^ {2}webkit +- +optional/m);
    expect(result.status).toBe(1);
  });
});

describe('the command', () => {
  it('refuses a mode it does not have before checking anything', () => {
    const result = spawnSync(BASH, [COMMAND, 'reinstall'], { encoding: 'utf8' });
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/usage: tools\.sh \[check\|install\]/);
    expect(result.stdout).toBe('');
  });
});
