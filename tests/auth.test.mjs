/**
 * The consent round-trip.
 *
 * `doGet` is a publicly reachable endpoint — it has to be, because the bank's
 * redirect arrives with no Google session attached. The state nonce is the
 * whole of what protects it, so it gets tested as a security boundary rather
 * than as a happy path: every way a callback can be illegitimate is a case
 * here, and each one must be rejected without explaining why.
 *
 * What a session *means* once it arrives is 06_accounts.gs, and is tested in
 * accounts.test.mjs.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { load } from './harness.mjs';

const ctx = load();

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
});

const CREDS = { EB_ENV: 'SANDBOX', EB_SANDBOX_APP_ID: 'app', EB_SANDBOX_KEY: privateKey };

/**
 * The real shape, captured from a live Mock ASPSP session: `accounts` holds
 * UID strings and `accounts_data` holds the descriptions. This fixture is a
 * recording, not a guess — the previous guess had them merged, which read
 * zero accounts from a perfectly good session.
 */
const SESSION = {
  session_id: 'sess-42',
  status: 'AUTHORIZED',
  aspsp: { name: 'Mock ASPSP', country: 'IT' },
  psu_type: 'business',
  access: { accounts: null, balances: true, transactions: true, valid_until: '2027-01-26T19:55:29.069000Z' },
  accounts: ['acc-1', 'acc-2'],
  accounts_data: [
    { uid: 'acc-1', name: 'Current', currency: 'EUR', account_id: { iban: 'FI2112345600000785' } },
    { uid: 'acc-2', name: 'Savings', currency: 'EUR', account_id: { iban: 'FI2112345600000999' } }
  ]
};

/** Mock ASPSP itself returns no descriptive fields at all — only identifiers. */
const SPARSE_SESSION = {
  session_id: 'sess-43',
  status: 'AUTHORIZED',
  aspsp: { name: 'Mock ASPSP', country: 'IT' },
  access: { valid_until: '2027-01-26T19:55:29.069000Z' },
  accounts: ['a8160088-28a0-45f2-ba4d-3c7959863f92'],
  accounts_data: [{
    uid: 'a8160088-28a0-45f2-ba4d-3c7959863f92',
    identification_hash: 'WwpbCiJhc3BzcF9uYW1lIgpdLApb.BqpDfy',
    identification_hashes: ['WwpbCiJhc3BzcF9uYW1lIgpdLApb.BqpDfy']
  }]
};

/** A context with the sheet built, credentials installed and the API scripted. */
function connected(fetch) {
  const c = load({ properties: { ...CREDS }, fetch });
  c.setup();
  return c;
}

describe('validateAuthState', () => {
  const NOW = 1_000_000;
  const TTL = 1000;
  const stored = { state: 'abc', createdAt: NOW };

  it('accepts the nonce it issued, and marks it spent', () => {
    expect(ctx.validateAuthState(stored, 'abc', NOW + 500, TTL))
      .toEqual({ ok: true, reason: null, consume: true });
  });

  it('rejects a callback for a flow that was never started', () => {
    expect(ctx.validateAuthState(null, 'abc', NOW, TTL).ok).toBe(false);
    expect(ctx.validateAuthState({}, 'abc', NOW, TTL).ok).toBe(false);
  });

  it('rejects a mismatched or absent state', () => {
    // Without this, anyone with the URL could attach a bank session of
    // their choosing to the sheet.
    expect(ctx.validateAuthState(stored, 'wrong', NOW, TTL).ok).toBe(false);
    expect(ctx.validateAuthState(stored, '', NOW, TTL).ok).toBe(false);
    expect(ctx.validateAuthState(stored, undefined, NOW, TTL).ok).toBe(false);
  });

  it('rejects a nonce past its TTL, at the boundary', () => {
    expect(ctx.validateAuthState(stored, 'abc', NOW + TTL, TTL).ok).toBe(true);
    expect(ctx.validateAuthState(stored, 'abc', NOW + TTL + 1, TTL).ok).toBe(false);
  });

  it('rejects a record with no issue time rather than treating it as fresh', () => {
    expect(ctx.validateAuthState({ state: 'abc' }, 'abc', NOW, TTL).ok).toBe(false);
    expect(ctx.validateAuthState({ state: 'abc', createdAt: 0 }, 'abc', NOW, TTL).ok).toBe(false);
  });

  it('does not spend the nonce on a state someone else presented', () => {
    // The endpoint is public and unauthenticated by necessity. Consuming the
    // nonce here would let anyone who knows the URL cancel an authorisation
    // in progress, and buys only a limit on guessing 244 bits.
    expect(ctx.validateAuthState(stored, 'wrong', NOW, TTL).consume).toBe(false);
    expect(ctx.validateAuthState(stored, '', NOW, TTL).consume).toBe(false);
    expect(ctx.validateAuthState(null, 'abc', NOW, TTL).consume).toBe(false);
  });

  it('does spend a nonce that is genuinely used up', () => {
    // Expired or corrupt is not "someone else's callback" — it is ours, and
    // it is finished. Leaving it would keep a dead record alive for its TTL.
    expect(ctx.validateAuthState(stored, 'abc', NOW + TTL + 1, TTL).consume).toBe(true);
    expect(ctx.validateAuthState({ state: 'abc' }, 'abc', NOW, TTL).consume).toBe(true);
  });
});

describe('generated state', () => {
  it('is long and does not repeat', () => {
    const c = load();
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
      const s = c.generateState_();
      expect(s.length).toBeGreaterThanOrEqual(64);
      expect(s).toMatch(/^[0-9a-f]+$/);
      seen.add(s);
    }
    expect(seen.size).toBe(200);
  });
});

describe('buildAuthPayload', () => {
  it('sends the fields /auth requires', () => {
    const payload = ctx.buildAuthPayload({
      aspspName: 'Mock ASPSP',
      country: 'FI',
      redirectUrl: 'https://script.google.com/macros/s/X/exec',
      state: 'nonce',
      validUntil: '2026-12-25T00:00:00.000Z',
      psuType: 'personal'
    });

    expect(payload).toEqual({
      access: { valid_until: '2026-12-25T00:00:00.000Z' },
      aspsp: { name: 'Mock ASPSP', country: 'FI' },
      state: 'nonce',
      redirect_url: 'https://script.google.com/macros/s/X/exec',
      psu_type: 'personal'
    });
  });

  it('computes consent validity as UTC ISO 8601', () => {
    const until = ctx.consentValidUntil(Date.parse('2026-01-01T00:00:00Z'), 180);
    expect(until).toBe('2026-06-30T00:00:00.000Z');
  });
});

describe('beginAuthorization', () => {
  it('stores the nonce before the request goes out, and sends it', () => {
    const c = connected(() => ({ code: 200, body: JSON.stringify({ url: 'https://bank.example/login' }) }));
    const result = c.beginAuthorization('Mock ASPSP', 'FI');

    expect(result.url).toBe('https://bank.example/login');

    const sent = JSON.parse(c.__fetches.at(-1).params.payload);
    const saved = JSON.parse(c.__properties.get('EB_AUTH_STATE'));
    expect(sent.state).toBe(saved.state);
    expect(sent.redirect_url).toBe('https://script.google.com/macros/s/FAKE/exec');
  });

  it('explains the missing deployment rather than failing obscurely', () => {
    const c = load({ properties: { ...CREDS } });
    c.webAppUrl_ = () => '';
    // Simulate an undeployed script by removing the service URL.
    c.ScriptApp.getService = () => ({ getUrl: () => '' });

    expect(() => c.beginAuthorization('Mock ASPSP', 'FI')).toThrow(/New deployment/);
  });
});

describe('redirect URL', () => {
  it('prefers a pinned URL over what the runtime detects', () => {
    // The detected value can name a deployment that has since been replaced,
    // which resolves to nothing and fails as a Drive error page.
    const pinned = 'https://script.google.com/macros/s/REAL/exec';
    const c = load({ properties: { EB_REDIRECT_URL: pinned } });

    expect(c.detectedWebAppUrl_()).toBe('https://script.google.com/macros/s/FAKE/exec');
    expect(c.webAppUrl_()).toBe(pinned);
  });

  it('falls back to detection when nothing is pinned', () => {
    expect(load().webAppUrl_()).toBe('https://script.google.com/macros/s/FAKE/exec');
  });

  it('uses the pinned URL as redirect_url in the auth request', () => {
    const c = load({
      properties: { ...CREDS, EB_REDIRECT_URL: 'https://script.google.com/macros/s/REAL/exec' },
      fetch: () => ({ code: 200, body: JSON.stringify({ url: 'https://bank.example' }) })
    });
    c.setup();
    c.beginAuthorization('Mock ASPSP', 'FI');

    expect(JSON.parse(c.__fetches.at(-1).params.payload).redirect_url)
      .toBe('https://script.google.com/macros/s/REAL/exec');
  });

  it('names the specific mistake rather than just refusing', () => {
    expect(ctx.validateRedirectUrl('https://script.google.com/macros/s/ABC/dev'))
      .toMatch(/test deployment/);
    expect(ctx.validateRedirectUrl('https://script.google.com/macros/s/ABC/exec/'))
      .toMatch(/trailing slash/);
    expect(ctx.validateRedirectUrl('https://example.com/callback'))
      .toMatch(/Apps Script web app URL/);
    expect(ctx.validateRedirectUrl('')).toMatch(/Paste the/);
  });

  it('accepts a well-formed /exec URL', () => {
    expect(ctx.validateRedirectUrl('https://script.google.com/macros/s/AKfycb-x_9/exec')).toBeNull();
  });

  it('refuses to pin an invalid URL', () => {
    const c = load();
    expect(() => c.saveRedirectUrl('https://example.com')).toThrow();
    expect(c.__properties.has('EB_REDIRECT_URL')).toBe(false);
  });

  it('is overwritten by pinning a different one, which is how you correct it', () => {
    // This replaced a test of `clearRedirectUrl`, which had no caller anywhere
    // in `src/` and no button in the dialog — a function whose only caller is
    // its own test is dead, and the test passing is what hid that. Correcting a
    // wrong pin was always the same gesture as setting the first one.
    const c = load({ properties: { EB_REDIRECT_URL: 'https://script.google.com/macros/s/OLD/exec' } });

    c.saveRedirectUrl('https://script.google.com/macros/s/NEW/exec');
    expect(c.webAppUrl_()).toBe('https://script.google.com/macros/s/NEW/exec');
  });
});

describe('doGet', () => {
  function startedFlow(fetch) {
    const c = connected(fetch);
    c.PropertiesService.getScriptProperties().setProperty('EB_AUTH_STATE', JSON.stringify({
      state: 'good-nonce', aspspName: 'Mock ASPSP', country: 'FI', createdAt: Date.now()
    }));
    return c;
  }

  const sessionResponse = () => ({ code: 200, body: JSON.stringify(SESSION) });

  it('completes a legitimate callback and records the connection', () => {
    const c = startedFlow(sessionResponse);
    const html = c.doGet({ parameter: { state: 'good-nonce', code: 'auth-code' } }).getContent();

    expect(html).toContain('Connected');
    expect(html).toContain('2 accounts');

    const status = c.__spreadsheet.getSheetByName('_status');
    expect(status.getRange('A2').getValue()).toBe('mock-aspsp-it');
    expect(status.getRange('C2').getValue()).toBe('sess-42');
    expect(status.getRange('B2').getValue()).toBe('Mock ASPSP');
    expect(status.getRange('I2').getValue()).toBe(2);
  });

  it('consumes the nonce, so a captured callback cannot be replayed', () => {
    const c = startedFlow(sessionResponse);
    c.doGet({ parameter: { state: 'good-nonce', code: 'auth-code' } });

    expect(c.__properties.get('EB_AUTH_STATE')).toBeUndefined();

    const replay = c.doGet({ parameter: { state: 'good-nonce', code: 'auth-code' } }).getContent();
    expect(replay).toContain('no longer valid');
  });

  it('rejects a forged state without touching the API', () => {
    const c = startedFlow(sessionResponse);
    const before = c.__fetches.length;

    const html = c.doGet({ parameter: { state: 'forged', code: 'attacker-code' } }).getContent();

    expect(html).toContain('Not connected');
    expect(c.__fetches).toHaveLength(before);
    // The key column, not getLastRow(): a formula in row 2 makes the sheet
    // report content even with no connections recorded.
    expect(c.__spreadsheet.getSheetByName('_status').getRange('A2').getValue()).toBe('');
  });

  it('keeps the nonce when the state was not ours, so a stranger cannot cancel a login', () => {
    // This endpoint is reachable by anyone. If a mismatched callback burned
    // the nonce, a single crafted request sent while you are on your bank's
    // SCA screen would end the flow, and all you would see is that the link
    // is no longer valid.
    const c = startedFlow(sessionResponse);
    c.doGet({ parameter: { state: 'forged', code: 'x' } });

    expect(JSON.parse(c.__properties.get('EB_AUTH_STATE')).state).toBe('good-nonce');

    // And the real callback still completes afterwards.
    const html = c.doGet({ parameter: { state: 'good-nonce', code: 'auth-code' } }).getContent();
    expect(html).toContain('Connected');
  });

  it('burns the nonce once it expires, rather than leaving a dead record', () => {
    const c = connected(sessionResponse);
    c.PropertiesService.getScriptProperties().setProperty('EB_AUTH_STATE', JSON.stringify({
      state: 'stale-nonce', aspspName: 'Mock ASPSP', country: 'FI', createdAt: 1
    }));

    c.doGet({ parameter: { state: 'stale-nonce', code: 'x' } });
    expect(c.__properties.get('EB_AUTH_STATE')).toBeUndefined();
  });

  it('treats a bare request as nobody\'s callback, and leaves a flow in progress alone', () => {
    // This URL is anonymous by necessity, so anyone can open it with nothing on
    // it. That must not report a connection, and must not end the one you are
    // part-way through on your bank's SCA screen.
    const c = startedFlow(sessionResponse);

    expect(c.doGet({}).getContent()).not.toContain('Connected');
    expect(c.doGet({ parameter: {} }).getContent()).not.toContain('Connected');
    expect(c.__properties.get('EB_AUTH_STATE')).toBeTruthy();
  });

  it('reports a bank-side refusal without inventing a connection', () => {
    // A refusal echoes the `state` it was given — OAuth requires it — which is
    // also what marks the request as a callback rather than someone opening
    // this URL with an `error` on it.
    const c = startedFlow(sessionResponse);
    const html = c.doGet({ parameter: { state: 'good-nonce', error: 'access_denied' } })
      .getContent();

    expect(html).toContain('Not connected');
    // The key column, not getLastRow(): a formula in row 2 makes the sheet
    // report content even with no connections recorded.
    expect(c.__spreadsheet.getSheetByName('_status').getRange('A2').getValue()).toBe('');
  });

  it('never leaks why a callback was rejected', () => {
    // A response that explained itself would be a probing oracle for anyone
    // who found the URL, and tells a legitimate user nothing useful.
    const c = startedFlow(sessionResponse);
    const html = c.doGet({ parameter: { state: 'forged', code: 'x' } }).getContent();

    expect(html).not.toContain('mismatch');
    expect(html).not.toContain('expired');
    expect(html).not.toContain('good-nonce');
  });

  it('survives the session exchange failing', () => {
    const c = startedFlow(() => ({ code: 500, body: 'gateway error' }));
    const html = c.doGet({ parameter: { state: 'good-nonce', code: 'auth-code' } }).getContent();

    expect(html).toContain('Not connected');
    expect(html).not.toContain('gateway error');
  });

  it('answers in plain text, which carries no google.script.run bridge', () => {
    // The redirect is `ANYONE_ANONYMOUS` — it has to be, the bank's redirect
    // carries no Google session. A page served from here would hand anyone who
    // knows the URL a bridge to every public function in the project; a text
    // response hands them nothing but this one.
    const c = startedFlow(sessionResponse);
    c.HtmlService = {
      createHtmlOutput: () => { throw new Error('doGet served a page'); }
    };

    const connected = c.doGet({ parameter: { state: 'good-nonce', code: 'auth-code' } });
    expect(connected.getMimeType()).toBe('TEXT');
    expect(connected.getContent()).toMatch(/^Connected\n/);

    for (const parameter of [{}, { state: 'forged', code: 'x' }, { state: 'good-nonce', error: 'no' }]) {
      expect(c.doGet({ parameter }).getMimeType()).toBe('TEXT');
    }
  });

  it('reflects the bank error as characters, however it is spelt', () => {
    // As text there is nothing to escape, so nothing is: the payload comes
    // back exactly as sent, cut to length, in a response no browser renders.
    const c = startedFlow(sessionResponse);
    const payload = '</p><script>fetch("//evil")</script>';
    const out = c.doGet({ parameter: { state: 'good-nonce', error: payload } });

    expect(out.getMimeType()).toBe('TEXT');
    expect(out.getContent()).toContain('Your bank reported: ' + payload);
    expect(out.getContent()).not.toContain('&lt;');

    const long = c.doGet({ parameter: { state: 'good-nonce', error: 'x'.repeat(500) } }).getContent();
    expect(long).toContain('x'.repeat(200));
    expect(long).not.toContain('x'.repeat(201));
  });

  it('keeps the sync deadline on a line of its own', () => {
    const c = startedFlow(sessionResponse);
    const text = c.doGet({ parameter: { state: 'good-nonce', code: 'auth-code' } }).getContent();

    expect(text.split('\n\n')).toHaveLength(3);
    expect(text).toMatch(/\n\nRun Spendsheet → Sync now within the hour/);
  });
});

describe('the bank picker dialog', () => {
  const html = () => load().bankPickerHtml_();

  it('escapes the API-supplied name and country before writing them to innerHTML', () => {
    // The names come from Enable Banking rather than from an attacker, and
    // that is not something this dialog can verify — so it escapes rather
    // than trusting a third party to keep sending well-behaved strings.
    expect(html()).toContain('esc(b.name)');
    expect(html()).toContain('esc(b.country||"")');
    // Only the innerHTML path matters — "Contacting "+b.name goes through
    // textContent, which is already inert.
    expect(html()).not.toContain('"<span>"+b.name');
  });

  it('escapes the authorisation URL and refuses one that is not https', () => {
    // Escaping keeps the URL inside the href; the scheme test is what stops
    // it being a javascript: link once it is safely in there.
    expect(html()).toContain('esc(r.url)');
    expect(html()).toContain('esc(r.aspsp)');
    expect(html()).toMatch(/\^https:/);
  });

  it('defines the escaper it calls', () => {
    // A dialog that calls esc() without defining it fails at the point a bank
    // list arrives, which is not where anyone would look.
    expect(html()).toMatch(/function esc\(/);
  });
});

