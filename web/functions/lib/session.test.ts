/**
 * The gate, tested from the direction that matters: what gets refused.
 *
 * A session test that only proves a good token round-trips proves the happy
 * path and nothing about the boundary. Every case below is a way in that must
 * not work, plus the cookie attributes — which are not decoration here: the
 * `__Host-` prefix and `Secure` are enforced by the browser, and `SameSite`
 * being wrong presents as a sign-in that silently does nothing.
 */

import { describe, it, expect } from 'vitest';
import {
  signSession,
  verifySession,
  sessionCookie,
  clearedCookie,
  readCookie,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS
} from './session';

const SECRET = 'test-secret-not-a-real-one';
const OWNER = 'owner@example.com';
const NOW = 1_770_000_000;

describe('signSession / verifySession', () => {
  it('round-trips the owner', async () => {
    const token = await signSession(OWNER, NOW, SECRET);

    expect(await verifySession(token, NOW, SECRET)).toEqual({
      email: OWNER,
      exp: NOW + SESSION_TTL_SECONDS
    });
  });

  it('refuses a token signed with a different secret', async () => {
    const token = await signSession(OWNER, NOW, 'some-other-secret');

    expect(await verifySession(token, NOW, SECRET)).toBeNull();
  });

  // The interesting forgery: the payload is readable and editable by anyone
  // holding the cookie, so the MAC is the only thing standing between a
  // curious person and any email they like.
  it('refuses a payload edited under a valid signature', async () => {
    const token = await signSession(OWNER, NOW, SECRET);
    const mac = token.slice(token.indexOf('.'));
    const forged = btoa(JSON.stringify({ email: 'someone@else.com', exp: NOW + 999 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    expect(await verifySession(forged + mac, NOW, SECRET)).toBeNull();
  });

  it('refuses an expired token', async () => {
    const token = await signSession(OWNER, NOW, SECRET, 60);

    expect(await verifySession(token, NOW + 59, SECRET)).not.toBeNull();
    expect(await verifySession(token, NOW + 61, SECRET)).toBeNull();
  });

  // Boundary written out because `<=` and `<` are the same test on every input
  // except this one, and a session that outlives its own expiry by a second is
  // not the direction to be wrong in.
  it('refuses a token at exactly its expiry', async () => {
    const token = await signSession(OWNER, NOW, SECRET, 60);

    expect(await verifySession(token, NOW + 60, SECRET)).toBeNull();
  });

  it('fails closed on anything malformed', async () => {
    for (const bad of ['', null, undefined, 'nodot', '.', 'a.', '.b', 'a.b.c', 'not.base64!!']) {
      expect(await verifySession(bad as string, NOW, SECRET)).toBeNull();
    }
  });

  // A missing secret must not be a wildcard. If the binding is absent the
  // right answer is that nobody is signed in, not that everybody is.
  it('refuses everything when the secret is missing', async () => {
    const token = await signSession(OWNER, NOW, SECRET);

    expect(await verifySession(token, NOW, '')).toBeNull();
  });

  it('will not sign without a secret', async () => {
    await expect(signSession(OWNER, NOW, '')).rejects.toThrow(/SESSION_SECRET/);
  });
});

describe('the cookie itself', () => {
  it('carries the attributes the __Host- prefix requires', () => {
    const cookie = sessionCookie('tok');

    expect(cookie).toMatch(/^__Host-/);
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toContain('Domain=');
  });

  it('is HttpOnly, so no script can read or cap it', () => {
    expect(sessionCookie('tok')).toContain('HttpOnly');
  });

  // Strict would be withheld on the navigation back from Google, so the
  // session would be set and then invisible on the very next request.
  it('is SameSite=Lax, not Strict', () => {
    expect(sessionCookie('tok')).toContain('SameSite=Lax');
    expect(sessionCookie('tok')).not.toContain('SameSite=Strict');
  });

  it('clears with a matching cookie at zero age', () => {
    expect(clearedCookie()).toContain('Max-Age=0');
    expect(clearedCookie()).toMatch(/^__Host-/);
  });
});

describe('readCookie', () => {
  it('finds the session among others', () => {
    const header = `other=1; ${SESSION_COOKIE}=abc.def; third=2`;

    expect(readCookie(header, SESSION_COOKIE)).toBe('abc.def');
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(readCookie(`not-${SESSION_COOKIE}=abc`, SESSION_COOKIE)).toBeNull();
  });

  it('is null with no header at all', () => {
    expect(readCookie(null, SESSION_COOKIE)).toBeNull();
  });
});
