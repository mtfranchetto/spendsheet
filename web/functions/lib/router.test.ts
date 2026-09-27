/**
 * The API surface, tested for what it refuses.
 *
 * Every case here runs without a network. That is not a convenience — it is
 * the point: each one asserts that a request is turned away *before* anything
 * reaches for a credential or the Sheet. A gate that only fails after the
 * upstream call is a gate that leaks a credential's worth of behaviour to
 * whoever is knocking.
 *
 * The one route that answers unauthenticated is `/api/health`, and it is here
 * to prove it says nothing about the book.
 */

import { describe, it, expect } from 'vitest';
import { handle, type Env } from './router';
import { signSession, sessionCookie, SESSION_COOKIE, STATE_COOKIE } from './session';

const NOW = 1_770_000_000;

const ENV: Env = {
  OWNER_EMAIL: 'owner@example.com',
  SESSION_SECRET: 'test-secret',
  GOOGLE_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  SERVICE_ACCOUNT_KEY: '{"client_email":"sa@example.com","private_key":"-----BEGIN PRIVATE KEY-----\\nAA==\\n-----END PRIVATE KEY-----"}',
  SPREADSHEET_ID: 'book-1',
  BUILD_SHA: 'abc1234'
};

function get(path: string, cookie?: string): Request {
  return new Request(`https://spendsheet.pages.dev${path}`, {
    headers: cookie ? { cookie } : {}
  });
}

function post(path: string, body?: unknown, cookie?: string): Request {
  return new Request(`https://spendsheet.pages.dev${path}`, {
    method: 'POST',
    headers: cookie ? { cookie } : {},
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function ownerCookie(env: Env = ENV): Promise<string> {
  const token = await signSession('owner@example.com', NOW, env.SESSION_SECRET!);
  return `${SESSION_COOKIE}=${token}`;
}

describe('/api/health', () => {
  it('answers without a session', async () => {
    const response = await handle(get('/api/health'), ENV, NOW);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, build: 'abc1234' });
  });

  // It has to be useful for telling "deployed wrong" from "configured wrong"
  // while saying nothing a stranger could use.
  it('reports which bindings exist, never their values', async () => {
    const body = await (await handle(get('/api/health'), ENV, NOW)).json() as any;

    expect(body.configured).toEqual({
      owner: true, session: true, client: true, credential: true, spreadsheet: true
    });
    expect(JSON.stringify(body)).not.toContain('owner@example.com');
    expect(JSON.stringify(body)).not.toContain('book-1');
  });

  it('says so when a binding is missing rather than pretending', async () => {
    const body = await (await handle(get('/api/health'), {}, NOW)).json() as any;

    expect(body.configured.credential).toBe(false);
    expect(body.build).toBe('dev');
  });
});

describe('the gate', () => {
  // Each of these would otherwise reach for the service-account key. There is
  // no `fetch` mocked in this file, so any of them getting that far would fail
  // the test by throwing rather than by asserting — which is the outcome we
  // want either way.
  it.each(['/api/me', '/api/values?range=transactions!A1:AD', '/api/ledger-probe'])(
    'refuses %s with no cookie, before touching the credential',
    async (path) => {
      const response = await handle(get(path), ENV, NOW);

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'Not available.' });
    }
  );

  it('refuses a forged cookie', async () => {
    const token = await signSession('owner@example.com', NOW, 'a-different-secret');

    const response = await handle(get('/api/me', `${SESSION_COOKIE}=${token}`), ENV, NOW);
    expect(response.status).toBe(401);
  });

  it('refuses an expired cookie', async () => {
    const token = await signSession('owner@example.com', NOW, ENV.SESSION_SECRET!, 60);

    const response = await handle(get('/api/me', `${SESSION_COOKIE}=${token}`), ENV, NOW + 61);
    expect(response.status).toBe(401);
  });

  // A missing SESSION_SECRET must lock everyone out, not let everyone in.
  // This is the failure mode of a half-configured deployment.
  it('refuses everything when the session secret is unset', async () => {
    const cookie = await ownerCookie();

    const response = await handle(get('/api/me', cookie), { ...ENV, SESSION_SECRET: undefined }, NOW);
    expect(response.status).toBe(401);
  });

  it('lets the owner through', async () => {
    const response = await handle(get('/api/me', await ownerCookie()), ENV, NOW);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ email: 'owner@example.com' });
  });

  it('404s an unknown route only after the gate, not before', async () => {
    expect((await handle(get('/api/nope'), ENV, NOW)).status).toBe(401);
    expect((await handle(get('/api/nope', await ownerCookie()), ENV, NOW)).status).toBe(404);
  });
});

describe('/api/signin', () => {
  it('redirects to Google asking only for openid and email', async () => {
    const response = await handle(get('/api/signin'), ENV, NOW);

    expect(response.status).toBe(302);

    const target = new URL(response.headers.get('location')!);
    expect(target.origin).toBe('https://accounts.google.com');
    expect(target.searchParams.get('scope')).toBe('openid email');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('redirect_uri')).toBe('https://spendsheet.pages.dev/api/callback');
  });

  // The default silently reuses the last Google account, which leaves someone
  // signed in as the wrong one with no visible way to choose again.
  it('always offers the account chooser', async () => {
    const response = await handle(get('/api/signin'), ENV, NOW);

    expect(new URL(response.headers.get('location')!).searchParams.get('prompt')).toBe('select_account');
  });

  it('plants a state cookie matching the state it sent', async () => {
    const response = await handle(get('/api/signin'), ENV, NOW);

    const sent = new URL(response.headers.get('location')!).searchParams.get('state');
    expect(sent).toBeTruthy();
    expect(response.headers.get('set-cookie')).toContain(`${STATE_COOKIE}=${sent}`);
  });

  it('sends a different state every time', async () => {
    const a = await handle(get('/api/signin'), ENV, NOW);
    const b = await handle(get('/api/signin'), ENV, NOW);

    const stateOf = (r: Response) => new URL(r.headers.get('location')!).searchParams.get('state');
    expect(stateOf(a)).not.toBe(stateOf(b));
  });
});

describe('/api/callback', () => {
  // Each of these fails before the code exchange, so none reaches a network.
  it('refuses a callback whose state does not match the cookie', async () => {
    const response = await handle(
      get('/api/callback?code=abc&state=attacker', `${STATE_COOKIE}=mine`),
      ENV,
      NOW
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/?signin=state');
  });

  // The bare-CSRF case: no cookie at all means the browser never started this.
  it('refuses a callback with no state cookie', async () => {
    const response = await handle(get('/api/callback?code=abc&state=anything'), ENV, NOW);

    expect(response.headers.get('location')).toBe('/?signin=state');
  });

  it('refuses a callback carrying no code', async () => {
    const response = await handle(get('/api/callback?state=s', `${STATE_COOKIE}=s`), ENV, NOW);

    expect(response.headers.get('location')).toBe('/?signin=failed');
  });

  // Unset owner means nobody. A half-configured deployment must not be one
  // that admits the first person to sign in.
  it('refuses when the client secret is unset rather than proceeding', async () => {
    const response = await handle(
      get('/api/callback?code=abc&state=s', `${STATE_COOKIE}=s`),
      { ...ENV, GOOGLE_CLIENT_SECRET: undefined },
      NOW
    );

    expect(response.headers.get('location')).toBe('/?signin=failed');
  });

  it('retires the state cookie on the way out, whatever happened', async () => {
    const response = await handle(get('/api/callback?code=abc&state=no'), ENV, NOW);

    expect(response.headers.get('set-cookie')).toContain(`${STATE_COOKIE}=`);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('never sets a session cookie on a failed sign-in', async () => {
    const response = await handle(get('/api/callback?code=abc&state=no'), ENV, NOW);

    expect(response.headers.get('set-cookie')).not.toContain(SESSION_COOKIE + '=');
  });
});

describe('/api/signout', () => {
  it('clears the cookie without needing a valid one', async () => {
    const response = await handle(post('/api/signout'), ENV, NOW);

    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  });
});

describe('/api/values', () => {
  it('requires at least one range', async () => {
    const response = await handle(get('/api/values', await ownerCookie()), ENV, NOW);

    expect(response.status).toBe(400);
  });
});

describe('cookie shape', () => {
  it('is what the browser needs to keep it past seven days', () => {
    const cookie = sessionCookie('tok');

    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toMatch(/Max-Age=\d{6,}/);
  });
});
