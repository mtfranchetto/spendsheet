/**
 * client.ts — one place that knows how to ask the Worker something.
 *
 * ## A dropped connection is not a refusal
 *
 * This is the rule that cost the most on the Apps Script side, so it is built
 * in from the first call. A transport failure and a gate refusal used to be
 * reported identically, and the boot treated every failure as the gate — one
 * queued execution and a perfectly good cached copy was wiped. On `fetch` the
 * difference is structural: a rejected promise is the transport, a 401 is the
 * gate, and a 403 `no-access` is the book being out of this grant's reach,
 * which is a third thing again. **Anything acting on the meaning of a failure
 * has to ask which it was.**
 *
 * ## `credentials: same-origin` is not the default it looks like
 *
 * `fetch` omits cookies unless told, and the session cookie is `HttpOnly` — so
 * a forgotten `credentials` presents as a permanently signed-out app with a
 * cookie sitting right there in the jar.
 */

import type { RefusedAccount } from '../admit';

export class ApiRefused extends Error {
  constructor() {
    super('Not available.');
    this.name = 'ApiRefused';
  }
}

/** Signed in, but Google will not let this grant read the book. Pick it again at `/connect`. */
export class ApiNoAccess extends Error {
  constructor() {
    super('The viewer cannot read the book.');
    this.name = 'ApiNoAccess';
  }
}

export class ApiUnavailable extends Error {
  constructor(readonly cause?: unknown) {
    super('Could not reach the server.');
    this.name = 'ApiUnavailable';
  }
}

/** The response, once it is known to be a success. Everything else is one of the three errors. */
export async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, { ...init, credentials: 'same-origin' });
  } catch (cause) {
    // The request did not arrive, so nothing decided anything about it.
    throw new ApiUnavailable(cause);
  }

  if (response.status === 401) throw new ApiRefused();
  if (response.status === 403) {
    const body = (await response.clone().json().catch(() => null)) as { error?: string } | null;
    if (body?.error === 'no-access') throw new ApiNoAccess();
    throw new ApiRefused();
  }
  // A 5xx is the server or Google having a bad time — including error 1102,
  // the CPU cap — and emphatically not "you are not allowed".
  if (!response.ok) throw new ApiUnavailable(response.status);
  return response;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<T> {
  return (await (await call(path, init)).json()) as T;
}

export type Health = { ok: boolean; build: string; configured: Record<string, boolean> };
export type Me = { email: string; sub: string };
export type Book = { title: string; timeZone: string };
export type { RefusedAccount };

export const api = {
  health: () => json<Health>('/api/health'),
  me: () => json<Me>('/api/me'),
  book: () => json<Book>('/api/book'),
  // A POST from this page carries its own Origin, which is what the Worker checks.
  signOut: () => json<{ ok: boolean }>('/auth/signout', { method: 'POST' }),
  // Who this browser was just refused as, from the Worker's sealed cookie. No
  // refusal on record is an answer — `null` — rather than a failure to draw.
  refused: () => json<RefusedAccount>('/auth/refused').catch(() => null)
};

/** Sign-in is a navigation, not a fetch: the browser leaves for Google and comes back. */
export function goSignIn(): void {
  window.location.href = '/auth/signin';
}

export function goConnect(): void {
  window.location.href = '/connect';
}
