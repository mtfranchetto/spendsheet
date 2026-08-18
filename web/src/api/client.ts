/**
 * client.ts — one place that knows how to ask the server something.
 *
 * ## A dropped connection is not a refusal, and the page has always known it
 *
 * This is the rule that cost the most on the Apps Script side, so it is built
 * in here from the first call rather than added after it bites again. A
 * transport failure and a gate refusal used to be reported identically, so the
 * boot treated every failure as the gate and called `cacheForget()` on a
 * perfectly good copy — one queued execution, or one lift, and the next open
 * was cold with nothing on screen explaining why. It presented as *"two
 * refreshes give cached data and the third doesn't"*.
 *
 * On `fetch` the distinction is finally structural rather than guessed at: a
 * rejected promise is the transport, and a 401 is the gate. `ApiRefused` and
 * `ApiUnavailable` are separate types for that reason, and **anything acting on
 * the meaning of a failure has to ask which it was.**
 *
 * ## `credentials: same-origin` is not the default it looks like
 *
 * `fetch` omits cookies unless told, and the session cookie is `HttpOnly` — so
 * a forgotten `credentials` would present as a permanently signed-out app with
 * a cookie sitting right there in the jar, which is a confusing morning.
 */

export class ApiRefused extends Error {
  constructor() {
    super('Not available.');
    this.name = 'ApiRefused';
  }
}

export class ApiUnavailable extends Error {
  constructor(readonly cause?: unknown) {
    super('Could not reach the server.');
    this.name = 'ApiUnavailable';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, { ...init, credentials: 'same-origin' });
  } catch (cause) {
    // Never a refusal: the request did not arrive, so nothing decided anything
    // about it. Retrying is reasonable; forgetting a cached copy is not.
    throw new ApiUnavailable(cause);
  }

  if (response.status === 401) throw new ApiRefused();

  // A 5xx is the server having a bad time rather than a verdict about the
  // caller — including error 1102, which is what exceeding the CPU cap looks
  // like from out here and is emphatically not "you are not allowed".
  if (!response.ok) throw new ApiUnavailable(response.status);

  return (await response.json()) as T;
}

export type Health = {
  ok: boolean;
  build: string;
  configured: Record<string, boolean>;
};

export type Me = { email: string; exp: number };

export const api = {
  health: () => request<Health>('/api/health'),
  me: () => request<Me>('/api/me'),
  signOut: () => request<{ ok: boolean }>('/api/signout', { method: 'POST' }),

  /** A batch read of the book. Ranges are `tab!A1:AD`. */
  values: (ranges: string[]) => {
    const query = ranges.map((range) => `range=${encodeURIComponent(range)}`).join('&');
    return request<{ valueRanges?: { values?: unknown[][] }[] }>(`/api/values?${query}`);
  }
};

/** Sign-in is a navigation, not a fetch — see `functions/lib/oauth.ts`. */
export function goSignIn(): void {
  window.location.href = '/api/signin';
}
