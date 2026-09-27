/**
 * router.ts — every route, and deliberately nothing about Cloudflare.
 *
 * The whole API is `(Request, Env, nowSeconds) => Response` over standard Web
 * APIs, so it runs under plain Vitest with no emulator, no `workerd` and no
 * `@cloudflare/workers-types`. `functions/api/[[path]].ts` is the five-line
 * adapter that hands Pages' context in. That split is the same seam this
 * project already draws between `21_query.gs` and `03_sheets.gs`: the logic is
 * pure and the platform is a thin edge around it.
 *
 * ## Pass-through is a design decision, not an implementation detail
 *
 * A free-plan Worker gets **10ms of CPU per invocation**. Waiting on `fetch`
 * does not count — only our own code does — so a route that returns the
 * upstream body without touching it costs essentially nothing, however many
 * megabytes of ledger flow through it. Overrunning is not a slowdown: the
 * isolate is killed mid-execution and the client gets error 1102 as a 5xx, and
 * it fails on the *size of the work* rather than on luck, which makes it a
 * cliff that gets closer as the ledger grows.
 *
 * So `/api/values` never parses. It streams. **And "proxy" has to mean
 * pass-through rather than transform** — a `TransformStream` touching each
 * chunk can hit 1102 halfway and truncate the body, which is worse than
 * failing, because a truncated JSON array is a shorter ledger rather than an
 * error. The aggregation runs in the browser, where there is no cap at all.
 *
 * `/api/ledger-probe` is the deliberate exception and it is throwaway — see
 * its own note.
 */

import {
  readCookie,
  signSession,
  verifySession,
  sessionCookie,
  clearedCookie,
  stateCookie,
  clearedStateCookie,
  randomToken,
  sameToken,
  SESSION_COOKIE,
  STATE_COOKIE
} from './session';
import { verifyIdToken, isOwner } from './google-identity';
import { authorizeUrl, exchangeCode } from './oauth';
import { parseServiceAccount, accessToken } from './service-account';
import { dataRows, records } from '../../src/sheets/records';

export type Env = {
  /** The one address allowed in. Unset means nobody, never everybody. */
  OWNER_EMAIL?: string;
  /** HMAC key for the session cookie. */
  SESSION_SECRET?: string;
  /** The OAuth client ID the sign-in redirect uses, and the `aud` we require. */
  GOOGLE_CLIENT_ID?: string;
  /** Its secret, for the authorization-code exchange. */
  GOOGLE_CLIENT_SECRET?: string;
  /** The service-account JSON, verbatim. */
  SERVICE_ACCOUNT_KEY?: string;
  /** The book. */
  SPREADSHEET_ID?: string;
  /** Stamped at build time so a deployed page can say which build it is. */
  BUILD_SHA?: string;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { ...JSON_HEADERS, ...(init.headers ?? {}) }
  });
}

/**
 * Every refusal, in one shape and with one message.
 *
 * The page already distinguishes a refusal from a dropped connection — that is
 * what `isTransportFailure` and `callOrRetry` are for, and getting it wrong
 * once meant a good cached copy was wiped whenever an execution queued. So the
 * status code carries the meaning and the body says nothing that would help
 * someone enumerate what went wrong.
 */
function refuse(): Response {
  return json({ error: 'Not available.' }, { status: 401 });
}

/**
 * The gate. Fails closed on a missing secret, a missing cookie, or anything it
 * cannot verify, and every one of those is the same 401.
 *
 * This is `requireOwner_` after the move, and it is a stronger thing than it
 * was: the `_` suffix in Apps Script decided only what was *named* to the
 * browser, and every other global stayed reachable. Here the network boundary
 * and the authorization boundary are the same line.
 */
async function session(request: Request, env: Env, nowSeconds: number) {
  const token = readCookie(request.headers.get('cookie'), SESSION_COOKIE);
  return verifySession(token, nowSeconds, env.SESSION_SECRET ?? '');
}

export async function handle(request: Request, env: Env, nowSeconds: number): Promise<Response> {
  const url = new URL(request.url);
  const route = url.pathname.replace(/^\/api\/?/, '');

  // Unauthenticated, and the only one. It says nothing about the book — a
  // build sha and whether the bindings exist, which is what you need to tell
  // "deployed wrong" from "configured wrong" without being signed in.
  if (route === 'health' && request.method === 'GET') {
    return json({
      ok: true,
      build: env.BUILD_SHA ?? 'dev',
      configured: {
        owner: Boolean(env.OWNER_EMAIL),
        session: Boolean(env.SESSION_SECRET),
        client: Boolean(env.GOOGLE_CLIENT_ID),
        credential: Boolean(env.SERVICE_ACCOUNT_KEY),
        spreadsheet: Boolean(env.SPREADSHEET_ID)
      }
    });
  }

  // Sign-in is two navigations, not a script. See `oauth.ts` for why the
  // Google Identity Services button was not used.
  if (route === 'signin' && request.method === 'GET') {
    if (!env.GOOGLE_CLIENT_ID) return json({ error: 'Not configured.' }, { status: 500 });

    const state = randomToken();
    return new Response(null, {
      status: 302,
      headers: {
        location: authorizeUrl(url.origin, env.GOOGLE_CLIENT_ID, state),
        'set-cookie': stateCookie(state)
      }
    });
  }

  if (route === 'callback' && request.method === 'GET') {
    return callback(request, env, url, nowSeconds);
  }

  if (route === 'signout' && request.method === 'POST') {
    return json({ ok: true }, { headers: { 'set-cookie': clearedCookie() } });
  }

  const signedIn = await session(request, env, nowSeconds);
  if (!signedIn) return refuse();

  if (route === 'me' && request.method === 'GET') {
    return json({ email: signedIn.email, exp: signedIn.exp });
  }

  // The read path, and the one that must never parse. `ranges` repeats, which
  // is `values.batchGet`'s own shape — one round trip for every tab a screen
  // needs rather than one per tab.
  if (route === 'values' && request.method === 'GET') {
    const ranges = url.searchParams.getAll('range');
    if (!ranges.length) return json({ error: 'range is required' }, { status: 400 });

    const upstream = await sheetsBatchGet(env, ranges, nowSeconds);

    // `upstream.body` rather than the text: the isolate never sees a chunk, so
    // the body costs no CPU whatever its size. Constructing a Response around
    // the same stream is still pass-through; what would not be is reading it.
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...JSON_HEADERS, 'cache-control': 'no-store' }
    });
  }

  if (route === 'ledger-probe' && request.method === 'GET') {
    return ledgerProbe(env, url, nowSeconds);
  }

  return json({ error: 'No such route.' }, { status: 404 });
}

/**
 * The return leg, and the only place a session is minted.
 *
 * Four things have to hold, and a failure of any of them lands the browser back
 * on `/?signin=failed` rather than on a JSON body — this is a *navigation*, so
 * the person is looking at a page, and a raw `{"error":…}` is not a screen.
 * The page decides what to say; the server does not leak which check failed.
 *
 * The state cookie is cleared on every exit, success or not. A one-shot value
 * that outlives its round trip is a replay waiting to happen.
 */
async function callback(request: Request, env: Env, url: URL, nowSeconds: number): Promise<Response> {
  const landing = (outcome: string) =>
    new Response(null, {
      status: 302,
      headers: { location: outcome === 'ok' ? '/' : `/?signin=${outcome}`, 'set-cookie': clearedStateCookie() }
    });

  const expected = readCookie(request.headers.get('cookie'), STATE_COOKIE);
  if (!sameToken(url.searchParams.get('state'), expected)) return landing('state');

  const code = url.searchParams.get('code');
  if (!code || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return landing('failed');

  const idToken = await exchangeCode(code, url.origin, env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET);
  const claims = await verifyIdToken(idToken, env.GOOGLE_CLIENT_ID, nowSeconds);

  // The one refusal worth naming to the page: signed in successfully, as
  // somebody else. "Nothing happened" would be the wrong story to tell, and it
  // is the story every other failure here gets.
  if (!isOwner(claims, env.OWNER_EMAIL)) return landing(claims ? 'wrong-account' : 'failed');

  const token = await signSession(claims!.email, nowSeconds, env.SESSION_SECRET ?? '');

  // Two cookies on one response: set the session, and retire the state. That
  // needs two `set-cookie` headers rather than one joined by a comma, and an
  // object literal cannot express it — a second key of the same name silently
  // replaces the first, so the state cookie would survive its own round trip.
  // `Headers.append` is the only thing that produces the pair.
  const headers = new Headers({ location: '/' });
  headers.append('set-cookie', sessionCookie(token));
  headers.append('set-cookie', clearedStateCookie());

  return new Response(null, { status: 302, headers });
}

async function sheetsBatchGet(env: Env, ranges: string[], nowSeconds: number): Promise<Response> {
  const key = parseServiceAccount(env.SERVICE_ACCOUNT_KEY);
  const token = await accessToken(key, nowSeconds);

  const endpoint = new URL(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values:batchGet`
  );
  for (const range of ranges) endpoint.searchParams.append('ranges', range);

  // UNFORMATTED_VALUE because every number this book holds is a number and a
  // locale-formatted string is a number someone has to parse back — and the
  // decimal comma makes that lossy in exactly the locale this project runs in.
  endpoint.searchParams.set('valueRenderOption', 'UNFORMATTED_VALUE');
  endpoint.searchParams.set('dateTimeRenderOption', 'SERIAL_NUMBER');

  return fetch(endpoint, { headers: { authorization: `Bearer ${token}` } });
}

/**
 * THROWAWAY. Delete at the end of phase 1.
 *
 * The one route that deliberately does what the design exists to avoid: it
 * parses the whole ledger and walks it, so the CPU figure on the Cloudflare
 * dashboard is a real measurement of the aggregation rather than an estimate.
 * That number is the only thing that would ever justify option C's D1 mirror.
 *
 * It does **not** gate anything. The recommended read path is pass-through,
 * which has nothing to parse, so a bad number here changes no decision already
 * made — it only says whether server-side aggregation was ever an option.
 *
 * Reports what it did rather than a duration, because a timing alone cannot
 * tell "the work was cheap" from "the work never happened" — the same reason
 * `LEDGER_SOURCE` exists on the Apps Script side.
 */
async function ledgerProbe(env: Env, url: URL, nowSeconds: number): Promise<Response> {
  const range = url.searchParams.get('range') ?? 'transactions!A1:AD';

  const upstream = await sheetsBatchGet(env, [range], nowSeconds);
  if (!upstream.ok) {
    return json({ error: 'upstream', status: upstream.status, body: await upstream.text() }, { status: 502 });
  }

  const payload = (await upstream.json()) as { valueRanges?: { values?: unknown[][] }[] };
  const values = payload.valueRanges?.[0]?.values ?? [];

  const headers = (values[0] ?? []).map(String);
  const rows = records(dataRows(values as never), headers as never);

  let total = 0;
  for (const row of rows) {
    const amount = Number((row as never as Record<string, unknown>)['amount_base']);
    if (Number.isFinite(amount)) total += amount;
  }

  return json({
    note: 'throwaway — delete at the end of phase 1',
    rangeAsked: range,
    rawRows: values.length,
    records: rows.length,
    columns: headers.length,
    summed: Math.round(total * 100) / 100
  });
}
