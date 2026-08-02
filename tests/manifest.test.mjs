/**
 * The manifest declares oauthScopes explicitly, which means Apps Script
 * grants exactly that list and nothing else. Least privilege is the right
 * choice for something holding bank credentials — but it fails in a
 * particularly unhelpful way: the script installs and runs fine until it
 * reaches the one call it lacks a scope for, then throws a permissions
 * error naming a URL with no hint of which line caused it.
 *
 * So instead of remembering, the scopes are derived from what the source
 * actually calls. Add a service in a later phase without its scope and this
 * fails in CI, not in your spreadsheet.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from './harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

const manifest = JSON.parse(readFileSync(join(SRC, 'appsscript.json'), 'utf8'));
const source = sourceFiles().map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

const SCOPE_FOR = [
  [/\.(showModalDialog|showSidebar|showModelessDialog)\s*\(/, 'script.container.ui', 'dialogs and sidebars'],
  [/\bUrlFetchApp\./, 'script.external_request', 'outbound HTTP'],
  [/\bScriptApp\./, 'script.scriptapp', 'reading the deployment URL and installing triggers'],
  [/\bMailApp\./, 'script.send_mail', 'sending alerts'],
  [/\bDriveApp\./, 'drive.file', 'CSV snapshots'],
  [/\bSession\./, 'userinfo.email', 'knowing where to send an alert'],
  [/\bSpreadsheetApp\./, 'spreadsheets.currentonly', 'reading and writing the sheet']
];

describe('appsscript.json', () => {
  it('declares a scope for every Google service the source calls', () => {
    const missing = SCOPE_FOR
      .filter(([pattern]) => pattern.test(source))
      .filter(([, scope]) => !manifest.oauthScopes.some((s) => s.endsWith('/' + scope)))
      .map(([, scope, why]) => `${scope} (needed for ${why})`);

    expect(missing).toEqual([]);
  });

  it('does not request scopes nothing uses', () => {
    // An over-broad consent screen is its own problem: it trains you to
    // click through prompts you should be reading.
    const unused = SCOPE_FOR
      .filter(([pattern]) => !pattern.test(source))
      .filter(([, scope]) => manifest.oauthScopes.some((s) => s.endsWith('/' + scope)))
      .map(([, scope]) => scope);

    expect(unused).toEqual([]);
  });

  it('keeps spreadsheet access scoped to this file only', () => {
    // `spreadsheets` would grant every spreadsheet in the Drive.
    expect(manifest.oauthScopes).not.toContain('https://www.googleapis.com/auth/spreadsheets');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/spreadsheets.currentonly');
  });

  it('keeps Drive access to files this script created', () => {
    // `drive` would grant the entire Drive; drive.file is only what we make.
    expect(manifest.oauthScopes).not.toContain('https://www.googleapis.com/auth/drive');
    expect(manifest.oauthScopes).not.toContain('https://www.googleapis.com/auth/drive.readonly');
  });

  it('calls no DriveApp method that would need a wider scope than drive.file', () => {
    // Declaring `DriveApp.` is not enough to know which scope it needs, and
    // this is the gap that let snapshotToDrive ship: getFoldersByName
    // *searches* Drive, and searching needs drive or drive.readonly. Both are
    // restricted scopes — an unverified app asking for one is hard-blocked on
    // some account types, with no Advanced link to click through.
    //
    // Everything below reads beyond what this script created. The way to find
    // our own folder is to remember its id, not to look for it.
    const NEEDS_WIDER_SCOPE = [
      'getFoldersByName', 'getFilesByName', 'getRootFolder', 'getStorageUsed',
      'searchFiles', 'searchFolders', 'getFolders(', 'getFiles(', 'getTrashedFiles'
    ];

    const used = NEEDS_WIDER_SCOPE.filter((method) => source.includes('DriveApp.' + method));
    expect(used).toEqual([]);
  });

  it('is configured for the web app the bank redirects into', () => {
    // Access must be ANYONE_ANONYMOUS because the redirect arrives
    // unauthenticated. The state nonce is what protects the endpoint.
    expect(manifest.webapp.access).toBe('ANYONE_ANONYMOUS');
    expect(manifest.webapp.executeAs).toBe('USER_DEPLOYING');
    expect(manifest.runtimeVersion).toBe('V8');
  });
});
