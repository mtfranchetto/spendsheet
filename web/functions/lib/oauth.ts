/**
 * oauth.ts — signing in without putting a third party's script on the page.
 *
 * ## Why the redirect flow rather than the Google Identity Services button
 *
 * The plan called for the GIS button, and GIS needs `accounts.google.com/gsi/`
 * `client` loaded into the document. That is a script from an origin we do not
 * control, executing on the page that renders bank balances — which is the
 * exact objection raised against Firebase's SDK, and which invariant 3 ("no CDN
 * at runtime") forbids in as many words. A rule that bends for the convenient
 * case is not a rule.
 *
 * The authorization-code redirect needs no script at all. The browser leaves
 * for Google and comes back to `/api/callback`, which does the code exchange
 * server-side and sets the session cookie in the same response. The page stays
 * entirely first-party, and one fewer thing runs next to the balances.
 *
 * ## What it costs, and the risk phase 1 has to settle on the device
 *
 * One extra secret: `GOOGLE_CLIENT_SECRET`, for the code exchange.
 *
 * And one genuine unknown. **An iOS Home Screen web clip navigating to another
 * origin may hand off to Safari or to an in-app browser rather than staying in
 * the clip** — and a sign-in that completes in a different container from the
 * one that needed it sets the cookie somewhere useless. This cannot be
 * established in WebKit on a laptop; it is the same class of claim as the
 * storage measurement that was taken correctly and generalised too far. So it
 * is on phase 1's verification list, on the phone, from the icon.
 *
 * If it does hand off, the fallback is GIS with its script pinned and its own
 * exception written down — a contained swap, because everything either flow
 * produces arrives at the same place: an ID token, verified by
 * `verifyIdToken`, exchanged for our own cookie.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * Basic, non-sensitive, and nothing more.
 *
 * `openid email` is the whole request: we want to know who signed in, and the
 * data is reached by a service account that no user delegates anything to.
 * Nothing here triggers app verification or a scope review, and there is no
 * unverified-app screen between the owner and their own spreadsheet.
 */
const SCOPES = 'openid email';

/** Where Google sends the browser back. Derived, so it cannot drift per-env. */
export function callbackUrl(origin: string): string {
  return `${origin}/api/callback`;
}

/**
 * The URL to send the browser to.
 *
 * `prompt=select_account` rather than the default: the default silently reuses
 * whichever Google account the browser last used, so signing in as the wrong
 * one has no visible way back — you would get a refusal and no means of
 * choosing differently. Being asked every time is the cheap correct behaviour
 * for an app with exactly one permitted identity.
 */
export function authorizeUrl(origin: string, clientId: string, state: string): string {
  const url = new URL(AUTH_ENDPOINT);

  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', callbackUrl(origin));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('prompt', 'select_account');

  return url.toString();
}

export type CodeExchange = { id_token?: string };

/**
 * Trade the authorization code for an ID token.
 *
 * Only the `id_token` is kept. The access token Google also returns would
 * reach `userinfo` and nothing else we need, and a credential held for no
 * reason is a credential that can leak for no reason.
 */
export async function exchangeCode(
  code: string,
  origin: string,
  clientId: string,
  clientSecret: string
): Promise<string | null> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl(origin),
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) return null;

  const granted = (await response.json().catch(() => null)) as CodeExchange | null;
  return granted?.id_token ?? null;
}
