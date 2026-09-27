#!/usr/bin/env node
/**
 * setup.mjs — every Worker secret from one downloaded file and one paste.
 *
 *   npm run setup -- ~/Downloads/client_secret_<…>.json [--picker-key=AIza…]
 *
 * The Google Cloud console part cannot be scripted: Google has no API that
 * creates an OAuth client for a web application. Everything after it can, and
 * each value was a separate lookup and a separate `wrangler secret put`:
 *
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — read from the client's JSON, which
 *     the console offers as a download. Copying a secret out of a web page by
 *     hand is how a trailing space ends up in it.
 *   GOOGLE_PROJECT_NUMBER — the digits an OAuth client ID starts with. It *is*
 *     the project number; the console shows the same figure on the dashboard.
 *   SPREADSHEET_ID — the book this Apps Script project is bound to, which the
 *     Apps Script API reports as its `parentId`. `.clasp.json` names the
 *     project and clasp's login is allowed to ask.
 *   SESSION_KEY — generated, and **only when there is none**: replacing it
 *     signs every device out, so a second run of this must not.
 *   PICKER_API_KEY — the one value asked for, since the console shows it once
 *     and offers no file.
 *   ALLOWED_ACCOUNTS — `accounts.mjs ensure`, as `npm run deploy` does.
 *
 * The repo's rule is that one-time human operations get documented rather
 * than automated. This is the exception `installCredentials()` already made,
 * for the same reason: `SESSION_KEY` has to be exactly 32 bytes of base64 and
 * a client secret has to arrive intact, and a procedure that gets either
 * subtly wrong produces a Worker that refuses every sign-in without saying
 * which value it disliked.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claspAccessToken, putSecret, main as accounts, CLASPRC_PATH, LIST_PATH } from './accounts.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CLASP_PROJECT_PATH = join(WEB, '..', '.clasp.json');

const PICKER_KEY = /^AIza[0-9A-Za-z_-]{35}$/;

/**
 * The OAuth client from the console's download, and the project number its ID
 * begins with. Only a *Web application* client can do the redirect sign-in; a
 * Desktop client's file says `installed` and would fail at Google's consent
 * screen, so it is refused here instead.
 */
export function readClient(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON. It should be the client_secret_….json the console downloads.');
  }
  if (parsed.installed) throw new Error('That is a Desktop client. Create one of type "Web application".');
  const web = parsed.web;
  if (!web?.client_id || !web?.client_secret) throw new Error('No web client_id and client_secret in that file.');
  const projectNumber = /^([0-9]+)-[0-9a-z]+\.apps\.googleusercontent\.com$/.exec(web.client_id)?.[1];
  if (!projectNumber) throw new Error(`Unexpected client ID shape: ${web.client_id}`);
  return { clientId: web.client_id, clientSecret: web.client_secret, projectNumber };
}

/** The spreadsheet this Apps Script project is bound to. */
export async function boundSpreadsheet({ claspProjectPath = CLASP_PROJECT_PATH, rcPath = CLASPRC_PATH, fetchImpl = fetch } = {}) {
  if (!existsSync(claspProjectPath)) throw new Error(`No ${claspProjectPath}: run this from a checkout clasp has pushed from.`);
  const { scriptId } = JSON.parse(readFileSync(claspProjectPath, 'utf8'));
  if (!/^[0-9A-Za-z_-]+$/.test(scriptId ?? '')) throw new Error('.clasp.json has no scriptId.');

  const token = await claspAccessToken({ rcPath, fetchImpl });
  const response = await fetchImpl(`https://script.googleapis.com/v1/projects/${scriptId}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) throw new Error(`The Apps Script API would not describe the project (${response.status}).`);
  const { parentId } = await response.json();
  if (!/^[0-9A-Za-z_-]{20,}$/.test(parentId ?? '')) {
    throw new Error('The Apps Script project is not bound to a spreadsheet. Pass --spreadsheet=<id> from the book\'s URL.');
  }
  return parentId;
}

/** Secret names the Worker already has. Values never come back — only names. */
export function existingSecrets(run = spawnSync) {
  const result = run('npx', ['wrangler', 'secret', 'list', '--format', 'json'], { cwd: WEB, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('wrangler secret list failed — run `npm run deploy` once first, after `npx wrangler login`.');
  return new Set(JSON.parse(result.stdout).map((secret) => secret.name));
}

const option = (argv, name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

async function askTerminal(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await terminal.question(question)).trim();
  } finally {
    terminal.close();
  }
}

export async function main(
  argv,
  {
    run = spawnSync,
    fetchImpl = fetch,
    ask = askTerminal,
    log = console.log,
    rcPath = CLASPRC_PATH,
    claspProjectPath = CLASP_PROJECT_PATH,
    listPath = LIST_PATH,
    readFile = (path) => readFileSync(path, 'utf8')
  } = {}
) {
  const file = argv.find((arg) => !arg.startsWith('--'));
  if (!file) throw new Error('Usage: npm run setup -- <client_secret_….json> [--picker-key=…] [--spreadsheet=…]');

  // Everything is gathered and checked before anything is written, so a
  // mistake in the last value does not leave a half-configured Worker.
  const client = readClient(readFile(file));
  const spreadsheet = option(argv, 'spreadsheet') ?? (await boundSpreadsheet({ claspProjectPath, rcPath, fetchImpl }));
  const pickerKey = option(argv, 'picker-key') ?? (await ask('Picker API key (Credentials → API keys): '));
  if (!PICKER_KEY.test(pickerKey)) throw new Error('That does not look like a Google API key (AIza…, 39 characters).');
  const have = existingSecrets(run);

  const secrets = {
    GOOGLE_CLIENT_ID: client.clientId,
    GOOGLE_CLIENT_SECRET: client.clientSecret,
    GOOGLE_PROJECT_NUMBER: client.projectNumber,
    SPREADSHEET_ID: spreadsheet,
    PICKER_API_KEY: pickerKey
  };
  if (!have.has('SESSION_KEY')) secrets.SESSION_KEY = randomBytes(32).toString('base64');

  for (const [name, value] of Object.entries(secrets)) putSecret(name, value, run);
  log(`Set ${Object.keys(secrets).join(', ')}.`);
  if (have.has('SESSION_KEY')) log('Kept the existing SESSION_KEY, so nobody is signed out.');

  await accounts(['ensure'], { path: listPath, rcPath, fetchImpl, run, log });
  log('Done. Open /api/health on the Worker: every entry under "configured" should be true.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
