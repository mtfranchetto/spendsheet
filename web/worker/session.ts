/**
 * session.ts — three sealed cookies, and nothing stored on the server.
 *
 * The viewer holds your Google login in your own browser rather than in a
 * database, so there is no session store to run, pay for or leak. That makes
 * the cookie the credential, and three things follow from it.
 *
 * **It is sealed, not signed.** The session carries a Google refresh token,
 * which is enough to read the book as you, so it must be unreadable as well as
 * unforgeable. AES-GCM gives both in one primitive: a tampered or foreign
 * value fails to decrypt, and a stolen one is ciphertext. `SESSION_KEY` is the
 * only key; rotating it signs every device out at once, which is the intent.
 *
 * **The cookie's name is sealed into it.** Each value is encrypted with its
 * cookie name as associated data, so a value minted as one cookie cannot be
 * replayed as another — the short-lived sign-in cookie can never be presented
 * as a 400-day session, whatever it happens to contain.
 *
 * **It is set by the server, on the page's own origin.** WebKit caps what a
 * *script* can store at seven days and treats a Home Screen icon as its own
 * app; a server-set cookie on a first party follows its own `Max-Age`, and
 * since iOS 17.2 "Add to Home Screen" copies Safari's cookies into the icon.
 * Persistent rather than session-lifetime, because a WebKit bug on iOS 17 reset
 * session cookies at random in Home Screen apps.
 *
 * `now` is always a parameter, so every expiry is assertable in a test — the
 * same reason `buildJwt` in `01_jwt.gs` takes `nowSeconds`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 400 days: the most any browser honours, and a refresh token used daily lasts as long. */
export const SESSION_TTL_SECONDS = 400 * 24 * 60 * 60;

/** Long enough for a round trip through Google's consent screen, short enough that a leaked one is worthless. */
export const SIGNIN_TTL_SECONDS = 600;

/** Refreshed this long before Google says it expires, so a request never races the expiry. */
export const ACCESS_MARGIN_SECONDS = 60;

export const SESSION_COOKIE = '__Host-spendsheet';
export const ACCESS_COOKIE = '__Host-spendsheet-access';
export const SIGNIN_COOKIE = '__Host-spendsheet-signin';

/** Who you are, and the grant that lets the Worker read the book as you. */
export type Session = { sub: string; email: string; refresh_token: string; iat: number };

/** The hour-long access token, cached so most requests skip Google's token endpoint. */
export type Access = { sub: string; access_token: string; exp: number };

/** One sign-in round trip: the CSRF `state` and the PKCE verifier. */
export type SignIn = { state: string; verifier: string; iat: number };

/**
 * base64url with **no padding**. Same rule as `base64Url` in `01_jwt.gs`: a
 * value rejected for its padding looks exactly like a value rejected for being
 * forged, so padding is never produced here.
 */
export function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Allocated from an explicit `ArrayBuffer`, because `new Uint8Array(n)` is typed
// over `ArrayBufferLike` — which includes `SharedArrayBuffer` — and
// `crypto.subtle` will not accept one.
export function unb64url(text: string): Uint8Array<ArrayBuffer> {
  let padded = text.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * `SESSION_KEY` as an AES-256 key, or `null` if it is not one.
 *
 * Exactly 32 bytes of standard base64 — `openssl rand -base64 32`. Anything
 * else is refused rather than stretched, because a key derived from a short
 * typed string is a password, and the gate fails closed on a missing or
 * malformed key rather than sealing with whatever it was given.
 */
async function aesKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null;
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = unb64url(secret.trim());
  } catch {
    return null;
  }
  if (raw.length !== 32) return null;
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** `base64url(iv ‖ ciphertext)`, with the cookie's name as associated data. */
export async function seal(value: unknown, name: string, secret: string | undefined): Promise<string> {
  const key = await aesKey(secret);
  if (!key) throw new Error('seal: SESSION_KEY must be 32 bytes of base64');

  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(iv);
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(name) },
    key,
    encoder.encode(JSON.stringify(value))
  );

  const out = new Uint8Array(new ArrayBuffer(iv.length + sealed.byteLength));
  out.set(iv, 0);
  out.set(new Uint8Array(sealed), iv.length);
  return b64url(out);
}

/**
 * What a sealed value holds, or `null`.
 *
 * **Every failure is the same `null`.** Forged, tampered, sealed under another
 * key, sealed as another cookie, or not base64 at all: the caller has one thing
 * to do about any of them, and a caller that could tell them apart would be
 * one that leaks whether a key is right.
 */
export async function unseal<T>(token: string | null | undefined, name: string, secret: string | undefined): Promise<T | null> {
  if (!token) return null;
  const key = await aesKey(secret);
  if (!key) return null;

  try {
    const bytes = unb64url(token);
    if (bytes.length < 12 + 16) return null;
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(name) },
      key,
      bytes.slice(12)
    );
    return JSON.parse(decoder.decode(plain)) as T;
  } catch {
    return null;
  }
}

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * The session a cookie proves, or `null`.
 *
 * Expiry is checked here as well as by the browser's `Max-Age`, because a
 * cookie's lifetime is the browser's promise and the server has no reason to
 * take it. `iat` from the future is refused too: nothing this server minted can
 * have one.
 */
export async function openSession(token: string | null, nowSeconds: number, secret: string | undefined): Promise<Session | null> {
  const session = await unseal<Session>(token, SESSION_COOKIE, secret);
  if (!session) return null;
  if (!isText(session.sub) || !isText(session.email) || !isText(session.refresh_token)) return null;
  if (typeof session.iat !== 'number' || session.iat > nowSeconds) return null;
  if (session.iat + SESSION_TTL_SECONDS <= nowSeconds) return null;
  return session;
}

/**
 * A cached access token still worth using, for *this* account, or `null`.
 *
 * Bound to the session's `sub`: an access cookie left behind by a previous
 * sign-in on the same browser must not serve the next one.
 */
export async function openAccess(
  token: string | null,
  sub: string,
  nowSeconds: number,
  secret: string | undefined
): Promise<Access | null> {
  const access = await unseal<Access>(token, ACCESS_COOKIE, secret);
  if (!access || access.sub !== sub || !isText(access.access_token)) return null;
  if (typeof access.exp !== 'number' || access.exp - ACCESS_MARGIN_SECONDS <= nowSeconds) return null;
  return access;
}

export async function openSignIn(token: string | null, nowSeconds: number, secret: string | undefined): Promise<SignIn | null> {
  const signIn = await unseal<SignIn>(token, SIGNIN_COOKIE, secret);
  if (!signIn || !isText(signIn.state) || !isText(signIn.verifier)) return null;
  if (typeof signIn.iat !== 'number' || signIn.iat > nowSeconds) return null;
  if (signIn.iat + SIGNIN_TTL_SECONDS <= nowSeconds) return null;
  return signIn;
}

/**
 * A `Set-Cookie` value.
 *
 * `__Host-` is a prefix the browser enforces: it refuses the cookie unless it
 * is `Secure`, `Path=/` and has no `Domain`, so no subdomain can write it.
 *
 * `SameSite=Lax` rather than `Strict` because sign-in returns from Google as a
 * top-level navigation, and a `Strict` cookie is withheld on exactly that
 * request — a sign-in that sets the session and then cannot see it.
 */
export function cookie(name: string, value: string, maxAgeSeconds: number): string {
  return [`${name}=${value}`, 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${maxAgeSeconds}`].join('; ');
}

/** Same attributes, zero age — a cookie is only cleared by a matching one. */
export function clearCookie(name: string): string {
  return cookie(name, '', 0);
}

/** An unguessable value. `crypto.getRandomValues`, never `Math.random`. */
export function randomToken(bytes = 32): string {
  const out = new Uint8Array(new ArrayBuffer(bytes));
  crypto.getRandomValues(out);
  return b64url(out);
}

/** Constant-time comparison, for the `state` check. */
export function sameToken(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** One cookie out of a request's `Cookie` header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
