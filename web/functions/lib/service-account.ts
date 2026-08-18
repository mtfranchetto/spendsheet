/**
 * service-account.ts — the credential that reaches the Sheet.
 *
 * This is `01_jwt.gs` again, in WebCrypto instead of `Utilities`, against a
 * different issuer. Same RS256 shape, same base64url-without-padding rule,
 * same `nowSeconds` parameter so the claims are assertable. The one structural
 * difference is that Enable Banking takes the JWT *as* the credential, while
 * Google makes you trade it: sign an assertion, POST it to the token endpoint,
 * get an access token back, use that.
 *
 * ## Why a service account and not the user's own OAuth
 *
 * The browser never holds a credential for the spreadsheet. A user token would
 * have to be refreshed, refreshing depends on a Google session cookie that our
 * origin sees as third party, and Safari blocks it — which is the entire tax
 * that option A could not shed. Here the only thing the browser holds is our
 * own first-party session cookie, and the Sheet is reached by a key that lives
 * in a Cloudflare secret and never leaves the function.
 *
 * The Sheet is shared with this account as an Editor. That is the grant; there
 * is no consent screen and no scope review, because no user is delegating
 * anything.
 *
 * ## The token cache is module scope on purpose
 *
 * It lives as long as the isolate, not as long as the request, so most
 * requests skip the token exchange entirely. Being wrong costs one extra
 * `fetch`, and a `fetch` is I/O — which does not count against the 10ms CPU
 * budget. Being *stale* is what costs something, so it expires a minute early.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Google caps an assertion at an hour, and there is no reason to ask for less. */
const ASSERTION_TTL_SECONDS = 3600;

/** Renewed a minute before it expires, so no request rides the boundary. */
const RENEW_MARGIN_SECONDS = 60;

export type ServiceAccountKey = {
  client_email: string;
  private_key: string;
};

/**
 * The service-account JSON, from the secret.
 *
 * Thrown rather than returned as null: a function that cannot read its own
 * credential is misconfigured, not unauthorized, and the two must not produce
 * the same response. A 500 says "I am broken"; a 401 would say "you are not
 * allowed", which would send you looking at the wrong thing entirely.
 */
export function parseServiceAccount(json: string | undefined): ServiceAccountKey {
  if (!json) throw new Error('SERVICE_ACCOUNT_KEY is not set');

  const key = JSON.parse(json) as ServiceAccountKey;
  if (!key.client_email || !key.private_key) {
    throw new Error('SERVICE_ACCOUNT_KEY is missing client_email or private_key');
  }
  return key;
}

function b64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text));
}

/**
 * PEM to DER, tolerating both spellings of a newline.
 *
 * A key pasted through `wrangler secret put` keeps its real newlines; one
 * lifted out of the JSON by hand often arrives with literal backslash-n. Both
 * happen, and the failure is identical and unhelpful either way, so rather than
 * guess, everything outside the base64 alphabet is stripped. That is safe here
 * precisely because base64's alphabet excludes whitespace.
 *
 * This is the same trap `installCredentials()` exists for on the Apps Script
 * side — a procedure that silently corrupts a multi-line PEM is a trap, not a
 * procedure — arriving through a different door.
 */
function pemToDer(pem: string) {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/[^A-Za-z0-9+/=]/g, '');

  const binary = atob(body);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * The signed assertion Google trades for an access token.
 *
 * Exported and taking `nowSeconds` so it is testable without a network — the
 * claims are the part worth asserting on, exactly as in `01_jwt.gs`.
 */
export async function buildAssertion(
  key: ServiceAccountKey,
  nowSeconds: number,
  scope: string = SHEETS_SCOPE
): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + ASSERTION_TTL_SECONDS
  };

  const signingInput = b64urlText(JSON.stringify(header)) + '.' + b64urlText(JSON.stringify(payload));

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(key.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(signingInput)
  );

  return signingInput + '.' + b64url(new Uint8Array(signature));
}

let tokenCache: { token: string; until: number } | null = null;

/** An access token for the Sheets API, minted or reused. */
export async function accessToken(
  key: ServiceAccountKey,
  nowSeconds: number
): Promise<string> {
  if (tokenCache && tokenCache.until > nowSeconds) return tokenCache.token;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: GRANT_TYPE,
      assertion: await buildAssertion(key, nowSeconds)
    })
  });

  if (!response.ok) {
    // The body carries Google's own reason — an unshared Sheet and a bad key
    // are different problems with the same HTTP status, and only the body
    // tells them apart.
    throw new Error(`token exchange failed: ${response.status} ${await response.text()}`);
  }

  const granted = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    token: granted.access_token,
    until: nowSeconds + granted.expires_in - RENEW_MARGIN_SECONDS
  };
  return granted.access_token;
}

/** Test seam: drop the cached token. */
export function forgetAccessToken(): void {
  tokenCache = null;
}
