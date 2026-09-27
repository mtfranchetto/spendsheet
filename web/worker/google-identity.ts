/**
 * google-identity.ts — proving who signed in, and whether they are let in.
 *
 * The code exchange hands back an **ID token**: a JWT signed by Google asserting
 * who signed in. It is verified once, at the callback; from then on the sealed
 * session cookie carries the answer.
 *
 * ## Admitted by account ID, never by address
 *
 * `ALLOWED_ACCOUNTS` lists Google account IDs — the token's `sub` — because an
 * address can change hands and an account ID never does. Someone refused is
 * shown their own ID and nothing else, which is how the owner learns theirs on
 * the first sign-in: read it off the refusal, add it to the secret, sign in
 * again.
 *
 * This is one of two independent locks. The other is `drive.file`: a grant
 * belongs to whoever picked the file, so an account let in by mistake still
 * cannot open a book that was never shared with it.
 *
 * ## What is checked, and why each one
 *
 * Verifying the signature alone proves Google issued the token and nothing
 * about who it was issued *to*. All four checks below are load-bearing:
 *
 *   `alg` must be RS256, taken from our own expectation rather than from the
 *   token's header. A verifier that believes the header about which algorithm
 *   to use is the classic way to be talked into verifying nothing.
 *
 *   `aud` must be our client ID. Without it, an ID token minted for *any*
 *   Google-signed-in site is a valid token here — the holder signs in as
 *   themselves somewhere else and replays it at us.
 *
 *   `iss` must be Google, in either of the two spellings it uses.
 *
 *   `email_verified` must be true. The allowlist compares `sub`, not the
 *   address, but the address is what the page shows you as "signed in as", and
 *   an unverified one is a claim rather than a fact.
 *
 * Expiry is checked against a `nowSeconds` parameter for the same reason
 * `buildJwt` in `01_jwt.gs` takes one: a token whose validity depends on when
 * the test ran cannot be asserted on.
 */

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];

export type IdentityClaims = {
  email: string;
  email_verified: boolean;
  aud: string;
  iss: string;
  exp: number;
  sub: string;
};

type Jwk = JsonWebKey & { kid: string; alg?: string };

/**
 * The key set, cached for as long as Google says.
 *
 * Module scope, so it lives as long as the isolate rather than as long as the
 * request — which on Workers means most requests skip the fetch entirely. It
 * costs nothing to be wrong about: a miss is one more `fetch`, and a `fetch` is
 * I/O, which does not count against the 10ms CPU budget.
 *
 * Refetched once on an unknown `kid` rather than only on expiry, because
 * Google rotates keys and the rotation is exactly when a cached set is both
 * unexpired and wrong.
 */
let jwksCache: { keys: Jwk[]; until: number } | null = null;

async function fetchJwks(nowSeconds: number): Promise<Jwk[]> {
  const response = await fetch(GOOGLE_JWKS_URL);
  if (!response.ok) throw new Error(`jwks: ${response.status}`);

  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '');
  const keys = ((await response.json()) as { keys: Jwk[] }).keys;

  jwksCache = { keys, until: nowSeconds + (maxAge ? Number(maxAge[1]) : 3600) };
  return keys;
}

async function signingKey(kid: string, nowSeconds: number): Promise<Jwk | null> {
  if (!jwksCache || jwksCache.until <= nowSeconds) await fetchJwks(nowSeconds);

  const hit = jwksCache?.keys.find((key) => key.kid === kid);
  if (hit) return hit;

  // Unknown kid against a cache that has not expired is what a key rotation
  // looks like from here, so ask once more before calling the token bad.
  await fetchJwks(nowSeconds);
  return jwksCache?.keys.find((key) => key.kid === kid) ?? null;
}

function b64urlToBytes(text: string) {
  let padded = text.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) padded += '=';
  const binary = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function decodeSegment<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(segment))) as T;
}

/**
 * The claims a Google ID token proves, or `null` if it proves nothing.
 *
 * Like `verifySession`, every failure is the same `null`. The caller has one
 * thing to do about any of them.
 *
 * @param clientId the OAuth client ID this deployment was built with
 */
export async function verifyIdToken(
  token: string | null | undefined,
  clientId: string,
  nowSeconds: number
): Promise<IdentityClaims | null> {
  if (!token || !clientId) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = decodeSegment<{ alg: string; kid: string }>(parts[0]);
    if (header.alg !== 'RS256' || !header.kid) return null;

    const jwk = await signingKey(header.kid, nowSeconds);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(parts[0] + '.' + parts[1])
    );
    if (!ok) return null;

    const claims = decodeSegment<IdentityClaims>(parts[1]);

    if (claims.aud !== clientId) return null;
    if (!GOOGLE_ISSUERS.includes(claims.iss)) return null;
    if (!(typeof claims.exp === 'number' && claims.exp > nowSeconds)) return null;
    if (claims.email_verified !== true) return null;
    if (typeof claims.email !== 'string' || !claims.email) return null;
    if (typeof claims.sub !== 'string' || !claims.sub) return null;

    return claims;
  } catch {
    return null;
  }
}

/**
 * Whether these claims belong to an account on the allowlist.
 *
 * `allowed` is the secret as stored: account IDs separated by commas, spaces or
 * newlines. Fails closed on an unset or empty list — a missing binding must
 * mean nobody gets in, not everybody — and an empty entry can never match,
 * because it is dropped before the comparison.
 */
export function isAllowed(claims: IdentityClaims | null, allowed: string | undefined): boolean {
  return Boolean(claims) && accountAllowed(claims!.sub, allowed);
}

/** The same test for an account ID a session already carries. */
export function accountAllowed(sub: string | undefined, allowed: string | undefined): boolean {
  if (typeof sub !== 'string' || !sub) return false;
  const ids = String(allowed ?? '').split(/[\s,]+/).filter(Boolean);
  return ids.includes(sub);
}

/** Test seam: drop the cached key set. */
export function forgetJwks(): void {
  jwksCache = null;
}
