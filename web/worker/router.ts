/**
 * router.ts — every route the Worker answers, and deliberately nothing about
 * Cloudflare.
 *
 * The whole Worker is `(Request, Env, nowSeconds) => Response` over standard
 * Web APIs, so it runs under plain Vitest with no emulator. `index.ts` is the
 * adapter. Static files never reach this code: `run_worker_first` sends only
 * `/api/*`, `/auth/*` and `/connect` here, so the page and its assets are
 * served without a line of it running — and a flood that spends the free
 * plan's daily requests breaks refreshing, never the page.
 *
 * ## The order every request goes through
 *
 *   1. **Origin**, for anything that is not a GET. `SameSite=Lax` already keeps
 *      the cookie off another site's POST, and `workers.dev` is on the public
 *      suffix list so a neighbouring Worker is another site; this is one line
 *      that relies on neither.
 *   2. **The gate**: a session cookie that unseals, for an account on the
 *      allowlist at the time it was minted. Everything past this line has one.
 *   3. **Google access**: the cached access token, or a refresh. A revoked
 *      grant clears the session; Google having a bad moment does not.
 *
 * A refusal at any step happens **before anything reaches Google**, and the
 * tests hold it to that by failing on any `fetch`.
 *
 * ## Reads pass through; nothing here writes yet
 *
 * A free-plan Worker gets 10ms of CPU per request, and waiting on `fetch` does
 * not count. So `/api/read` hands Google's body back without reading it: it
 * costs the same at forty rows or forty thousand. It can only ask for the tabs
 * in `READ_RANGES`, only of `SPREADSHEET_ID`, and only with `values.batchGet` —
 * so it is never an open proxy to Google carrying your token. Writes arrive in
 * phase 5 as named actions carrying `22_actions.gs`'s checks; a raw write
 * pass-through could not tell a confirmation from an overwrite of history.
 */

import {
  readCookie,
  seal,
  openSession,
  openAccess,
  openSignIn,
  cookie,
  clearCookie,
  randomToken,
  sameToken,
  SESSION_COOKIE,
  ACCESS_COOKIE,
  SIGNIN_COOKIE,
  SESSION_TTL_SECONDS,
  SIGNIN_TTL_SECONDS,
  isSessionKey,
  type Session
} from './session';
import { verifyIdToken, isAllowed, accountAllowed } from './google-identity';
import { authorizeUrl, exchangeCode, refreshAccess } from './oauth';
import { connectPage } from './connect';

export type Env = {
  /** The OAuth client the sign-in redirect uses, and the `aud` an ID token must carry. */
  GOOGLE_CLIENT_ID?: string;
  /** Its secret, for the code exchange and refreshes. */
  GOOGLE_CLIENT_SECRET?: string;
  /** 32 bytes of base64. Seals every cookie; rotating it signs every device out. */
  SESSION_KEY?: string;
  /** Google account IDs (`sub`) allowed in, separated by commas. Unset means nobody. */
  ALLOWED_ACCOUNTS?: string;
  /** The book. A secret only because the repository is public. */
  SPREADSHEET_ID?: string;
  /** The Picker's API key, restricted in the console to this origin and the Picker API. */
  PICKER_API_KEY?: string;
  /** The Cloud project number. Without it the Picker records no `drive.file` grant. */
  GOOGLE_PROJECT_NUMBER?: string;
  /** Stamped at deploy, so a page can say which build answered it. */
  BUILD_SHA?: string;
};

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * The only ranges the read route will ask for, keyed by the name a page uses.
 *
 * Wide enough for each tab's schema (`transactions` ends at AD), and quoted
 * because a tab name starting with `_` is one A1 notation is entitled to read
 * as something else. Phase 3 reads all of them in one `batchGet`.
 */
export const READ_RANGES: Record<string, string> = {
  transactions: "'transactions'!A1:AD",
  accounts: "'accounts'!A1:Z",
  categories: "'categories'!A1:Z",
  labels: "'labels'!A1:Z",
  pending: "'pending'!A1:Z",
  _status: "'_status'!A1:Z",
  _runs: "'_runs'!A1:Z",
  _config: "'_config'!A1:Z",
  _memory: "'_memory'!A1:Z",
  _monitor: "'_monitor'!A1:Z",
  _removed: "'_removed'!A1:AD"
};

const SECURITY_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(JSON.stringify(body), { status, headers });
}

/** A navigation, with any number of cookies — `Headers.append` is the only way to send two. */
function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ ...SECURITY_HEADERS, location });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 302, headers });
}

/**
 * Every refusal in one shape and one message.
 *
 * The page tells a refusal from a dropped connection by the status, not the
 * body — the distinction that once cost a good cached copy on every queued
 * execution — so the body says nothing that would help someone enumerate what
 * went wrong.
 */
const refuse = (cookies: string[] = []) => json({ error: 'Not available.' }, 401, cookies);

/** The book is there but this grant cannot open it: pick it again at `/connect`. */
const noAccess = (cookies: string[]) => json({ error: 'no-access' }, 403, cookies);

const signedOut = () => [clearCookie(SESSION_COOKIE), clearCookie(ACCESS_COOKIE)];

/** `cached` says the token came from the cookie rather than a refresh just now. */
type Authorized = { session: Session; token: string; cookies: string[]; cached: boolean };

/**
 * A fresh access token from the session's refresh token, sealed into its
 * cookie. A revoked grant signs out; Google having a bad moment does not.
 */
async function renew(session: Session, env: Env, nowSeconds: number): Promise<Authorized | Response> {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return json({ error: 'Not configured.' }, 500);
  const refreshed = await refreshAccess(session.refresh_token, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  if (!refreshed.ok) return refreshed.revoked ? refuse(signedOut()) : json({ error: 'google-unavailable' }, 503);

  const access = { sub: session.sub, access_token: refreshed.access_token, exp: nowSeconds + refreshed.expires_in };
  const sealed = await seal(access, ACCESS_COOKIE, env.SESSION_KEY);
  return { session, token: refreshed.access_token, cookies: [cookie(ACCESS_COOKIE, sealed, refreshed.expires_in)], cached: false };
}

/**
 * A call to Google as the signed-in account: the upstream response, or the
 * Worker's own answer when there is nothing to pass on.
 *
 * A 401 on a *cached* token is retried once with a fresh one. Google can stop
 * honouring a token before its `exp` — the grant revoked under Third-party
 * connections, say — and without the retry the cookie would go on presenting
 * it for up to an hour, every read failing as if Google were down. The refresh
 * then either recovers or reports `invalid_grant`, which signs out. A 401 on a
 * token minted a moment ago is not worth a second refresh, so it clears the
 * cookie and reports Google unavailable.
 */
async function googleFetch(
  url: string | URL,
  env: Env,
  nowSeconds: number,
  granted: Authorized
): Promise<{ upstream: Response } | { answer: Response }> {
  const ask = () => fetch(url, { headers: { authorization: `Bearer ${granted.token}` } });

  let upstream = await ask();
  if (upstream.status === 401 && granted.cached) {
    const renewed = await renew(granted.session, env, nowSeconds);
    if (renewed instanceof Response) return { answer: renewed };
    Object.assign(granted, renewed);
    upstream = await ask();
  }
  if (upstream.status === 401) {
    return { answer: json({ error: 'google-unavailable' }, 503, [clearCookie(ACCESS_COOKIE)]) };
  }
  if (upstream.status === 403 || upstream.status === 404) return { answer: noAccess(granted.cookies) };
  if (!upstream.ok) return { answer: json({ error: 'upstream', status: upstream.status }, 502, granted.cookies) };
  return { upstream };
}

/**
 * Steps 2 and 3: a session, and a Google access token to act on it with.
 *
 * Returns a `Response` when the answer is no. The new access cookie, when a
 * refresh happened, rides on whatever the route answers.
 */
async function authorize(request: Request, env: Env, nowSeconds: number): Promise<Authorized | Response> {
  const cookies = request.headers.get('cookie');
  const session = await openSession(readCookie(cookies, SESSION_COOKIE), nowSeconds, env.SESSION_KEY);
  if (!session) return refuse();

  // The allowlist is asked again on every request, not only at sign-in: taking
  // someone off it has to end their access now, not in 400 days.
  if (!accountAllowed(session.sub, env.ALLOWED_ACCOUNTS)) return refuse(signedOut());

  const cached = await openAccess(readCookie(cookies, ACCESS_COOKIE), session.sub, nowSeconds, env.SESSION_KEY);
  if (cached) return { session, token: cached.access_token, cookies: [], cached: true };
  return renew(session, env, nowSeconds);
}

export async function handle(request: Request, env: Env, nowSeconds: number): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  // Step 1, before routing: nothing that changes state is answered for another origin.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (request.headers.get('origin') !== url.origin) return json({ error: 'Not available.' }, 403);
  }

  if (path === '/api/health' && request.method === 'GET') return health(env);
  if (path === '/auth/signin' && request.method === 'GET') return signIn(env, url, nowSeconds);
  if (path === '/auth/callback' && request.method === 'GET') return callback(request, env, url, nowSeconds);
  if (path === '/auth/signout' && request.method === 'POST') return json({ ok: true }, 200, signedOut());

  if (path === '/connect' && request.method === 'GET') {
    const granted = await authorize(request, env, nowSeconds);
    // A navigation, so a refusal is a sign-in rather than a JSON body nobody renders.
    if (granted instanceof Response) return redirect('/auth/signin');
    return connectPage(env, granted.token, granted.cookies);
  }

  if (!path.startsWith('/api/')) return json({ error: 'No such route.' }, 404);

  const granted = await authorize(request, env, nowSeconds);
  if (granted instanceof Response) return granted;

  if (path === '/api/me' && request.method === 'GET') {
    // Who, and nothing else. No route but `/connect` ever returns a token.
    return json({ email: granted.session.email, sub: granted.session.sub }, 200, granted.cookies);
  }
  if (path === '/api/book' && request.method === 'GET') return book(env, nowSeconds, granted);
  if (path === '/api/read' && request.method === 'GET') return read(env, url, nowSeconds, granted);

  return json({ error: 'No such route.' }, 404, granted.cookies);
}

/**
 * Unauthenticated, and says nothing about the book: a build and which bindings
 * exist, which tells "deployed wrong" from "configured wrong" before sign-in.
 */
function health(env: Env): Response {
  return json({
    ok: true,
    build: env.BUILD_SHA ?? 'dev',
    configured: {
      client: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      // Its shape, not its presence: a key pasted without base64 is set and useless.
      sessionKey: isSessionKey(env.SESSION_KEY),
      allowedAccounts: Boolean(env.ALLOWED_ACCOUNTS),
      spreadsheet: Boolean(env.SPREADSHEET_ID),
      picker: Boolean(env.PICKER_API_KEY && env.GOOGLE_PROJECT_NUMBER)
    }
  });
}

async function signIn(env: Env, url: URL, nowSeconds: number): Promise<Response> {
  if (!env.GOOGLE_CLIENT_ID || !isSessionKey(env.SESSION_KEY)) return json({ error: 'Not configured.' }, 500);

  const state = randomToken();
  const verifier = randomToken(48);
  const sealed = await seal({ state, verifier, iat: nowSeconds }, SIGNIN_COOKIE, env.SESSION_KEY);
  return redirect(await authorizeUrl(url.origin, env.GOOGLE_CLIENT_ID, state, verifier), [
    cookie(SIGNIN_COOKIE, sealed, SIGNIN_TTL_SECONDS)
  ]);
}

/**
 * The return leg, and the only place a session is minted.
 *
 * Every failure lands on `/?signin=<outcome>` rather than a JSON body — this is
 * a navigation, so the person is looking at a page — and the sign-in cookie is
 * cleared on every exit, because a one-shot value that outlives its round trip
 * is a replay waiting to happen.
 *
 * A refusal names the account ID and nothing else: it is how you learn yours to
 * put on the allowlist, and it tells a stranger only who they already are.
 */
async function callback(request: Request, env: Env, url: URL, nowSeconds: number): Promise<Response> {
  const done = clearCookie(SIGNIN_COOKIE);
  const land = (outcome: string) => redirect(`/?signin=${outcome}`, [done]);

  const signIn = await openSignIn(readCookie(request.headers.get('cookie'), SIGNIN_COOKIE), nowSeconds, env.SESSION_KEY);
  if (!signIn || !sameToken(url.searchParams.get('state'), signIn.state)) return land('state');

  const code = url.searchParams.get('code');
  if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return land('failed');

  const grant = await exchangeCode(code, signIn.verifier, url.origin, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  if (!grant) return land('failed');

  const claims = await verifyIdToken(grant.id_token, env.GOOGLE_CLIENT_ID, nowSeconds);
  if (!claims) return land('failed');
  if (!isAllowed(claims, env.ALLOWED_ACCOUNTS)) {
    return redirect(`/?signin=refused&account=${encodeURIComponent(claims.sub)}`, [done]);
  }

  const session: Session = { sub: claims.sub, email: claims.email, refresh_token: grant.refresh_token, iat: nowSeconds };
  const access = { sub: claims.sub, access_token: grant.access_token, exp: nowSeconds + grant.expires_in };

  return redirect('/', [
    cookie(SESSION_COOKIE, await seal(session, SESSION_COOKIE, env.SESSION_KEY), SESSION_TTL_SECONDS),
    cookie(ACCESS_COOKIE, await seal(access, ACCESS_COOKIE, env.SESSION_KEY), grant.expires_in),
    done
  ]);
}

/**
 * The book's title and timezone — the proof that the grant took, and the zone
 * "today" is reckoned in.
 *
 * 403 and 404 both mean this grant cannot see the book: never picked, access
 * removed, or the book replaced by a copy. The page answers all three the same
 * way, with a link to `/connect`.
 */
async function book(env: Env, nowSeconds: number, granted: Authorized): Promise<Response> {
  if (!env.SPREADSHEET_ID) return json({ error: 'Not configured.' }, 500, granted.cookies);

  const got = await googleFetch(
    `${SHEETS}/${encodeURIComponent(env.SPREADSHEET_ID)}?fields=properties(title,timeZone)`,
    env,
    nowSeconds,
    granted
  );
  if ('answer' in got) return got.answer;

  const body = (await got.upstream.json()) as { properties?: { title?: string; timeZone?: string } };
  return json({ title: body.properties?.title ?? '', timeZone: body.properties?.timeZone ?? '' }, 200, granted.cookies);
}

/**
 * One `values.batchGet`, handed back unread.
 *
 * `?tab=` repeats and names keys of `READ_RANGES`; none means all of them. An
 * unknown name is refused before anything is fetched, rather than dropped —
 * a page asking for a tab this route does not serve has a bug worth hearing.
 *
 * `Server-Timing` carries how long Google took to answer, measured to the
 * headers: the one number phase 2 exists to take, and one a page can read
 * beside its own clock to tell Google's share from the network's.
 */
async function read(env: Env, url: URL, nowSeconds: number, granted: Authorized): Promise<Response> {
  if (!env.SPREADSHEET_ID) return json({ error: 'Not configured.' }, 500, granted.cookies);

  const asked = url.searchParams.getAll('tab');
  const tabs = asked.length ? asked : Object.keys(READ_RANGES);
  if (tabs.some((tab) => !Object.hasOwn(READ_RANGES, tab))) {
    return json({ error: 'unknown tab' }, 400, granted.cookies);
  }

  const endpoint = new URL(`${SHEETS}/${encodeURIComponent(env.SPREADSHEET_ID)}/values:batchGet`);
  for (const tab of tabs) endpoint.searchParams.append('ranges', READ_RANGES[tab]);
  // Unformatted, because a locale-formatted number is one someone has to parse
  // back, and the decimal comma makes that lossy in the locale this book is in.
  // Serial dates, because `records.ts` turns them into day numbers with no
  // timezone involved.
  endpoint.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
  endpoint.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');

  const started = Date.now();
  const got = await googleFetch(endpoint, env, nowSeconds, granted);
  const took = Date.now() - started;
  if ('answer' in got) return got.answer;
  const upstream = got.upstream;

  const headers = new Headers({
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'server-timing': `google;dur=${took}`
  });
  for (const value of granted.cookies) headers.append('set-cookie', value);
  return new Response(upstream.body, { status: 200, headers });
}
