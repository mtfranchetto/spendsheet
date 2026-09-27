/**
 * The sealed cookies, tested from the direction that matters: what gets refused.
 *
 * A test that only proves a good value round-trips proves the happy path and
 * nothing about the boundary. Every case below is a way in that must not work,
 * plus the cookie attributes — which are not decoration: the `__Host-` prefix
 * and `Secure` are enforced by the browser, and `SameSite` being wrong presents
 * as a sign-in that silently does nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  seal,
  unseal,
  openSession,
  openAccess,
  openSignIn,
  cookie,
  clearCookie,
  readCookie,
  b64url,
  SESSION_COOKIE,
  ACCESS_COOKIE,
  SIGNIN_COOKIE,
  SESSION_TTL_SECONDS,
  SIGNIN_TTL_SECONDS,
  type Session
} from './session';

const NOW = 1_770_000_000;

function key(fill: number): string {
  return btoa(String.fromCharCode(...new Uint8Array(32).fill(fill)));
}
const KEY = key(7);
const OTHER_KEY = key(9);

const SESSION: Session = { sub: '1234567890', email: 'owner@example.com', refresh_token: '1//refresh', iat: NOW };

describe('seal / unseal', () => {
  it('round-trips a value', async () => {
    const sealed = await seal(SESSION, SESSION_COOKIE, KEY);
    expect(await unseal(sealed, SESSION_COOKIE, KEY)).toEqual(SESSION);
  });

  it('hides what it holds', async () => {
    // The refresh token reads the book as you. Signed would be enough to stop a
    // forgery; only sealed stops a leaked cookie from being read.
    const sealed = await seal(SESSION, SESSION_COOKIE, KEY);
    expect(sealed).not.toContain('owner');
    expect(atob(sealed.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sealed.length + 3) % 4))).not.toContain('refresh');
  });

  it('refuses a value sealed under another key', async () => {
    const sealed = await seal(SESSION, SESSION_COOKIE, OTHER_KEY);
    expect(await unseal(sealed, SESSION_COOKIE, KEY)).toBeNull();
  });

  it('refuses a value with one bit changed', async () => {
    const sealed = await seal(SESSION, SESSION_COOKIE, KEY);
    const bytes = Uint8Array.from(atob(sealed.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((sealed.length + 3) % 4)), (c) => c.charCodeAt(0));
    bytes[bytes.length - 1] ^= 1;
    expect(await unseal(b64url(bytes), SESSION_COOKIE, KEY)).toBeNull();
  });

  it('refuses a value sealed as a different cookie', async () => {
    // The sign-in cookie lives ten minutes; replayed under the session's name
    // it must not become a 400-day session.
    const sealed = await seal(SESSION, SIGNIN_COOKIE, KEY);
    expect(await unseal(sealed, SESSION_COOKIE, KEY)).toBeNull();
  });

  it('refuses garbage, empty and missing values', async () => {
    for (const token of ['', null, undefined, 'not base64 !!', 'AAAA']) {
      expect(await unseal(token, SESSION_COOKIE, KEY)).toBeNull();
    }
  });

  it('fails closed on a missing or malformed key', async () => {
    const sealed = await seal(SESSION, SESSION_COOKIE, KEY);
    for (const bad of [undefined, '', 'short', btoa('sixteen bytes!!!')]) {
      expect(await unseal(sealed, SESSION_COOKIE, bad)).toBeNull();
      await expect(seal(SESSION, SESSION_COOKIE, bad)).rejects.toThrow(/SESSION_KEY/);
    }
  });
});

describe('openSession', () => {
  it('accepts a fresh session', async () => {
    const sealed = await seal(SESSION, SESSION_COOKIE, KEY);
    expect(await openSession(sealed, NOW, KEY)).toEqual(SESSION);
  });

  it('refuses one past 400 days, whatever the browser kept', async () => {
    const sealed = await seal(SESSION, SESSION_COOKIE, KEY);
    expect(await openSession(sealed, NOW + SESSION_TTL_SECONDS - 1, KEY)).not.toBeNull();
    expect(await openSession(sealed, NOW + SESSION_TTL_SECONDS, KEY)).toBeNull();
  });

  it('refuses one issued in the future', async () => {
    const sealed = await seal({ ...SESSION, iat: NOW + 3600 }, SESSION_COOKIE, KEY);
    expect(await openSession(sealed, NOW, KEY)).toBeNull();
  });

  it('refuses one missing its account, address or grant', async () => {
    for (const field of ['sub', 'email', 'refresh_token'] as const) {
      const sealed = await seal({ ...SESSION, [field]: '' }, SESSION_COOKIE, KEY);
      expect(await openSession(sealed, NOW, KEY), field).toBeNull();
    }
  });
});

describe('openAccess', () => {
  const access = { sub: SESSION.sub, access_token: 'ya29.token', exp: NOW + 3600 };

  it('uses a cached token with time left', async () => {
    const sealed = await seal(access, ACCESS_COOKIE, KEY);
    expect(await openAccess(sealed, SESSION.sub, NOW, KEY)).toEqual(access);
  });

  it('refreshes a minute before Google would refuse it', async () => {
    const sealed = await seal(access, ACCESS_COOKIE, KEY);
    expect(await openAccess(sealed, SESSION.sub, NOW + 3600 - 60, KEY)).toBeNull();
  });

  it('never serves one account with another account\'s token', async () => {
    const sealed = await seal(access, ACCESS_COOKIE, KEY);
    expect(await openAccess(sealed, 'someone-else', NOW, KEY)).toBeNull();
  });
});

describe('openSignIn', () => {
  it('lives ten minutes', async () => {
    const sealed = await seal({ state: 's', verifier: 'v', iat: NOW }, SIGNIN_COOKIE, KEY);
    expect(await openSignIn(sealed, NOW + SIGNIN_TTL_SECONDS - 1, KEY)).not.toBeNull();
    expect(await openSignIn(sealed, NOW + SIGNIN_TTL_SECONDS, KEY)).toBeNull();
  });
});

describe('cookie attributes', () => {
  it('is HttpOnly, Secure, Lax and host-only', () => {
    const header = cookie(SESSION_COOKIE, 'v', SESSION_TTL_SECONDS);
    expect(SESSION_COOKIE.startsWith('__Host-')).toBe(true);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/');
    expect(header).not.toMatch(/Domain=/i);
  });

  it('is persistent, because iOS 17 dropped session cookies in Home Screen apps', () => {
    expect(cookie(SESSION_COOKIE, 'v', SESSION_TTL_SECONDS)).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it('clears with the same attributes and zero age', () => {
    expect(clearCookie(SESSION_COOKIE)).toBe(cookie(SESSION_COOKIE, '', 0));
  });

  it('reads one cookie out of a header', () => {
    expect(readCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`, SESSION_COOKIE)).toBe('abc');
    expect(readCookie(`${SESSION_COOKIE}-signin=x`, SESSION_COOKIE)).toBeNull();
    expect(readCookie(null, SESSION_COOKIE)).toBeNull();
  });
});
