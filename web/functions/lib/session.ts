/**
 * session.ts — the cookie, which is the entire reason this option was chosen.
 *
 * The app's storage problem was never about expiry. On `script.google.com` the
 * page is third party to itself by the only definition WebKit counts, so its
 * `localStorage` is *partitioned and ephemeral* — an in-memory map that dies
 * with the application, and an iOS Home Screen web clip is an application iOS
 * ends whenever it wants the process back. Confirmed on the device: the copy
 * survives a reload in Safari and is gone after a force-quit.
 *
 * ITP's seven-day cap applies to **script-writable** storage: cookies written
 * from JavaScript, `localStorage`, IndexedDB. A cookie set by our own server in
 * a `Set-Cookie` header on a genuine first party is not capped and follows its
 * own `Max-Age`. That is the whole trade — and it is why the API must stay on
 * the Pages host. A separate `*.workers.dev` API is a different registrable
 * domain, which would make us third party again and throw away the one property
 * the architecture was chosen for.
 *
 * ## Why this is an HMAC and not a JWT
 *
 * Nothing else reads this token. A JWT buys interoperability with parties that
 * do not exist here, at the cost of a header nobody validates and an algorithm
 * field that is a well-known way to be talked into verifying nothing. The
 * payload is an email and an expiry; a MAC over it is the whole requirement.
 *
 * `now` is a parameter rather than read from the clock, so the function is
 * deterministic and the claims are assertable — the same reason `buildJwt` in
 * `01_jwt.gs` takes `nowSeconds`. A token whose `exp` depends on when the test
 * ran cannot be asserted on at all.
 */

const encoder = new TextEncoder();

/** Ninety days. Long because the point is surviving an OS that kills the app. */
export const SESSION_TTL_SECONDS = 90 * 24 * 60 * 60;

export const SESSION_COOKIE = '__Host-spendsheet';

export type Session = { email: string; exp: number };

/**
 * base64url: URL-safe alphabet and, critically, **no padding**.
 *
 * Same rule as `base64Url` in `01_jwt.gs`, for the same reason — a value
 * rejected for its padding looks exactly like a value rejected for a bad
 * signature, so it is stripped here rather than debugged later.
 */
function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Allocated from an explicit `ArrayBuffer` rather than from a length, because
// `new Uint8Array(n)` is typed over `ArrayBufferLike` — which includes
// `SharedArrayBuffer` — and `crypto.subtle` will not accept one.
function unb64url(text: string) {
  let padded = text.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/** `base64url(payload).base64url(mac)`. */
export async function signSession(
  email: string,
  nowSeconds: number,
  secret: string,
  ttlSeconds: number = SESSION_TTL_SECONDS
): Promise<string> {
  if (!secret) throw new Error('signSession: SESSION_SECRET is required');

  const payload: Session = { email, exp: nowSeconds + ttlSeconds };
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));

  return body + '.' + b64url(new Uint8Array(mac));
}

/**
 * The session a token proves, or `null`.
 *
 * **Every failure returns `null` and none of them says which.** A caller that
 * could tell "expired" from "forged" would be a caller that leaks whether a
 * secret is right, and there is nothing a client could usefully do differently
 * — both mean sign in again.
 *
 * Verification is `crypto.subtle.verify` rather than comparing two strings,
 * because a `===` on a MAC is a timing oracle. It is a small one over a local
 * network and it costs nothing to not have.
 */
export async function verifySession(
  token: string | null | undefined,
  nowSeconds: number,
  secret: string
): Promise<Session | null> {
  if (!token || !secret) return null;

  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;

  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);

  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      unb64url(mac),
      encoder.encode(body)
    );
    if (!ok) return null;

    const session = JSON.parse(new TextDecoder().decode(unb64url(body))) as Session;
    if (typeof session.email !== 'string' || !session.email) return null;
    if (typeof session.exp !== 'number' || session.exp <= nowSeconds) return null;

    return session;
  } catch {
    return null;
  }
}

/**
 * The `Set-Cookie` value.
 *
 * `__Host-` is a prefix the browser enforces rather than a naming convention:
 * it refuses the cookie unless it is `Secure`, `Path=/` and carries no
 * `Domain`, which makes it unsettable by any subdomain. Free, and it removes a
 * whole class of question about who else can write this cookie.
 *
 * `SameSite=Lax` rather than `Strict` because the sign-in flow returns from
 * Google and a `Strict` cookie is withheld on that navigation — the session
 * would be set and then invisible on the very next request, which presents as
 * a sign-in that silently does nothing.
 */
export function sessionCookie(token: string, ttlSeconds: number = SESSION_TTL_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${ttlSeconds}`
  ].join('; ');
}

/** Same attributes, zero age — a cookie is only cleared by a matching one. */
export function clearedCookie(): string {
  return sessionCookie('', 0);
}

/**
 * The CSRF state for one sign-in round trip.
 *
 * Short-lived and separate from the session, because it is a different claim
 * with a different lifetime: "this callback answers a sign-in *I* started",
 * asserted for the minute or two the redirect takes. Ten minutes is generous
 * for that and short enough that a leaked one is worthless.
 */
export const STATE_COOKIE = '__Host-spendsheet-state';
export const STATE_TTL_SECONDS = 600;

export function stateCookie(value: string, ttlSeconds: number = STATE_TTL_SECONDS): string {
  return [
    `${STATE_COOKIE}=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${ttlSeconds}`
  ].join('; ');
}

export function clearedStateCookie(): string {
  return stateCookie('', 0);
}

/**
 * A random value with no meaning beyond being unguessable.
 *
 * `crypto.getRandomValues` rather than `Math.random`, which is not a CSPRNG
 * anywhere and is the sort of substitution that never fails a test.
 */
export function randomToken(): string {
  const bytes = new Uint8Array(new ArrayBuffer(32));
  crypto.getRandomValues(bytes);
  return b64url(bytes);
}

/**
 * Constant-time string comparison, for the state check.
 *
 * A `===` on a secret is a timing oracle. It is a thin one across the public
 * internet, and it costs one loop to not have.
 */
export function sameToken(a: string | null, b: string | null): boolean {
  if (!a || !b || a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Pull one cookie out of a request's `Cookie` header. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
