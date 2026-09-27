/**
 * oauth.ts — signing in, and the one grant the Worker reads the book with.
 *
 * ## A redirect, not a script
 *
 * The browser leaves for Google and comes back to `/auth/callback`, which
 * exchanges the code server-side and sets the session cookie in the same
 * response. No Google script runs on a page that shows balances; the only page
 * that loads one is `/connect`, which shows none.
 *
 * ## What is asked for, and why it is enough
 *
 * `openid email` says who signed in. `drive.file` is the data: per-file access
 * to the files *you* open with this app, which is the book and nothing else,
 * granted by picking it once in Google's Picker. None of the three is a
 * sensitive scope, so there is no unverified-app screen — a warning you would
 * learn to click past, which is the wrong habit for a finance app.
 *
 * `access_type=offline` asks for a refresh token, which is what lets the Worker
 * keep reading without a Google tap on every open. **Google returns one only
 * with `prompt=consent`** after the first grant, so a second device signing in
 * without it would get a session with nothing to read with. Asking every time
 * costs one extra screen about once a year per device.
 *
 * ## PKCE and `state`
 *
 * `state` ties the callback to a sign-in this browser started; the PKCE
 * verifier ties the code to it too, so a code intercepted on the way back is
 * useless without the verifier sealed in this browser's sign-in cookie. Both
 * are cheap, and neither depends on the client secret staying secret.
 */

import { b64url } from './session';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE].join(' ');

/** Where Google sends the browser back. Derived from the origin, so it cannot drift. */
export function callbackUrl(origin: string): string {
  return `${origin}/auth/callback`;
}

/** The PKCE `code_challenge` for a verifier: base64url(SHA-256(verifier)). */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/**
 * The URL to send the browser to.
 *
 * `select_account` as well as `consent`: the default reuses whichever Google
 * account the browser last used, so signing in as the wrong one would have no
 * visible way back.
 */
export async function authorizeUrl(origin: string, clientId: string, state: string, verifier: string): Promise<string> {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl(origin));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', await codeChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'select_account consent');
  return url.toString();
}

export type Grant = {
  id_token: string;
  refresh_token: string;
  access_token: string;
  /** Seconds, as Google sends it. */
  expires_in: number;
  scope: string;
};

/**
 * Trade the code for a grant, or `null`.
 *
 * A grant without a refresh token, or without `drive.file`, is refused here
 * rather than half-accepted: Google lets a person untick a scope on the consent
 * screen, and a session that cannot read the book would present as a broken
 * app rather than as a sign-in that asked for less than it needed.
 */
export async function exchangeCode(
  code: string,
  verifier: string,
  origin: string,
  clientId: string,
  clientSecret: string
): Promise<Grant | null> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      code_verifier: verifier,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl(origin),
      grant_type: 'authorization_code'
    })
  });
  if (!response.ok) return null;

  const grant = (await response.json().catch(() => null)) as Partial<Grant> | null;
  if (!grant?.id_token || !grant.refresh_token || !grant.access_token) return null;
  if (!String(grant.scope ?? '').split(' ').includes(DRIVE_FILE_SCOPE)) return null;
  return grant as Grant;
}

/** What a refresh answered: a token, or that the grant is gone for good. */
export type Refreshed =
  | { ok: true; access_token: string; expires_in: number }
  | { ok: false; revoked: boolean };

/**
 * A new access token from the refresh token.
 *
 * `invalid_grant` means the grant is gone — revoked under Third-party
 * connections, or unused for six months — and the only way back is signing in
 * again, so the caller clears the session. Anything else is Google having a
 * bad moment, and signing someone out for that would be wrong.
 */
export async function refreshAccess(refreshToken: string, clientId: string, clientSecret: string): Promise<Refreshed> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token'
    })
  });
  const body = (await response.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null;

  if (response.ok && body?.access_token) {
    return { ok: true, access_token: body.access_token, expires_in: Number(body.expires_in) || 3600 };
  }
  return { ok: false, revoked: body?.error === 'invalid_grant' };
}
