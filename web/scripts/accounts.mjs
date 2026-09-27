#!/usr/bin/env node
/**
 * accounts.mjs — who the viewer lets in, kept here and pushed to Cloudflare.
 *
 *   npm run accounts -- list
 *   npm run accounts -- add <account id> [email]
 *   npm run accounts -- remove <account id>
 *   node scripts/accounts.mjs ensure      (the last step of `npm run deploy`)
 *
 * ## Why the list lives in a local file
 *
 * `ALLOWED_ACCOUNTS` is a Worker secret, and **a secret cannot be read back** —
 * `wrangler secret list` gives names, never values. `wrangler secret put`
 * replaces the whole value, so adding one person means knowing everyone
 * already on it. Sharing the viewer is a thing done repeatedly, and the
 * alternative is a list kept in your head and retyped in full each time,
 * where one omission locks someone out — including you. So the list lives in
 * `web/.accounts.json` (gitignored: it names people and the repository is
 * public), and every change here pushes it whole.
 *
 * ## Why the first entry needs no typing
 *
 * Admission is by Google account ID, never by address — `google-identity.ts`
 * argues why. Nobody knows their account ID, so the first deploy would
 * otherwise end in a refusal screen, a copy and a second deploy. But this
 * project already holds a Google login for the owner: `clasp`, signed in as
 * the account that owns the book. `ensure` asks Google who that login is and
 * admits it. The ID comes from Google, never from a page or a link, which is
 * the property the refusal screen's command had to be rebuilt to keep.
 *
 * The one assumption: the phone signs in as the same account `clasp` does.
 * If not, the refusal screen shows the `add` command for the account that did.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LIST_PATH = join(WEB, '.accounts.json');
export const CLASPRC_PATH = join(homedir(), '.clasprc.json');

/** A Google account ID: digits only. Anything else is refused rather than quoted. */
export const isAccountId = (value) => typeof value === 'string' && /^[0-9]{1,64}$/.test(value);

/** Only a label here, but it is printed and stored, so it is held to an address's shape. */
export const isEmail = (value) =>
  typeof value === 'string' && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value);

/** What `ALLOWED_ACCOUNTS` is set to for this list. */
export const secretValue = (list) => list.accounts.map((a) => a.sub).join(',');

export function readList(path = LIST_PATH) {
  if (!existsSync(path)) return { accounts: [], pushed: null };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts.filter((a) => isAccountId(a?.sub)) : [];
  return { accounts, pushed: typeof parsed.pushed === 'string' ? parsed.pushed : null };
}

export function writeList(list, path = LIST_PATH) {
  writeFileSync(path, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
}

/** A new list with `sub` on it. Adding someone already there only updates their label. */
export function withAccount(list, sub, email) {
  if (!isAccountId(sub)) throw new Error(`Not a Google account ID: ${JSON.stringify(sub)} (digits only).`);
  if (email !== undefined && email !== null && !isEmail(email)) throw new Error(`Not an email address: ${JSON.stringify(email)}.`);
  const others = list.accounts.filter((a) => a.sub !== sub);
  const before = list.accounts.find((a) => a.sub === sub);
  const entry = { sub, email: email ?? before?.email ?? null };
  return { ...list, accounts: before ? list.accounts.map((a) => (a.sub === sub ? entry : a)) : [...others, entry] };
}

/**
 * A new list without `sub`. Emptying it is refused: an empty `ALLOWED_ACCOUNTS`
 * admits nobody, which is the Worker switched off by a typo rather than on
 * purpose.
 */
export function withoutAccount(list, sub) {
  if (!list.accounts.some((a) => a.sub === sub)) throw new Error(`${sub} is not on the list.`);
  const accounts = list.accounts.filter((a) => a.sub !== sub);
  if (accounts.length === 0) throw new Error('That would admit nobody. Add someone else first.');
  return { ...list, accounts };
}

/**
 * The client and refresh token `clasp login` saved, in either shape clasp has
 * used: 3.x keeps them together under `tokens.default`, 2.x splits the client
 * into `oauth2ClientSettings`.
 */
export function claspCredentials(rc) {
  const three = rc?.tokens?.default;
  if (three?.refresh_token && three.client_id && three.client_secret) {
    return { refreshToken: three.refresh_token, clientId: three.client_id, clientSecret: three.client_secret };
  }
  const two = rc?.token;
  const client = rc?.oauth2ClientSettings;
  if (two?.refresh_token && client?.clientId && client?.clientSecret) {
    return { refreshToken: two.refresh_token, clientId: client.clientId, clientSecret: client.clientSecret };
  }
  return null;
}

/**
 * A fresh access token from clasp's login, rather than the saved one, which is
 * usually expired. Used for one question and dropped; nothing here writes to
 * `.clasprc.json`.
 */
export async function claspAccessToken({ rcPath = CLASPRC_PATH, fetchImpl = fetch } = {}) {
  if (!existsSync(rcPath)) throw new Error('clasp is not signed in here. Run `npx clasp login` at the repository root.');
  const credentials = claspCredentials(JSON.parse(readFileSync(rcPath, 'utf8')));
  if (!credentials) throw new Error(`${rcPath} holds no refresh token clasp can use. Run \`npx clasp login\` again.`);

  const token = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret
    }).toString()
  });
  if (!token.ok) throw new Error(`Google refused clasp's login (${token.status}). Run \`npx clasp login\` again.`);
  const { access_token: accessToken } = await token.json();
  return accessToken;
}

/** Who `clasp` is signed in as: `{ sub, email }`, from Google. */
export async function claspAccount({ rcPath = CLASPRC_PATH, fetchImpl = fetch } = {}) {
  const accessToken = await claspAccessToken({ rcPath, fetchImpl });
  const info = await fetchImpl('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!info.ok) throw new Error(`Google would not say who clasp is signed in as (${info.status}).`);
  const who = await info.json();
  if (!isAccountId(who.sub)) throw new Error('Google answered without an account ID.');
  // The same bar the Worker holds a sign-in to: an unverified address is a claim.
  if (who.email_verified !== true || !isEmail(who.email)) throw new Error('clasp\'s account has no verified email.');
  return { sub: who.sub, email: who.email };
}

/** `wrangler secret put`, with the value on stdin so it never appears in a process list. */
export function putSecret(name, value, run = spawnSync) {
  const result = run('npx', ['wrangler', 'secret', 'put', name], {
    cwd: WEB,
    input: value,
    stdio: ['pipe', 'inherit', 'inherit']
  });
  if (result.status !== 0) throw new Error(`wrangler secret put ${name} failed — is \`npx wrangler login\` done?`);
}

export const pushSecret = (value, run = spawnSync) => putSecret('ALLOWED_ACCOUNTS', value, run);

/** Push the list if Cloudflare does not already have exactly this value. */
function sync(list, { path, run, log }) {
  const value = secretValue(list);
  if (value === list.pushed) {
    writeList(list, path);
    return list;
  }
  // Written before the push, so a failed push leaves the list and a stale `pushed`,
  // and the next deploy tries again.
  writeList(list, path);
  pushSecret(value, run);
  const done = { ...list, pushed: value };
  writeList(done, path);
  log(`ALLOWED_ACCOUNTS now admits ${list.accounts.length} account${list.accounts.length === 1 ? '' : 's'}.`);
  return done;
}

const describe = (a) => `${a.sub}${a.email ? `  ${a.email}` : ''}`;

export async function main(argv, { path = LIST_PATH, rcPath = CLASPRC_PATH, fetchImpl = fetch, run = spawnSync, log = console.log } = {}) {
  const [command, ...rest] = argv;
  let list = readList(path);

  if (command === 'list') {
    if (list.accounts.length === 0) log('Nobody yet. `npm run deploy` adds the account clasp is signed in as.');
    for (const account of list.accounts) log(describe(account));
    return list;
  }

  if (command === 'add') {
    const [sub, email] = rest;
    list = withAccount(list, sub, email);
    log(`Added ${describe(list.accounts.find((a) => a.sub === sub))}.`);
    return sync(list, { path, run, log });
  }

  if (command === 'remove') {
    list = withoutAccount(list, rest[0]);
    log(`Removed ${rest[0]}. Their session ends on their next request.`);
    return sync(list, { path, run, log });
  }

  if (command === 'ensure') {
    if (list.accounts.length === 0) {
      const owner = await claspAccount({ rcPath, fetchImpl });
      list = withAccount(list, owner.sub, owner.email);
      log(`Admitted ${owner.email} (${owner.sub}) — the account clasp is signed in as.`);
      log('If the phone signs in as another account, its refusal screen shows the command to add it.');
    }
    return sync(list, { path, run, log });
  }

  throw new Error('Usage: npm run accounts -- list | add <account id> [email] | remove <account id>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
