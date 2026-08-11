/**
 * Enable Banking client — request construction and error mapping.
 *
 * Network and OAuth are stubbed, so this is deliberately thin coverage: it
 * proves we build the right request and interpret the answer correctly, not
 * that the API behaves as documented. Phase 3's live calls settle that.
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

/** A context with credentials installed and a scripted API. */
function withApi(handler, env = 'SANDBOX') {
  const properties = { EB_ENV: env };
  if (env === 'SANDBOX') {
    properties.EB_SANDBOX_APP_ID = 'sandbox-app';
    properties.EB_SANDBOX_KEY = privateKey;
  } else {
    properties.EB_PROD_APP_ID = 'prod-app';
    properties.EB_PROD_KEY = privateKey;
  }
  return load({ properties, fetch: handler });
}

const ok = (body) => () => ({ code: 200, body: JSON.stringify(body) });

describe('buildQuery', () => {
  it('drops empty values instead of sending them as ""', () => {
    expect(ctx.buildQuery({ a: 1, b: null, c: undefined, d: '', e: 'x' })).toBe('?a=1&e=x');
  });

  it('returns nothing when there is nothing to send', () => {
    expect(ctx.buildQuery(null)).toBe('');
    expect(ctx.buildQuery({})).toBe('');
    expect(ctx.buildQuery({ a: null })).toBe('');
  });

  it('encodes values', () => {
    expect(ctx.buildQuery({ country: 'IT', name: 'Mock ASPSP' })).toBe('?country=IT&name=Mock%20ASPSP');
  });
});

describe('buildRequestParams', () => {
  it('sends the token as a bearer and never throws on HTTP errors', () => {
    const params = ctx.buildRequestParams('GET', 'tok');
    expect(params.method).toBe('get');
    expect(params.headers.Authorization).toBe('Bearer tok');
    // Without this, a 429 raises before we can classify it.
    expect(params.muteHttpExceptions).toBe(true);
  });

  it('omits a body and content type on a GET', () => {
    const params = ctx.buildRequestParams('GET', 'tok');
    expect(params.payload).toBeUndefined();
    expect(params.contentType).toBeUndefined();
  });

  it('serialises a payload as JSON', () => {
    const params = ctx.buildRequestParams('POST', 'tok', { code: 'abc' });
    expect(params.contentType).toBe('application/json');
    expect(JSON.parse(params.payload)).toEqual({ code: 'abc' });
  });
});

describe('classifyEbError', () => {
  it('maps status codes when the body says nothing useful', () => {
    expect(ctx.classifyEbError(401, '')).toBe('AUTH_FAILED');
    expect(ctx.classifyEbError(403, '')).toBe('FORBIDDEN');
    expect(ctx.classifyEbError(404, '')).toBe('NOT_FOUND');
    expect(ctx.classifyEbError(422, '')).toBe('INVALID_REQUEST');
    expect(ctx.classifyEbError(429, '')).toBe('ASPSP_RATE_LIMIT_EXCEEDED');
    expect(ctx.classifyEbError(500, '')).toBe('PROVIDER_ERROR');
    expect(ctx.classifyEbError(503, '')).toBe('PROVIDER_ERROR');
    expect(ctx.classifyEbError(418, '')).toBe('UNKNOWN');
  });

  it('prefers the API error code, which distinguishes what status cannot', () => {
    // An expired consent and a malformed request both arrive as 4xx, but
    // only one of them means "the user has to re-authorise".
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'EXPIRED_SESSION' }))).toBe('EXPIRED_SESSION');
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'SESSION_EXPIRED' }))).toBe('EXPIRED_SESSION');
    expect(ctx.classifyEbError(400, JSON.stringify({ error: 'session has expired' }))).toBe('EXPIRED_SESSION');
  });

  it('separates an inactive application from an unlinked account', () => {
    // Both arrive as 403 and the remedies are opposite: one is a console
    // step, the other is reconnecting the bank. Sending someone to reconnect
    // an account on an Inactive app is a loop they cannot escape.
    expect(ctx.classifyEbError(403, JSON.stringify({ message: 'Application is not active' })))
      .toBe('APP_NOT_ACTIVE');
    expect(ctx.classifyEbError(403, 'application is not active')).toBe('APP_NOT_ACTIVE');
    expect(ctx.classifyEbError(403, JSON.stringify({ code: 'APP_NOT_ACTIVE' }))).toBe('APP_NOT_ACTIVE');
    expect(ctx.classifyEbError(403, JSON.stringify({ message: 'account not linked' }))).toBe('FORBIDDEN');
  });

  it('tells you where to go for an inactive application', () => {
    // The guidance names the console button, because the failure happens on
    // /aspsps — before any account exists to be at fault.
    expect(ctx.describeEbError('APP_NOT_ACTIVE')).toMatch(/Activate by linking accounts/);
  });

  it('recognises a rate limit however it is spelled', () => {
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'ASPSP_RATE_LIMIT_EXCEEDED' })))
      .toBe('ASPSP_RATE_LIMIT_EXCEEDED');
    expect(ctx.classifyEbError(400, JSON.stringify({ code: 'TOO-MANY-REQUESTS' })))
      .toBe('ASPSP_RATE_LIMIT_EXCEEDED');
  });

  it('falls back to the status when the body is not JSON', () => {
    expect(ctx.classifyEbError(500, '<html>gateway timeout</html>')).toBe('PROVIDER_ERROR');
  });
});

describe('extractErrorDetail', () => {
  it('surfaces the API message, which knows more than our generic text does', () => {
    expect(ctx.extractErrorDetail(JSON.stringify({ message: 'redirect_url is not registered' })))
      .toBe('redirect_url is not registered');
    expect(ctx.extractErrorDetail(JSON.stringify({ detail: 'valid_until exceeds maximum' })))
      .toBe('valid_until exceeds maximum');
    expect(ctx.extractErrorDetail(JSON.stringify({ error_description: 'bad psu_type' })))
      .toBe('bad psu_type');
  });

  it('flattens a field-by-field validation list', () => {
    const body = JSON.stringify({
      detail: [
        { loc: ['body', 'access', 'valid_until'], msg: 'too far in the future' },
        { loc: ['body', 'psu_type'], msg: 'unexpected value' }
      ]
    });
    expect(ctx.extractErrorDetail(body))
      .toBe('body.access.valid_until: too far in the future; body.psu_type: unexpected value');
  });

  it('falls back to the whole body rather than losing it', () => {
    expect(ctx.extractErrorDetail(JSON.stringify({ weird: 'shape' }))).toBe('{"weird":"shape"}');
  });

  it('passes through short plain text, and drops a whole HTML page', () => {
    expect(ctx.extractErrorDetail('gateway timeout')).toBe('gateway timeout');
    expect(ctx.extractErrorDetail('<html>' + 'x'.repeat(500) + '</html>')).toBe('');
  });

  it('truncates rather than pasting an essay into a dialog', () => {
    const detail = ctx.extractErrorDetail(JSON.stringify({ message: 'y'.repeat(500) }));
    expect(detail).toHaveLength(301);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('handles an empty body', () => {
    expect(ctx.extractErrorDetail('')).toBe('');
    expect(ctx.extractErrorDetail(null)).toBe('');
  });
});

describe('thrown errors carry the API explanation', () => {
  it('includes what the server said about a 400', () => {
    const c = withApi(() => ({
      code: 400,
      body: JSON.stringify({ message: 'redirect_url not registered for this application' })
    }));

    expect(() => c.ebListAspsps_()).toThrow(/redirect_url not registered/);
  });
});

describe('error objects', () => {
  it('marks server errors retryable but never the rate limit', () => {
    // A 429 carries a multi-hour penalty; retrying in-loop burns the window
    // and achieves nothing, so it waits for the next scheduled run.
    expect(ctx.ebError('PROVIDER_ERROR', 'x').retryable).toBe(true);
    expect(ctx.ebError('ASPSP_RATE_LIMIT_EXCEEDED', 'x').retryable).toBe(false);
    expect(ctx.ebError('EXPIRED_SESSION', 'x').retryable).toBe(false);
  });

  it('keeps the raw body for _anomalies', () => {
    const e = ctx.ebError('UNKNOWN', 'x', 500, '{"weird":true}');
    expect(e.status).toBe(500);
    expect(e.body).toBe('{"weird":true}');
  });

  it('explains every code it can raise', () => {
    for (const code of Object.values(ctx.EB_ERROR)) {
      expect(ctx.describeEbError(code)).not.toBe('Unrecognised error.');
    }
  });
});

describe('credentials', () => {
  it('defaults to sandbox rather than production', () => {
    expect(load().ebEnvironment()).toBe('SANDBOX');
  });

  it('selects the key pair matching EB_ENV', () => {
    const sandbox = withApi(ok({}), 'SANDBOX');
    sandbox.ebGetApplication_();
    expect(sandbox.decodeJwtPayload(sandbox.__fetches[0].params.headers.Authorization.slice(7)));

    const prod = withApi(ok({}), 'PRODUCTION');
    prod.ebGetApplication_();

    // kid is the application ID, and kid is what picks the environment.
    const kidOf = (c) => JSON.parse(
      Buffer.from(c.__fetches[0].params.headers.Authorization.slice(7).split('.')[0], 'base64url').toString()
    ).kid;

    expect(kidOf(sandbox)).toBe('sandbox-app');
    expect(kidOf(prod)).toBe('prod-app');
  });

  it('fails with a usable message when nothing is installed', () => {
    expect(() => load().ebGetApplication_()).toThrow(/installCredentials/);
  });
});

describe('validatePrivateKey', () => {
  it('accepts a real PEM', () => {
    expect(ctx.validatePrivateKey(privateKey)).toBeNull();
  });

  it('catches the mistakes people actually make', () => {
    expect(ctx.validatePrivateKey('')).toMatch(/Paste the contents/);
    expect(ctx.validatePrivateKey('   ')).toMatch(/Paste the contents/);
    expect(ctx.validatePrivateKey('abc123')).toMatch(/-----BEGIN/);
    expect(ctx.validatePrivateKey('-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----'))
      .toMatch(/public key/);
    expect(ctx.validatePrivateKey('-----BEGIN PRIVATE KEY-----\nMIIE'))
      .toMatch(/truncated/);
  });
});

describe('saveCredentials', () => {
  it('stores under the prefix for the chosen environment and leaves the other alone', () => {
    const c = load({ properties: { EB_SANDBOX_APP_ID: 'keep-me', EB_SANDBOX_KEY: privateKey } });
    c.saveCredentials('PRODUCTION', 'prod-1', privateKey);

    expect(c.__properties.get('EB_ENV')).toBe('PRODUCTION');
    expect(c.__properties.get('EB_PROD_APP_ID')).toBe('prod-1');
    expect(c.__properties.get('EB_SANDBOX_APP_ID')).toBe('keep-me');
  });

  it('rejects bad input before it reaches Script Properties', () => {
    const c = load();
    expect(() => c.saveCredentials('SANDBOX', '', privateKey)).toThrow();
    expect(() => c.saveCredentials('SANDBOX', 'id', 'not a key')).toThrow();
    expect(() => c.saveCredentials('STAGING', 'id', privateKey)).toThrow(/SANDBOX or PRODUCTION/);
    expect(c.__properties.size).toBe(0);
  });
});

describe('the credentials dialog', () => {
  it('escapes the pinned URL rather than trusting the validator that stored it', () => {
    // validateRedirectUrl gates what can be pinned, so this cannot fire
    // today. It is escaped because the guard and the render are far enough
    // apart that relaxing one would not obviously break the other.
    const c = load({ properties: { EB_REDIRECT_URL: '"><img src=x onerror=alert(1)>' } });
    const html = c.credentialsFormHtml_();

    expect(html).not.toContain('<img');
    expect(html).toContain('&quot;&gt;&lt;img');
  });

  it('escapes the URL the runtime guessed', () => {
    const c = load();
    c.ScriptApp.getService = () => ({ getUrl: () => '</code><script>alert(1)</script>' });
    const html = c.credentialsFormHtml_();

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;/code&gt;&lt;script&gt;');
  });

  it('still renders the pinned URL as something you can read and compare', () => {
    // The whole point of showing it is comparing it by eye against what is
    // registered with Enable Banking — escaping must not mangle a real one.
    const url = 'https://script.google.com/macros/s/AKfycb-x_9/exec';
    const html = load({ properties: { EB_REDIRECT_URL: url } }).credentialsFormHtml_();

    expect(html).toContain('value="' + url + '"');
  });
});

describe('endpoints', () => {
  it('lists banks, filtered by country', () => {
    const c = withApi(ok({ aspsps: [{ name: 'Mock ASPSP', country: 'FI' }] }));
    const banks = c.ebListAspsps_('IT');

    expect(banks).toHaveLength(1);
    expect(c.__fetches[0].url).toBe('https://api.enablebanking.com/aspsps?country=IT');
  });

  it('returns an empty list rather than undefined when there are no banks', () => {
    expect(withApi(ok({})).ebListAspsps_()).toEqual([]);
  });

  it('escapes path parameters', () => {
    const c = withApi(ok({ balances: [] }));
    c.ebGetAccountBalances_('acc/../secret');
    expect(c.__fetches[0].url).toContain('acc%2F..%2Fsecret');
  });

  it('passes the backfill strategy through', () => {
    // Full history is reachable only for ~1h after authorisation; missing
    // this on the first run costs a re-consent.
    const c = withApi(ok({ transactions: [] }));
    c.ebGetTransactionsPage_('acc-1', { strategy: 'longest', dateFrom: '2024-01-01' });

    expect(c.__fetches[0].url).toContain('date_from=2024-01-01');
    expect(c.__fetches[0].url).toContain('strategy=longest');
  });

  it('raises a typed error the caller can switch on', () => {
    const c = withApi(() => ({ code: 429, body: JSON.stringify({ code: 'ASPSP_RATE_LIMIT_EXCEEDED' }) }));
    try {
      c.ebListAspsps_();
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('ASPSP_RATE_LIMIT_EXCEEDED');
      expect(e.retryable).toBe(false);
      expect(e.status).toBe(429);
    }
  });
});

describe('ebGetAllTransactions_', () => {
  it('follows continuation keys and concatenates pages', () => {
    let call = 0;
    const c = withApi(() => {
      call++;
      return call < 3
        ? { code: 200, body: JSON.stringify({ transactions: [{ n: call }], continuation_key: `k${call}` }) }
        : { code: 200, body: JSON.stringify({ transactions: [{ n: call }] }) };
    });

    const result = c.ebGetAllTransactions_('acc-1');

    expect(result.transactions).toHaveLength(3);
    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(false);
    expect(c.__fetches[1].url).toContain('continuation_key=k1');
  });

  it('reports truncation instead of pretending it fetched everything', () => {
    // A silent cap reads as complete data, which is exactly the kind of
    // quiet wrongness this project is built to avoid.
    const c = withApi(() => ({
      code: 200,
      body: JSON.stringify({ transactions: [{}], continuation_key: 'always-more' })
    }));

    const result = c.ebGetAllTransactions_('acc-1', { maxPages: 3 });

    expect(result.pages).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.continuationKey).toBe('always-more');
  });

  it('handles an account with no transactions', () => {
    const result = withApi(ok({ transactions: [] })).ebGetAllTransactions_('acc-1');
    expect(result.transactions).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});
