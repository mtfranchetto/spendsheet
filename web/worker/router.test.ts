/**
 * The Worker, tested for what it refuses.
 *
 * Google is faked at `fetch`, and the fake records every call — so each refusal
 * below also asserts that **nothing reached Google** before it. A gate that
 * turns a request away only after spending the owner's token on it has already
 * let a stranger make the owner's calls.
 *
 * The ID tokens are real: signed with a key generated here and served from the
 * fake JWKS, so `verifyIdToken` runs its actual checks rather than a stub's.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { handle, READ_RANGES, type Env } from './router';
import { forgetJwks } from './google-identity';
import { codeChallenge, DRIVE_FILE_SCOPE } from './oauth';
import {
  seal,
  unseal,
  b64url,
  SESSION_COOKIE,
  ACCESS_COOKIE,
  SIGNIN_COOKIE,
  type Session,
  type SignIn
} from './session';

const NOW = 1_770_000_000;
const ORIGIN = 'https://spendsheet.example.workers.dev';
const OWNER_SUB = '111111111111111111111';
const STRANGER_SUB = '999999999999999999999';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

const ENV: Env = {
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  SESSION_KEY: KEY,
  ALLOWED_ACCOUNTS: `${OWNER_SUB}, 222`,
  SPREADSHEET_ID: 'book-1',
  PICKER_API_KEY: 'picker-key',
  GOOGLE_PROJECT_NUMBER: '123456789012',
  BUILD_SHA: 'abc1234'
};

// ---------------------------------------------------------------------------
// A fake Google
// ---------------------------------------------------------------------------

let signingKey: CryptoKeyPair;
let publicJwk: JsonWebKey;

beforeAll(async () => {
  signingKey = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  publicJwk = await crypto.subtle.exportKey('jwk', signingKey.publicKey);
});

async function idToken(claims: Record<string, unknown>): Promise<string> {
  const enc = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));
  const head = enc({ alg: 'RS256', kid: 'k1', typ: 'JWT' });
  const body = enc({
    iss: 'https://accounts.google.com',
    aud: ENV.GOOGLE_CLIENT_ID,
    exp: NOW + 3600,
    email: 'owner@example.com',
    email_verified: true,
    sub: OWNER_SUB,
    ...claims
  });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signingKey.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

type Call = { url: string; body: string; authorization: string | null };

let calls: Call[];
let google: {
  idClaims: Record<string, unknown>;
  grantScope: string;
  refresh: { status: number; body: unknown };
  sheets: { status: number; body: unknown };
  /** Access tokens Sheets answers 401 to, as it does for a revoked grant's. */
  rejected: string[];
};

beforeEach(() => {
  calls = [];
  forgetJwks();
  google = {
    idClaims: {},
    grantScope: `openid email ${DRIVE_FILE_SCOPE}`,
    refresh: { status: 200, body: { access_token: 'ya29.refreshed', expires_in: 3599 } },
    sheets: { status: 200, body: { valueRanges: [{ range: 'transactions!A1:AD', values: [['uid'], ['u1']] }] } },
    rejected: []
  };

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init.headers);
    const body = init.body ? String(init.body) : '';
    calls.push({ url, body, authorization: headers.get('authorization') });

    const reply = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

    if (url.startsWith('https://www.googleapis.com/oauth2/v3/certs')) {
      return reply(200, { keys: [{ ...publicJwk, kid: 'k1', alg: 'RS256' }] });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        return reply(200, {
          id_token: await idToken(google.idClaims),
          refresh_token: '1//refresh',
          access_token: 'ya29.first',
          expires_in: 3599,
          scope: google.grantScope
        });
      }
      return reply(google.refresh.status, google.refresh.body);
    }
    if (url.startsWith('https://sheets.googleapis.com/')) {
      if (google.rejected.includes(String(headers.get('authorization')).replace('Bearer ', ''))) {
        return reply(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
      }
      if (url.includes('fields=')) return reply(google.sheets.status, { properties: { title: 'Spendsheet', timeZone: 'Europe/Rome' } });
      return reply(google.sheets.status, google.sheets.body);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

function request(path: string, init: { method?: string; cookie?: string; origin?: string | null } = {}): Request {
  const headers = new Headers();
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.origin) headers.set('origin', init.origin);
  return new Request(`${ORIGIN}${path}`, { method: init.method ?? 'GET', headers });
}

async function sessionCookie(over: Partial<Session> = {}, env: Env = ENV): Promise<string> {
  const session: Session = { sub: OWNER_SUB, email: 'owner@example.com', refresh_token: '1//refresh', iat: NOW, ...over };
  return `${SESSION_COOKIE}=${await seal(session, SESSION_COOKIE, env.SESSION_KEY)}`;
}

async function accessCookie(exp = NOW + 3000, sub = OWNER_SUB): Promise<string> {
  return `${ACCESS_COOKIE}=${await seal({ sub, access_token: 'ya29.cached', exp }, ACCESS_COOKIE, KEY)}`;
}

async function signedIn(): Promise<string> {
  return `${await sessionCookie()}; ${await accessCookie()}`;
}

const setCookies = (response: Response) => response.headers.getSetCookie();
const cookieNamed = (response: Response, name: string) =>
  setCookies(response).find((value) => value.startsWith(`${name}=`));

// ---------------------------------------------------------------------------

describe('/api/health', () => {
  it('answers without a session and says nothing about the book', async () => {
    const response = await handle(request('/api/health'), ENV, NOW);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      ok: true,
      build: 'abc1234',
      configured: { client: true, sessionKey: true, allowedAccounts: true, spreadsheet: true, picker: true }
    });
    expect(JSON.stringify(body)).not.toContain('book-1');
    expect(calls).toEqual([]);
  });
});

describe('the gate', () => {
  for (const path of ['/api/me', '/api/book', '/api/read']) {
    it(`refuses ${path} with no session, before reaching Google`, async () => {
      const response = await handle(request(path), ENV, NOW);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Not available.' });
      expect(calls).toEqual([]);
    });
  }

  it('refuses a session sealed under another key', async () => {
    const other = { ...ENV, SESSION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))) };
    const response = await handle(request('/api/read', { cookie: await sessionCookie({}, other) }), ENV, NOW);
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('refuses an access cookie presented as the session', async () => {
    const response = await handle(request('/api/read', { cookie: (await accessCookie()).replace(ACCESS_COOKIE, SESSION_COOKIE) }), ENV, NOW);
    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it('ends a session the moment its account leaves the allowlist', async () => {
    // Asked on every request, not only at sign-in, or taking someone off the
    // list would take 400 days to mean anything.
    const env = { ...ENV, ALLOWED_ACCOUNTS: '222' };
    const response = await handle(request('/api/read', { cookie: await signedIn() }), env, NOW);

    expect(response.status).toBe(401);
    expect(cookieNamed(response, SESSION_COOKIE)).toContain('Max-Age=0');
    expect(calls).toEqual([]);
  });

  it('lets nobody in when the allowlist is unset', async () => {
    const response = await handle(request('/api/me', { cookie: await signedIn() }), { ...ENV, ALLOWED_ACCOUNTS: undefined }, NOW);
    expect(response.status).toBe(401);
  });

  it('will not start a sign-in with a key that is set but not a key', async () => {
    // Pasted without base64, it is present and useless: sealing would throw out
    // of the Worker as a Cloudflare error page rather than saying so.
    const env = { ...ENV, SESSION_KEY: 'a-long-typed-password-not-base64-bytes' };
    const response = await handle(request('/auth/signin'), env, NOW);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Not configured.' });

    const health = (await (await handle(request('/api/health'), env, NOW)).json()) as { configured: Record<string, boolean> };
    expect(health.configured.sessionKey).toBe(false);
  });

  it('refuses everything when the session key is missing', async () => {
    const response = await handle(request('/api/me', { cookie: await signedIn() }), { ...ENV, SESSION_KEY: undefined }, NOW);
    expect(response.status).toBe(401);
  });

  it('says who is signed in and never hands out a token', async () => {
    const response = await handle(request('/api/me', { cookie: await signedIn() }), ENV, NOW);
    const text = await response.text();

    expect(JSON.parse(text)).toEqual({ email: 'owner@example.com', sub: OWNER_SUB });
    expect(text).not.toContain('ya29');
    expect(text).not.toContain('refresh');
  });
});

describe('a forged origin', () => {
  it('cannot sign you out from another site', async () => {
    const response = await handle(
      request('/auth/signout', { method: 'POST', cookie: await signedIn(), origin: 'https://evil.example' }),
      ENV,
      NOW
    );
    expect(response.status).toBe(403);
    expect(setCookies(response)).toEqual([]);
  });

  it('refuses a state-changing request that names no origin at all', async () => {
    const response = await handle(request('/auth/signout', { method: 'POST', cookie: await signedIn() }), ENV, NOW);
    expect(response.status).toBe(403);
  });

  it('refuses before routing, so a POST to any path is held to it', async () => {
    const response = await handle(request('/api/read', { method: 'POST', cookie: await signedIn(), origin: 'https://evil.example' }), ENV, NOW);
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('signs out from this origin, clearing both cookies', async () => {
    const response = await handle(request('/auth/signout', { method: 'POST', cookie: await signedIn(), origin: ORIGIN }), ENV, NOW);
    expect(response.status).toBe(200);
    expect(cookieNamed(response, SESSION_COOKIE)).toContain('Max-Age=0');
    expect(cookieNamed(response, ACCESS_COOKIE)).toContain('Max-Age=0');
  });
});

describe('sign-in', () => {
  async function start(): Promise<{ location: URL; signIn: SignIn; cookie: string }> {
    const response = await handle(request('/auth/signin'), ENV, NOW);
    expect(response.status).toBe(302);
    const header = cookieNamed(response, SIGNIN_COOKIE)!;
    const value = header.slice(SIGNIN_COOKIE.length + 1, header.indexOf(';'));
    const signIn = (await unseal<SignIn>(value, SIGNIN_COOKIE, KEY))!;
    return { location: new URL(response.headers.get('location')!), signIn, cookie: `${SIGNIN_COOKIE}=${value}` };
  }

  async function finish(params: Record<string, string>, cookie: string): Promise<Response> {
    const query = new URLSearchParams(params).toString();
    return handle(request(`/auth/callback?${query}`, { cookie }), ENV, NOW);
  }

  it('asks Google for drive.file, offline access and a PKCE challenge', async () => {
    const { location, signIn } = await start();
    const params = location.searchParams;

    expect(location.origin + location.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(params.get('scope')!.split(' ')).toEqual(['openid', 'email', DRIVE_FILE_SCOPE]);
    expect(params.get('access_type')).toBe('offline');
    expect(params.get('prompt')).toContain('consent');
    expect(params.get('redirect_uri')).toBe(`${ORIGIN}/auth/callback`);
    expect(params.get('state')).toBe(signIn.state);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toBe(await codeChallenge(signIn.verifier));
    // The verifier itself never leaves this browser's sealed cookie.
    expect(location.toString()).not.toContain(signIn.verifier);
  });

  it('refuses a callback whose state does not match, before exchanging anything', async () => {
    const { cookie } = await start();
    const response = await finish({ code: 'c', state: 'forged' }, cookie);

    expect(response.headers.get('location')).toBe('/?signin=state');
    expect(cookieNamed(response, SESSION_COOKIE)).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('refuses a callback with no sign-in cookie at all', async () => {
    const response = await finish({ code: 'c', state: 'anything' }, '');
    expect(response.headers.get('location')).toBe('/?signin=state');
    expect(calls).toEqual([]);
  });

  it('mints a session for an allowed account and sends the PKCE verifier', async () => {
    const { signIn, cookie } = await start();
    const response = await finish({ code: 'the-code', state: signIn.state }, cookie);

    expect(response.headers.get('location')).toBe('/');
    const exchange = new URLSearchParams(calls.find((c) => c.url.endsWith('/token'))!.body);
    expect(exchange.get('code_verifier')).toBe(signIn.verifier);
    expect(exchange.get('code')).toBe('the-code');

    const header = cookieNamed(response, SESSION_COOKIE)!;
    const session = await unseal<Session>(header.slice(SESSION_COOKIE.length + 1, header.indexOf(';')), SESSION_COOKIE, KEY);
    expect(session).toEqual({ sub: OWNER_SUB, email: 'owner@example.com', refresh_token: '1//refresh', iat: NOW });
    expect(header).toContain('Max-Age=34560000');
    expect(cookieNamed(response, ACCESS_COOKIE)).toBeDefined();
    expect(cookieNamed(response, SIGNIN_COOKIE)).toContain('Max-Age=0');
  });

  it('refuses an account not on the list, and shows it only its own ID', async () => {
    google.idClaims = { sub: STRANGER_SUB, email: 'stranger@example.com' };
    const { signIn, cookie } = await start();
    const response = await finish({ code: 'c', state: signIn.state }, cookie);

    expect(response.headers.get('location')).toBe(`/?signin=refused&account=${STRANGER_SUB}`);
    expect(cookieNamed(response, SESSION_COOKIE)).toBeUndefined();
    expect(cookieNamed(response, ACCESS_COOKIE)).toBeUndefined();
    expect(cookieNamed(response, SIGNIN_COOKIE)).toContain('Max-Age=0');
  });

  it('refuses an unverified address even on an allowed account', async () => {
    google.idClaims = { email_verified: false };
    const { signIn, cookie } = await start();
    const response = await finish({ code: 'c', state: signIn.state }, cookie);

    expect(response.headers.get('location')).toBe('/?signin=failed');
    expect(cookieNamed(response, SESSION_COOKIE)).toBeUndefined();
  });

  it('refuses an ID token minted for another app', async () => {
    google.idClaims = { aud: 'someone-elses-client' };
    const { signIn, cookie } = await start();
    const response = await finish({ code: 'c', state: signIn.state }, cookie);
    expect(response.headers.get('location')).toBe('/?signin=failed');
  });

  it('refuses a grant where drive.file was unticked', async () => {
    // Google lets a person untick a scope on the consent screen; a session that
    // cannot read the book would look like a broken app.
    google.grantScope = 'openid email';
    const { signIn, cookie } = await start();
    const response = await finish({ code: 'c', state: signIn.state }, cookie);
    expect(response.headers.get('location')).toBe('/?signin=failed');
    expect(cookieNamed(response, SESSION_COOKIE)).toBeUndefined();
  });
});

describe('Google access', () => {
  it('uses the cached access token without asking Google for another', async () => {
    await handle(request('/api/read', { cookie: await signedIn() }), ENV, NOW);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['sheets.googleapis.com']);
    expect(calls[0].authorization).toBe('Bearer ya29.cached');
  });

  it('refreshes an expired one and hands the new one back sealed', async () => {
    const cookie = `${await sessionCookie()}; ${await accessCookie(NOW + 30)}`;
    const response = await handle(request('/api/read', { cookie }), ENV, NOW);

    expect(response.status).toBe(200);
    expect(calls.map((c) => c.url)[0]).toBe('https://oauth2.googleapis.com/token');
    expect(calls[1].authorization).toBe('Bearer ya29.refreshed');
    const header = cookieNamed(response, ACCESS_COOKIE)!;
    expect(header).not.toContain('ya29');
    expect(header).toContain('Max-Age=3599');
  });

  it('never uses a previous account\'s cached token', async () => {
    const cookie = `${await sessionCookie()}; ${await accessCookie(NOW + 3000, '222')}`;
    await handle(request('/api/read', { cookie }), ENV, NOW);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
  });

  it('signs out when Google says the grant is gone', async () => {
    google.refresh = { status: 400, body: { error: 'invalid_grant' } };
    const response = await handle(request('/api/read', { cookie: await sessionCookie() }), ENV, NOW);

    expect(response.status).toBe(401);
    expect(cookieNamed(response, SESSION_COOKIE)).toContain('Max-Age=0');
  });

  it('retries once with a fresh token when Google stops honouring the cached one', async () => {
    // Otherwise the cookie goes on presenting a dead token for up to an hour and
    // every read fails as though Google were down.
    google.rejected = ['ya29.cached'];
    const response = await handle(request('/api/book', { cookie: await signedIn() }), ENV, NOW);

    expect(response.status).toBe(200);
    expect(calls.map((c) => new URL(c.url).host)).toEqual(['sheets.googleapis.com', 'oauth2.googleapis.com', 'sheets.googleapis.com']);
    expect(calls[2].authorization).toBe('Bearer ya29.refreshed');
    expect(cookieNamed(response, ACCESS_COOKIE)).toContain('Max-Age=3599');
  });

  it('signs out when that retry finds the grant revoked', async () => {
    google.rejected = ['ya29.cached'];
    google.refresh = { status: 400, body: { error: 'invalid_grant' } };
    const response = await handle(request('/api/read', { cookie: await signedIn() }), ENV, NOW);

    expect(response.status).toBe(401);
    expect(cookieNamed(response, SESSION_COOKIE)).toContain('Max-Age=0');
  });

  it('does not refresh twice for a token it minted a moment ago', async () => {
    google.rejected = ['ya29.refreshed'];
    const response = await handle(request('/api/read', { cookie: await sessionCookie() }), ENV, NOW);

    expect(response.status).toBe(503);
    expect(calls.filter((c) => c.url.endsWith('/token'))).toHaveLength(1);
    expect(cookieNamed(response, ACCESS_COOKIE)).toContain('Max-Age=0');
  });

  it('keeps a token it just refreshed even when the book is out of reach', async () => {
    // Dropped, every later request against a book not yet picked would go back
    // to Google's token endpoint first.
    google.sheets = { status: 403, body: {} };
    const response = await handle(request('/api/book', { cookie: await sessionCookie() }), ENV, NOW);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no-access' });
    expect(cookieNamed(response, ACCESS_COOKIE)).toContain('Max-Age=3599');
  });

  it('does not sign out because Google had a bad moment', async () => {
    google.refresh = { status: 503, body: { error: 'backendError' } };
    const response = await handle(request('/api/read', { cookie: await sessionCookie() }), ENV, NOW);

    expect(response.status).toBe(503);
    expect(setCookies(response)).toEqual([]);
  });
});

describe('/api/read', () => {
  it('reads only the configured book, only through batchGet, only the fixed ranges', async () => {
    const response = await handle(request('/api/read?tab=transactions&tab=_config', { cookie: await signedIn() }), ENV, NOW);
    const url = new URL(calls[0].url);

    expect(response.status).toBe(200);
    expect(url.pathname).toBe('/v4/spreadsheets/book-1/values:batchGet');
    expect(url.searchParams.getAll('ranges')).toEqual([READ_RANGES.transactions, READ_RANGES._config]);
    expect(url.searchParams.get('valueRenderOption')).toBe('UNFORMATTED_VALUE');
    expect(url.searchParams.get('dateTimeRenderOption')).toBe('SERIAL_NUMBER');
  });

  it('reads every tab when none is named', async () => {
    await handle(request('/api/read', { cookie: await signedIn() }), ENV, NOW);
    expect(new URL(calls[0].url).searchParams.getAll('ranges')).toEqual(Object.values(READ_RANGES));
  });

  it('refuses a tab it does not serve, before reaching Google', async () => {
    for (const tab of ['secrets', "transactions'!A1:ZZ", 'constructor', '__proto__']) {
      const response = await handle(request(`/api/read?tab=${encodeURIComponent(tab)}`, { cookie: await signedIn() }), ENV, NOW);
      expect(response.status, tab).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('cannot be pointed at another spreadsheet', async () => {
    await handle(request('/api/read?spreadsheetId=other&id=other', { cookie: await signedIn() }), ENV, NOW);
    expect(new URL(calls[0].url).pathname).toBe('/v4/spreadsheets/book-1/values:batchGet');
  });

  it('hands Google\'s body back and says how long Google took', async () => {
    const response = await handle(request('/api/read', { cookie: await signedIn() }), ENV, NOW);
    expect(await response.json()).toEqual(google.sheets.body);
    expect(response.headers.get('server-timing')).toMatch(/^google;dur=\d+$/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('says the grant cannot see the book, distinctly from a refusal', async () => {
    google.sheets = { status: 403, body: { error: { code: 403 } } };
    const response = await handle(request('/api/read', { cookie: await signedIn() }), ENV, NOW);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'no-access' });
  });
});

describe('/api/book', () => {
  it('reads the title and the timezone "today" is reckoned in', async () => {
    const response = await handle(request('/api/book', { cookie: await signedIn() }), ENV, NOW);
    expect(await response.json()).toEqual({ title: 'Spendsheet', timeZone: 'Europe/Rome' });
    expect(new URL(calls[0].url).pathname).toBe('/v4/spreadsheets/book-1');
  });
});

describe('/connect', () => {
  it('sends someone signed out to sign in', async () => {
    const response = await handle(request('/connect'), ENV, NOW);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/auth/signin');
    expect(calls).toEqual([]);
  });

  it('builds the Picker with the project number, the book and a nonce policy', async () => {
    const response = await handle(request('/connect', { cookie: await signedIn() }), ENV, NOW);
    const html = await response.text();
    const policy = response.headers.get('content-security-policy')!;
    const nonce = /'nonce-([^']+)'/.exec(policy)![1];

    expect(html).toContain('"appId":"123456789012"');
    expect(html).toContain('"fileId":"book-1"');
    expect(html).toContain('ya29.cached');
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("script-src 'unsafe-inline'");
    // Every script tag carries this response's nonce, and there is no inline handler.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const attrs of scripts) expect(attrs).toContain(`nonce="${nonce}"`);
    expect(html).not.toMatch(/\son[a-z]+="/);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('mints a different nonce every time', async () => {
    const cookie = await signedIn();
    const a = (await handle(request('/connect', { cookie }), ENV, NOW)).headers.get('content-security-policy');
    const b = (await handle(request('/connect', { cookie }), ENV, NOW)).headers.get('content-security-policy');
    expect(a).not.toBe(b);
  });

  it('cannot be made to close its own script element', async () => {
    const env = { ...ENV, SPREADSHEET_ID: 'x</script><script>alert(1)</script>' };
    const html = await (await handle(request('/connect', { cookie: await signedIn() }), env, NOW)).text();
    expect(html).not.toContain('</script><script>alert(1)');
  });
});

describe('routes', () => {
  it('answers an unknown path with 404, after the gate', async () => {
    expect((await handle(request('/api/nothing'), ENV, NOW)).status).toBe(401);
    expect((await handle(request('/api/nothing', { cookie: await signedIn() }), ENV, NOW)).status).toBe(404);
  });
});
