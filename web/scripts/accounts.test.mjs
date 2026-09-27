import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, claspCredentials, withAccount, withoutAccount, secretValue } from './accounts.mjs';

const OWNER = '104729384756102938475';
const FRIEND = '118273645501928374650';

let dir, path, rcPath, pushes, fetched, log;

const run = (cmd, args, options) => {
  pushes.push({ cmd, args, input: options.input });
  return { status: 0 };
};

const googleSays = (who, { tokenStatus = 200 } = {}) => async (url, init = {}) => {
  fetched.push({ url, init });
  if (url === 'https://oauth2.googleapis.com/token') {
    return new Response(JSON.stringify({ access_token: 'ya29.fresh' }), { status: tokenStatus });
  }
  return new Response(JSON.stringify(who), { status: 200 });
};

const clasp3 = { tokens: { default: { refresh_token: '1//r', client_id: 'cid', client_secret: 'cs', access_token: 'stale' } } };
const opts = (extra = {}) => ({ path, rcPath, run, log: (line) => log.push(line), fetchImpl: googleSays({ sub: OWNER, email: 'owner@example.com', email_verified: true }), ...extra });
const stored = () => JSON.parse(readFileSync(path, 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'accounts-'));
  path = join(dir, '.accounts.json');
  rcPath = join(dir, '.clasprc.json');
  writeFileSync(rcPath, JSON.stringify(clasp3));
  pushes = [];
  fetched = [];
  log = [];
});

describe('ensure, the last step of npm run deploy', () => {
  it('admits the account clasp is signed in as, from Google, with nobody typing it', async () => {
    await main(['ensure'], opts());

    expect(stored().accounts).toEqual([{ sub: OWNER, email: 'owner@example.com' }]);
    expect(pushes).toEqual([{ cmd: 'npx', args: ['wrangler', 'secret', 'put', 'ALLOWED_ACCOUNTS'], input: OWNER }]);
    // A fresh token, not the saved one — which is usually expired.
    expect(new URLSearchParams(fetched[0].init.body).get('refresh_token')).toBe('1//r');
    expect(fetched[1].init.headers.authorization).toBe('Bearer ya29.fresh');
  });

  it('keeps the list to its owner: the file is not world-readable', async () => {
    await main(['ensure'], opts());
    expect(statSync(path).mode & 0o077).toBe(0);
  });

  it('pushes nothing on a deploy that changed nobody', async () => {
    await main(['ensure'], opts());
    pushes = [];
    fetched = [];
    await main(['ensure'], opts());
    expect(pushes).toEqual([]);
    expect(fetched).toEqual([]);
  });

  it('tries again next deploy when the push failed', async () => {
    await expect(main(['ensure'], opts({ run: () => ({ status: 1 }) }))).rejects.toThrow(/wrangler/);
    expect(stored().pushed).toBeNull();
    await main(['ensure'], opts());
    expect(pushes).toHaveLength(1);
  });

  it('refuses an account Google does not vouch for the address of', async () => {
    const fetchImpl = googleSays({ sub: OWNER, email: 'owner@example.com', email_verified: false });
    await expect(main(['ensure'], opts({ fetchImpl }))).rejects.toThrow(/verified/);
    expect(pushes).toEqual([]);
  });

  it('says what to do when clasp is not signed in', async () => {
    await expect(main(['ensure'], opts({ rcPath: join(dir, 'missing.json') }))).rejects.toThrow(/clasp login/);
    await expect(main(['ensure'], opts({ fetchImpl: googleSays({}, { tokenStatus: 400 }) }))).rejects.toThrow(/clasp login/);
    expect(existsSync(path)).toBe(false);
  });
});

describe('sharing', () => {
  it('adds a second account without dropping the first', async () => {
    await main(['ensure'], opts());
    await main(['add', FRIEND, 'friend@example.com'], opts());

    expect(stored().accounts.map((a) => a.sub)).toEqual([OWNER, FRIEND]);
    expect(pushes.at(-1).input).toBe(`${OWNER},${FRIEND}`);
  });

  it('adding someone already there changes nobody', async () => {
    await main(['ensure'], opts());
    await main(['add', OWNER], opts());
    expect(stored().accounts).toEqual([{ sub: OWNER, email: 'owner@example.com' }]);
    expect(pushes).toHaveLength(1);
  });

  it('removes one account and keeps the rest', async () => {
    await main(['ensure'], opts());
    await main(['add', FRIEND], opts());
    await main(['remove', FRIEND], opts());
    expect(pushes.at(-1).input).toBe(OWNER);
  });

  it('will not empty the list', () => {
    expect(() => withoutAccount({ accounts: [{ sub: OWNER }] }, OWNER)).toThrow(/nobody/);
  });

  it('takes an account ID and an address, and nothing a shell would read', () => {
    const empty = { accounts: [], pushed: null };
    for (const bad of ["1'; rm -rf ~; '", '$(id)', 'abc', '', undefined]) expect(() => withAccount(empty, bad)).toThrow();
    expect(() => withAccount(empty, OWNER, "a@b.co'; id; '")).toThrow(/email/);
    expect(secretValue(withAccount(empty, OWNER, 'a+b@example.co.uk'))).toBe(OWNER);
  });
});

describe('claspCredentials', () => {
  it('reads both shapes clasp has saved a login in', () => {
    expect(claspCredentials(clasp3)).toEqual({ refreshToken: '1//r', clientId: 'cid', clientSecret: 'cs' });
    expect(
      claspCredentials({ token: { refresh_token: '1//t' }, oauth2ClientSettings: { clientId: 'c2', clientSecret: 's2' } })
    ).toEqual({ refreshToken: '1//t', clientId: 'c2', clientSecret: 's2' });
    expect(claspCredentials({ tokens: { default: { access_token: 'only' } } })).toBeNull();
  });
});
